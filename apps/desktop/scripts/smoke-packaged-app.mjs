#!/usr/bin/env node
/**
 * Launch a built Tauri host, wait for /api/health, quit, assert the Node sidecar exited.
 *
 * Usage:
 *   smoke-packaged-app.mjs --host <host-binary> [--port <n>] [--timeout-ms <n>]
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === 'win32';

function usage() {
  console.error('Usage: smoke-packaged-app.mjs --host <binary> [--port <n>] [--timeout-ms <n>]');
  process.exit(2);
}

function parseArgs(argv) {
  let host;
  let port;
  let timeoutMs = 90_000;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') host = argv[++i];
    else if (a === '--port') port = Number(argv[++i]);
    else if (a === '--timeout-ms') timeoutMs = Number(argv[++i]);
    else if (a === '-h' || a === '--help') usage();
    else {
      console.error(`Unknown argument: ${a}`);
      usage();
    }
  }
  return { host: host ? resolve(host) : null, port, timeoutMs };
}

function pickFreePort(preferred) {
  if (preferred && preferred > 0) return Promise.resolve(preferred);
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolvePort(p));
    });
    srv.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const hostHeader = `127.0.0.1:${port}`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: { Host: hostHeader },
      });
      if (res.status === 200) return;
    } catch {
      // not ready
    }
    await sleep(500);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for /api/health on port ${port}`);
}

function listProcesses() {
  if (isWin) {
    try {
      const out = execFileSync('wmic', ['process', 'get', 'ProcessId,CommandLine', '/FORMAT:CSV'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      return out
        .split(/\r?\n/)
        .slice(1)
        .map((line) => {
          const parts = line.split(',');
          if (parts.length < 3) return null;
          const pid = Number(parts[parts.length - 2]);
          const cmd = parts.slice(1, -2).join(',');
          return Number.isFinite(pid) ? { pid, cmd } : null;
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }
  try {
    const out = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' });
    return out.split('\n').map((line) => {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      return m ? { pid: Number(m[1]), cmd: m[2] } : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function sidecarNodeProcesses(hostExe) {
  const hostDir = dirname(hostExe).toLowerCase();
  const markers = ['server.js', 'fixer-resources', 'node-aarch64', 'node-x86_64', '/bin/node'];
  return listProcesses().filter(({ cmd }) => {
    const c = (cmd ?? '').toLowerCase();
    if (!c.includes('node')) return false;
    if (markers.some((m) => c.includes(m.toLowerCase()))) return true;
    return hostDir && c.includes(hostDir) && c.includes('node');
  });
}

function killHost(pid) {
  if (isWin) {
    execFileSync('taskkill', ['/PID', String(pid)], { windowsHide: true });
  } else {
    process.kill(pid, 'SIGTERM');
  }
}

function resolveDefaultHost() {
  const tauriDir = join(here, '../src-tauri');
  const release = join(tauriDir, 'target/release');
  if (isWin) {
    for (const name of ['fixer-desktop.exe', 'Fixer.exe']) {
      const p = join(release, name);
      if (existsSync(p)) return p;
    }
  } else if (process.platform === 'darwin') {
    const macBundle = join(release, 'bundle/macos');
    if (existsSync(macBundle)) {
      for (const ent of readdirSync(macBundle)) {
        if (ent.endsWith('.app')) {
          const exe = join(macBundle, ent, 'Contents/MacOS');
          for (const bin of readdirSync(exe)) {
            const p = join(exe, bin);
            if (existsSync(p)) return p;
          }
        }
      }
    }
    for (const name of ['fixer-desktop', 'Fixer']) {
      const p = join(release, name);
      if (existsSync(p)) return p;
    }
  } else {
    for (const name of ['fixer-desktop', 'fixer']) {
      const p = join(release, name);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let host = args.host ?? resolveDefaultHost();
  if (!host || !existsSync(host)) {
    console.error('Could not find host binary; pass --host');
    process.exit(1);
  }

  const port = await pickFreePort(args.port);
  const env = { ...process.env, LT_APP_PORT: String(port) };
  const dataRoot = mkdtempSync(join(tmpdir(), 'fixer-smoke-data-'));
  if (!isWin) {
    env.XDG_DATA_HOME = dataRoot;
  }

  const beforeSidecars = new Set(sidecarNodeProcesses(host).map((p) => p.pid));
  const child = spawn(host, [], {
    env,
    stdio: 'ignore',
    windowsHide: true,
  });

  try {
    await waitForHealth(port, args.timeoutMs);
    console.log(`health ok on 127.0.0.1:${port}`);
  } catch (err) {
    try {
      killHost(child.pid);
    } catch {
      // ignore
    }
    throw err;
  }

  killHost(child.pid);
  await sleep(isWin ? 3000 : 1500);

  const after = sidecarNodeProcesses(host).filter((p) => !beforeSidecars.has(p.pid));
  if (after.length > 0) {
    console.error('Sidecar Node process(es) still running after host quit:');
    for (const p of after) console.error(`  pid ${p.pid}: ${p.cmd}`);
    process.exit(1);
  }
  console.log('packaged smoke ok');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    // temp data dir left for the OS to reap; isolated under tmpdir
  });
