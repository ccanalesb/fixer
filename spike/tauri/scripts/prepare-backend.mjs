/**
 * Copy compiled backend + production node_modules + production SPA into backend-pack/.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPIKE_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(SPIKE_ROOT, '..', '..');
const BACKEND = join(REPO_ROOT, 'apps', 'visualizer', 'backend');
const FRONTEND = join(REPO_ROOT, 'apps', 'visualizer', 'frontend');
const ELECTRON_SPIKE = join(REPO_ROOT, 'spike', 'electron');
const OUT = join(SPIKE_ROOT, 'backend-pack');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
  if (r.status !== 0) {
    process.stderr.write(`prepare-backend: ${cmd} ${args.join(' ')} failed (status ${r.status})\n`);
    if (r.error) process.stderr.write(String(r.error) + '\n');
    process.exit(r.status ?? 1);
  }
}

if (!existsSync(join(BACKEND, 'package.json'))) {
  process.stderr.write(`Backend not found at ${BACKEND}\n`);
  process.exit(1);
}

run('npm', ['ci'], { cwd: BACKEND, env: { ...process.env, npm_config_audit: 'false' } });
run('npm', ['run', 'build'], { cwd: BACKEND });

run('npm', ['ci', '--legacy-peer-deps'], {
  cwd: FRONTEND,
  env: { ...process.env, npm_config_audit: 'false' },
});
run('npm', ['run', 'build'], {
  cwd: FRONTEND,
  env: {
    ...process.env,
    VITE_WS_URL: '',
  },
});

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

cpSync(join(BACKEND, 'dist'), join(OUT, 'dist'), { recursive: true });
cpSync(join(BACKEND, 'node_modules'), join(OUT, 'node_modules'), { recursive: true });
cpSync(join(BACKEND, 'package.json'), join(OUT, 'package.json'));

const frontendDist = join(OUT, 'frontend-dist');
cpSync(join(FRONTEND, 'dist'), frontendDist, { recursive: true });

const indexHtmlPath = join(frontendDist, 'index.html');
let indexHtml = readFileSync(indexHtmlPath, 'utf8');
const bridge = readFileSync(join(SPIKE_ROOT, 'catalog-bridge-snippet.html'), 'utf8');
if (!indexHtml.includes('pick_catalog_path')) {
  indexHtml = indexHtml.replace('</body>', `${bridge}\n</body>`);
}
indexHtml = indexHtml.replace(/\s+crossorigin/g, '');
writeFileSync(indexHtmlPath, indexHtml, 'utf8');

mkdirSync(join(OUT, 'fixtures'), { recursive: true });
const fixtures = join(ELECTRON_SPIKE, 'fixtures');
if (existsSync(join(fixtures, 'tiny.onnx'))) {
  cpSync(join(fixtures, 'tiny.onnx'), join(OUT, 'fixtures', 'tiny.onnx'));
}
const factoryQuestions = join(BACKEND, 'src', 'app-models', 'factory-questions.json');
if (existsSync(factoryQuestions)) {
  cpSync(factoryQuestions, join(OUT, 'fixtures', 'factory-questions.json'));
}

const example = readFileSync(join(BACKEND, 'providers.example.json'), 'utf8');
writeFileSync(join(OUT, 'providers.json'), example);

for (const name of ['native-smoke.mjs']) {
  cpSync(join(ELECTRON_SPIKE, name), join(OUT, name));
}

for (const name of [
  'spike-entry.mjs',
  'spike-server.mjs',
  'systemone-smoke.mjs',
  'run-systemone-smoke.mjs',
]) {
  cpSync(join(SPIKE_ROOT, name), join(OUT, name));
}

process.stdout.write(`prepare-backend: wrote ${OUT} (frontend-dist + backend)\n`);
