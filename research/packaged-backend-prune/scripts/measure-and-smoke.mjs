/**
 * Measure backend `node_modules`, apply prune rules, run native + transformers + HTTP smoke.
 */
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostPackTarget, pruneBackendTree } from './prune-backend.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESEARCH_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(RESEARCH_ROOT, '..', '..');
const BACKEND = join(REPO_ROOT, 'apps', 'visualizer', 'backend');

function duBytesDir(p) {
  if (!existsSync(p)) return 0;
  let total = 0;
  for (const ent of readdirSync(p, { withFileTypes: true })) {
    const child = join(p, ent.name);
    total += ent.isDirectory() ? duBytesDir(child) : statSync(child).size;
  }
  return total;
}

function duMebibytes(p) {
  return Math.round((duBytesDir(p) / (1024 * 1024)) * 10) / 10;
}

function topLevelPackageSizes(nodeModulesDir, limit = 30) {
  if (!existsSync(nodeModulesDir)) return [];
  const rows = [];
  for (const name of readdirSync(nodeModulesDir)) {
    if (name.startsWith('.')) continue;
    const p = join(nodeModulesDir, name);
    if (name.startsWith('@')) {
      for (const scoped of readdirSync(p)) {
        rows.push({
          name: `${name}/${scoped}`,
          mib: duMebibytes(join(p, scoped)),
        });
      }
    } else {
      rows.push({ name, mib: duMebibytes(p) });
    }
  }
  rows.sort((a, b) => b.mib - a.mib);
  return rows.slice(0, limit);
}

async function runNativeSmoke(backendRoot) {
  const entry = join(RESEARCH_ROOT, 'scripts', 'native-smoke.mjs');
  const onnxPath = join(RESEARCH_ROOT, 'fixtures', 'tiny.onnx');
  const mod = await import(pathToFileURL(entry).href);
  return mod.runNativeSmoke({ backendRoot, onnxPath });
}

function runTransformersSmoke(backendRoot) {
  return new Promise((resolvePromise) => {
    const template = join(RESEARCH_ROOT, 'scripts', 'transformers-smoke-entry.mjs');
    const entry = join(backendRoot, '.research-transformers-smoke.mjs');
    copyFileSync(template, entry);
    const child = spawn(process.execPath, [entry], {
      cwd: backendRoot,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout?.on('data', (c) => {
      out += c.toString();
    });
    child.stderr?.on('data', (c) => {
      err += c.toString();
    });
    child.on('close', (code) => {
      rmSync(entry, { force: true });
      try {
        const parsed = JSON.parse(out.trim() || '{}');
        if (code !== 0 && !parsed.error) {
          parsed.ok = false;
          parsed.error = err.trim() || `exit ${code}`;
        }
        if (err.trim()) parsed.stderr = err.trim().slice(-2000);
        resolvePromise(parsed);
      } catch {
        resolvePromise({
          ok: false,
          error: err.trim() || out.trim() || `transformers smoke exit ${code}`,
        });
      }
    });
  });
}

function runHttpStatusSmoke(backendRoot) {
  return new Promise((resolvePromise) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'lt-backend-smoke-'));
    const configYaml = join(dataDir, 'config.yaml');
    writeFileSync(configYaml, 'paths: {}\n');
    const providers = join(dataDir, 'providers.json');
    copyFileSync(join(BACKEND, 'providers.example.json'), providers);
    const libraryDb = join(dataDir, 'library.db');
    writeFileSync(libraryDb, '');
    const visualizerDb = join(dataDir, 'visualizer.db');
    writeFileSync(visualizerDb, '');

    const port = 40000 + Math.floor(Math.random() * 20000);
    const serverPath = join(backendRoot, 'dist', 'src', 'server.js');
    const child = spawn(process.execPath, [serverPath], {
      cwd: backendRoot,
      env: {
        ...process.env,
        FLASK_HOST: '127.0.0.1',
        FLASK_PORT: String(port),
        FLASK_DEBUG: 'false',
        DATABASE_PATH: visualizerDb,
        LIBRARY_DB: libraryDb,
        LT_CONFIG_YAML: configYaml,
        LT_PROVIDERS_JSON: providers,
        THUMBNAIL_DIR: join(dataDir, 'thumbs'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    mkdirSync(join(dataDir, 'thumbs'), { recursive: true });

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: 'timeout waiting for /api/status' });
    }, 120_000);

    const poll = async () => {
      if (settled) return;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/status`);
        if (res.ok) {
          finish({ ok: true, status: res.status });
          return;
        }
      } catch {
        /* not up yet */
      }
      setTimeout(poll, 300);
    };
    setTimeout(poll, 400);

    child.on('exit', (code) => {
      if (!settled) {
        finish({ ok: false, error: `server exited early (code ${code})` });
      }
    });
  });
}

async function main() {
  const mode = process.argv[2] ?? 'full';
  const nm = join(BACKEND, 'node_modules');
  const report = {
    host: `${process.platform}/${process.arch}`,
    target: hostPackTarget(),
    backend: BACKEND,
    measures: {},
  };

  report.measures.node_modules_mib = duMebibytes(nm);
  report.measures.dist_mib = duMebibytes(join(BACKEND, 'dist'));
  report.measures.production_tree_mib =
    report.measures.node_modules_mib + report.measures.dist_mib;
  report.topPackages = topLevelPackageSizes(nm);

  if (mode === 'measure-only') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const nativeBefore = await runNativeSmoke(BACKEND);
  report.smokeBeforePrune = { native: nativeBefore };

  if (mode === 'smoke-unpruned') {
    const tf = await runTransformersSmoke(BACKEND);
    const http = await runHttpStatusSmoke(BACKEND);
    report.smokeBeforePrune.transformers = tf;
    report.smokeBeforePrune.http = http;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!nativeBefore.ok || !tf.ok || !http.ok) process.exit(1);
    return;
  }

  const prune = pruneBackendTree(BACKEND);
  report.prune = {
    ...prune,
    removed_mib: Math.round((prune.removedBytes / (1024 * 1024)) * 10) / 10,
  };
  report.measures.after_prune_node_modules_mib = duMebibytes(nm);
  report.measures.after_prune_production_tree_mib =
    report.measures.after_prune_node_modules_mib + report.measures.dist_mib;

  const nativeAfter = await runNativeSmoke(BACKEND);
  const tfAfter = await runTransformersSmoke(BACKEND);
  const httpAfter = await runHttpStatusSmoke(BACKEND);
  report.smokeAfterPrune = { native: nativeAfter, transformers: tfAfter, http: httpAfter };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  const ok = nativeAfter.ok && tfAfter.ok && httpAfter.ok && nativeBefore.ok;
  if (!ok) process.exit(1);
}

main().catch((e) => {
  process.stderr.write(String(e) + '\n');
  process.exit(1);
});
