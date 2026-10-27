#!/usr/bin/env node
/**
 * Stand-in for `uv run export_onnx.py …` in app-model install tests (all platforms).
 * argv: run <script> <source> --name <name> --out <out> --job-id <id>
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAbsolute } from 'node:path';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args[0] !== 'run') process.exit(2);
  args.shift();
  args.shift(); // script path
  const source = args.shift();
  let name;
  let out;
  let jobId;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--name') name = args.shift();
    else if (flag === '--out') out = args.shift();
    else if (flag === '--job-id') jobId = args.shift();
  }
  if (!source || !name || !out || !jobId) process.exit(2);
  return { source, name, out, jobId };
}

function writeModelTree(partial, source, name, jobId, revision) {
  mkdirSync(join(partial, 'tokenizer'), { recursive: true });
  for (const f of [
    'decoder.onnx',
    'vision.onnx',
    'tokenizer/tokenizer.json',
    'tokenizer/tokenizer_config.json',
  ]) {
    writeFileSync(join(partial, f), 'x');
  }
  writeFileSync(
    join(partial, 'model.json'),
    JSON.stringify({
      source,
      revision,
      vision: name,
      job_id: jobId,
    }),
  );
}

function finishInstall(partial, out, name) {
  const dest = join(out, name);
  rmSync(dest, { recursive: true, force: true });
  renameSync(partial, dest);
}

async function main() {
  const { source, name, out, jobId } = parseArgs(process.argv);
  const partial = join(out, `.install-${name}`);

  if (source.includes('not-supported')) {
    console.log(`step: looking up ${source}`);
    console.error(
      `error: unsupported_architecture: ${source} is not a model this app converts: it has no vlm_agent_config.json`,
    );
    rmSync(partial, { recursive: true, force: true });
    process.exit(2);
  }
  if (source.includes('/parity') || source.endsWith('parity')) {
    console.error(
      'error: parity: decoder: the ONNX graph differs from PyTorch by 2.00e-02, above 0.001',
    );
    process.exit(2);
  }
  if (source.includes('/crash') || source.endsWith('crash')) {
    console.error('Traceback (most recent call last):');
    console.error('RuntimeError: out of memory');
    process.exit(1);
  }
  if (source.includes('/slow') || source.endsWith('slow')) {
    const cleanup = () => {
      rmSync(partial, { recursive: true, force: true });
      process.exit(143);
    };
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
    console.log('step: exporting the decoder graph');
    writeFileSync(join(out, '.slow-started'), '');
    while (true) await sleep(50);
  }
  if (source.includes('prep-check')) {
    await sleep(400);
    console.log('step: loading the model');
    mkdirSync(partial, { recursive: true });
    writeModelTree(partial, source, name, jobId, null);
    finishInstall(partial, out, name);
    process.exit(0);
  }
  if (source.includes('env-check')) {
    console.error(`meta: cwd=${process.cwd()}`);
    console.error(`meta: UV_CACHE_DIR=${process.env.UV_CACHE_DIR ?? ''}`);
    console.error(`meta: UV_PYTHON_INSTALL_DIR=${process.env.UV_PYTHON_INSTALL_DIR ?? ''}`);
    console.log('step: loading the model');
    mkdirSync(partial, { recursive: true });
    writeModelTree(partial, source, name, jobId, null);
    finishInstall(partial, out, name);
    process.exit(0);
  }
  if (source.includes('offline')) {
    console.error('error: Failed to download distribution `torch==2.14.0`');
    console.error('  Caused by: failed to fetch https://download.pytorch.org/whl/cpu/torch/');
    process.exit(1);
  }

  console.log('step: loading the model');
  mkdirSync(partial, { recursive: true });
  const revision = isAbsolute(source) ? null : 'abc1234';
  writeModelTree(partial, source, name, jobId, revision);
  finishInstall(partial, out, name);
  console.log(`done: ${name} in ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
