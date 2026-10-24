/**
 * Minimal Electron 45 shell: spawn real backend in a separate Node process, poll /api/status, exit.
 */
import { app, utilityProcess } from 'electron';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADLESS = process.env.SPIKE_HEADLESS === '1' || !process.stdout.isTTY;
const SPAWN_PREF = process.env.SPIKE_SPAWN_MODE ?? 'electron-run-as-node';

function backendResourcesPath() {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'backend');
  }
  return join(fileURLToPath(new URL('.', import.meta.url)), 'backend-pack');
}

function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('no port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function waitForHttp(url, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          resolve(await res.json());
          return;
        }
      } catch {
        /* retry */
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timeout waiting for ${url}`));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

function writeMinimalConfig(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), 'workers: 1\napp_models_dir: fixtures\n', 'utf8');
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} backendRoot
 * @param {string} entryScript
 */
function spawnRunAsNode(env, backendRoot, entryScript) {
  const childEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
  const child = spawn(process.execPath, [entryScript], {
    env: childEnv,
    cwd: backendRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => process.stderr.write(`[backend] ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[backend] ${d}`));
  return { child, mode: 'electron-run-as-node' };
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} backendRoot
 * @param {string} entryScript
 */
function spawnUtilityProcess(env, backendRoot, entryScript) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const up = utilityProcess.fork(entryScript, [], {
      env,
      cwd: backendRoot,
      serviceName: 'lt-backend-spike',
    });
    up.on('spawn', () => {
      if (!settled) {
        settled = true;
        resolve({ child: up, mode: 'utility-process' });
      }
    });
    up.stderr?.on('data', (d) => process.stderr.write(`[utility] ${d}`));
    up.stdout?.on('data', (d) => process.stderr.write(`[utility] ${d}`));
    up.on('exit', (code) => {
      if (!settled && code !== 0) {
        settled = true;
        reject(new Error(`utilityProcess exited before spawn: ${code}`));
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('utilityProcess spawn timeout'));
      }
    }, 15_000);
  });
}

/** @param {import('node:child_process').ChildProcess | import('electron').UtilityProcess} handle */
function killChild(handle) {
  if ('kill' in handle && typeof handle.kill === 'function') {
    handle.kill();
    return;
  }
  if ('pid' in handle && handle.pid) {
    try {
      process.kill(handle.pid, 'SIGTERM');
    } catch {
      /* gone */
    }
  }
}

async function runSpike() {
  const backendRoot = backendResourcesPath();
  const dataDir = mkdtempSync(join(tmpdir(), 'lt-spike-data-'));
  writeMinimalConfig(dataDir);

  const port = await pickPort();
  const resultPath = join(dataDir, 'spike-result.json');

  const env = {
    ...process.env,
    FLASK_HOST: '127.0.0.1',
    FLASK_PORT: String(port),
    SPIKE_DATA_DIR: dataDir,
    SPIKE_RESULT_PATH: resultPath,
    DATABASE_PATH: join(dataDir, 'visualizer.db'),
    LIBRARY_DB: join(dataDir, 'library.db'),
    LT_CONFIG_YAML: join(dataDir, 'config.yaml'),
    LT_PROVIDERS_JSON: join(backendRoot, 'providers.json'),
    THUMBNAIL_DIR: join(dataDir, 'thumbnails'),
  };

  const entryScript = join(backendRoot, 'spike-entry.mjs');

  /** @type {{ child: import('node:child_process').ChildProcess | import('electron').UtilityProcess; mode: string }} */
  let spawned;
  /** @type {string | null} */
  let utilityProcessNote = null;

  if (SPAWN_PREF === 'utility-process' || SPAWN_PREF === 'try-both') {
    try {
      spawned = await spawnUtilityProcess(env, backendRoot, entryScript);
    } catch (e) {
      utilityProcessNote = e instanceof Error ? e.message : String(e);
      if (SPAWN_PREF === 'utility-process') {
        throw e;
      }
      spawned = spawnRunAsNode(env, backendRoot, entryScript);
    }
  } else {
    spawned = spawnRunAsNode(env, backendRoot, entryScript);
  }

  const statusUrl = `http://127.0.0.1:${port}/api/status`;
  let statusBody;
  try {
    statusBody = await waitForHttp(statusUrl, 120_000);
  } catch (e) {
    killChild(spawned.child);
    throw e;
  }

  let smokeOnDisk = {};
  try {
    smokeOnDisk = JSON.parse(readFileSync(resultPath, 'utf8'));
  } catch {
    smokeOnDisk = { warning: 'no spike-result.json from child' };
  }

  const nativeOk = smokeOnDisk.ok === true;
  const result = {
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    electron: process.versions.electron,
    node: process.versions.node,
    spawnMode: spawned.mode,
    utilityProcessNote,
    backendRoot,
    dataDir,
    port,
    httpStatus: statusBody,
    nativeSmoke: smokeOnDisk,
    ok: statusBody?.status === 'ok' && nativeOk,
  };

  const outPath = process.env.SPIKE_OUTPUT_JSON ?? join(dataDir, 'final-spike-result.json');
  writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
  process.stderr.write(`SPIKE_RESULT_JSON=${outPath}\n`);
  process.stderr.write(JSON.stringify(result, null, 2) + '\n');

  killChild(spawned.child);
  app.exit(result.ok ? 0 : 1);
}

app.whenReady().then(async () => {
  try {
    await runSpike();
  } catch (e) {
    process.stderr.write(`spike failed: ${e instanceof Error ? e.stack : String(e)}\n`);
    app.exit(1);
  }
});

app.on('window-all-closed', () => {
  /* headless */
});
