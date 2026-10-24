/**
 * Copy compiled backend + production node_modules into backend-pack/ for extraResources.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPIKE_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(SPIKE_ROOT, '..', '..');
const BACKEND = join(REPO_ROOT, 'apps', 'visualizer', 'backend');
const OUT = join(SPIKE_ROOT, 'backend-pack');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    process.stderr.write(`prepare-backend: ${cmd} ${args.join(' ')} failed\n`);
    process.exit(r.status ?? 1);
  }
}

if (!existsSync(join(BACKEND, 'package.json'))) {
  process.stderr.write(`Backend not found at ${BACKEND}\n`);
  process.exit(1);
}

run('npm', ['ci'], { cwd: BACKEND, env: { ...process.env, npm_config_audit: 'false' } });
run('npm', ['run', 'build'], { cwd: BACKEND });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

cpSync(join(BACKEND, 'dist'), join(OUT, 'dist'), { recursive: true });
cpSync(join(BACKEND, 'node_modules'), join(OUT, 'node_modules'), { recursive: true });
cpSync(join(BACKEND, 'package.json'), join(OUT, 'package.json'));

const fixtures = join(SPIKE_ROOT, 'fixtures');
if (existsSync(join(fixtures, 'tiny.onnx'))) {
  mkdirSync(join(OUT, 'fixtures'), { recursive: true });
  cpSync(join(fixtures, 'tiny.onnx'), join(OUT, 'fixtures', 'tiny.onnx'));
}

const example = readFileSync(join(BACKEND, 'providers.example.json'), 'utf8');
writeFileSync(join(OUT, 'providers.json'), example);

for (const name of ['native-smoke.mjs', 'spike-entry.mjs']) {
  cpSync(join(SPIKE_ROOT, name), join(OUT, name));
}

process.stdout.write(`prepare-backend: wrote ${OUT}\n`);
