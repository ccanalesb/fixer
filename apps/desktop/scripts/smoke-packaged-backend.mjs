#!/usr/bin/env node
/**
 * Exercise native addons in a pruned staged backend tree (CI smoke).
 *
 * Usage:
 *   smoke-packaged-backend.mjs --node <node-bin> --backend <staged-backend-root> [--fixture-dir <dir>]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function usage() {
  console.error(
    'Usage: smoke-packaged-backend.mjs --node <node> --backend <dir> [--fixture-dir <dir>]',
  );
  process.exit(2);
}

function parseArgs(argv) {
  let nodeBin;
  let backendRoot;
  let fixtureDir;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--node') nodeBin = argv[++i];
    else if (a === '--backend') backendRoot = argv[++i];
    else if (a === '--fixture-dir') fixtureDir = argv[++i];
    else if (a === '-h' || a === '--help') usage();
    else {
      console.error(`Unknown argument: ${a}`);
      usage();
    }
  }
  if (!nodeBin || !backendRoot) usage();
  backendRoot = resolve(backendRoot);
  if (!fixtureDir) {
    fixtureDir = resolve(here, '../../visualizer/backend/tests/fixtures');
  } else {
    fixtureDir = resolve(fixtureDir);
  }
  return { nodeBin: resolve(nodeBin), backendRoot, fixtureDir };
}

const runnerSource = `
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const backendRoot = process.env.SMOKE_BACKEND_ROOT;
const fixtureDir = process.env.SMOKE_FIXTURE_DIR;
const require = createRequire(join(backendRoot, 'package.json'));

async function main() {
  const sharp = require('sharp');
  const tmp = mkdtempSync(join(tmpdir(), 'fixer-smoke-'));
  const png = join(tmp, 'in.png');
  await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toFile(png);
  const out = join(tmp, 'out.png');
  await sharp(png).resize(4, 4).toFile(out);
  if (!existsSync(out)) throw new Error('sharp resize failed');

  const Database = require('better-sqlite3');
  const sqliteVec = require('sqlite-vec');
  const dbPath = join(tmp, 'vec.db');
  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.exec('CREATE VIRTUAL TABLE v USING vec0(embedding float[2])');
  const blob = Buffer.from(new Float32Array([1, 0]).buffer);
  db.prepare('INSERT INTO v(embedding) VALUES (?)').run(blob);
  const row = db.prepare('SELECT embedding FROM v LIMIT 1').get();
  if (!row) throw new Error('sqlite-vec query failed');
  db.close();

  const ort = require('onnxruntime-node');
  const modelPath = join(fixtureDir, 'tiny-identity.onnx');
  if (!existsSync(modelPath)) throw new Error('missing tiny-identity.onnx fixture');
  const session = await ort.InferenceSession.create(modelPath);
  const input = new ort.Tensor('float32', new Float32Array([42]), [1, 1]);
  const results = await session.run({ X: input });
  const y = results.Y?.data;
  if (!y || y[0] !== 42) throw new Error('onnxruntime inference failed');

  const transformersUrl = pathToFileURL(
    join(backendRoot, 'node_modules/@huggingface/transformers/dist/transformers.node.mjs'),
  ).href;
  const { env } = await import(transformersUrl);
  env.allowRemoteModels = false;

  rmSync(tmp, { recursive: true, force: true });
  console.log('smoke ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;

function main() {
  const { nodeBin, backendRoot, fixtureDir } = parseArgs(process.argv.slice(2));
  if (!existsSync(nodeBin)) {
    console.error(`Node binary not found: ${nodeBin}`);
    process.exit(1);
  }
  if (!existsSync(join(backendRoot, 'node_modules'))) {
    console.error(`No node_modules in ${backendRoot}`);
    process.exit(1);
  }

  const runnerDir = mkdtempSync(join(tmpdir(), 'fixer-smoke-runner-'));
  const runnerPath = join(runnerDir, 'run.mjs');
  writeFileSync(runnerPath, runnerSource);

  const result = spawnSync(nodeBin, [runnerPath], {
    cwd: backendRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      SMOKE_BACKEND_ROOT: backendRoot,
      SMOKE_FIXTURE_DIR: fixtureDir,
    },
  });
  rmSync(runnerDir, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}

main();
