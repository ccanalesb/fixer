/**
 * Run the packaged Tauri spike headlessly and rely on SPIKE_OUTPUT_JSON / stderr SPIKE_RESULT_JSON=.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPIKE = join(HERE, '..');
const OUT = join(SPIKE, 'src-tauri', 'target', 'release', 'bundle');

function findMacApp() {
  const macos = join(OUT, 'macos');
  if (!existsSync(macos)) return null;
  const app = readdirSync(macos).find((n) => n.endsWith('.app'));
  if (!app) return null;
  const macosBin = join(macos, app, 'Contents', 'MacOS');
  if (!existsSync(macosBin)) return null;
  const exe = readdirSync(macosBin).find((n) => !n.startsWith('.'));
  return exe ? join(macosBin, exe) : null;
}

function findLinuxBin() {
  const dir = join(OUT, 'appimage');
  if (existsSync(dir)) {
    const appimage = readdirSync(dir).find((n) => n.endsWith('.AppImage'));
    if (appimage) return join(dir, appimage);
  }
  const deb = join(OUT, 'deb');
  if (existsSync(deb)) {
    for (const pkg of readdirSync(deb)) {
      const usr = join(deb, pkg, 'usr', 'bin');
      if (existsSync(usr)) {
        const exe = readdirSync(usr).find((n) => n.startsWith('lt-tauri'));
        if (exe) return join(usr, exe);
      }
    }
  }
  const raw = join(SPIKE, 'src-tauri', 'target', 'release', 'lt-tauri-spike');
  if (existsSync(raw)) return raw;
  return null;
}

function findWinExe() {
  const msi = join(OUT, 'msi');
  if (existsSync(msi)) {
    for (const sub of readdirSync(msi)) {
      const exe = join(msi, sub, 'lt-tauri-spike.exe');
      if (existsSync(exe)) return exe;
    }
  }
  const nsis = join(OUT, 'nsis');
  if (existsSync(nsis)) {
    const exe = readdirSync(nsis).find((n) => n.endsWith('-setup.exe'));
    if (exe) return join(nsis, exe);
  }
  const raw = join(SPIKE, 'src-tauri', 'target', 'release', 'lt-tauri-spike.exe');
  if (existsSync(raw)) return raw;
  return null;
}

const bin =
  process.platform === 'darwin'
    ? findMacApp()
    : process.platform === 'win32'
      ? findWinExe()
      : findLinuxBin();

if (!bin || !existsSync(bin)) {
  process.stderr.write(`Packaged binary not found (looked under ${OUT})\n`);
  process.exit(1);
}

process.stderr.write(`smoke: launching ${bin}\n`);

const r = spawnSync(bin, [], {
  env: {
    ...process.env,
    SPIKE_HEADLESS: '1',
  },
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
