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
  const raw = join(SPIKE, 'src-tauri', 'target', 'release', 'lt-tauri-spike');
  if (existsSync(raw)) return raw;
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
  return null;
}

function findWinExe() {
  const raw = join(SPIKE, 'src-tauri', 'target', 'release', 'lt-tauri-spike.exe');
  if (existsSync(raw)) return raw;
  const msi = join(OUT, 'msi');
  if (existsSync(msi)) {
    for (const sub of readdirSync(msi)) {
      const exe = join(msi, sub, 'lt-tauri-spike.exe');
      if (existsSync(exe)) return exe;
    }
  }
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

const smokeEnv = {
  ...process.env,
  SPIKE_HEADLESS: '1',
  SPIKE_DIALOG_STUB: process.env.SPIKE_DIALOG_STUB ?? '1',
  SPIKE_SCREENSHOT_PATH: process.env.SPIKE_SCREENSHOT_PATH,
};
if (process.env.SPIKE_APP_MODELS_DIR) {
  smokeEnv.SPIKE_APP_MODELS_DIR = process.env.SPIKE_APP_MODELS_DIR;
}
if (!smokeEnv.SPIKE_SCREENSHOT_PATH) {
  smokeEnv.SPIKE_SCREENSHOT_PATH = join(SPIKE, 'spike-window-screenshot.png');
}

const r = spawnSync(bin, [], {
  env: smokeEnv,
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
