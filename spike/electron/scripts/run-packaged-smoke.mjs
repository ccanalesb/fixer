/**
 * Run the dir-packaged app headlessly and print the JSON result path.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPIKE = join(HERE, '..');
const OUT = join(SPIKE, 'out');

function findMacApp() {
  const macDir = join(OUT, 'mac-arm64');
  if (!existsSync(macDir)) return null;
  const app = readdirSync(macDir).find((n) => n.endsWith('.app'));
  if (!app) return null;
  const macos = join(macDir, app, 'Contents', 'MacOS');
  const exe = readdirSync(macos)[0];
  return exe ? join(macos, exe) : null;
}

function findLinuxBin() {
  const linuxDir = join(OUT, 'linux-unpacked');
  if (!existsSync(linuxDir)) return null;
  const exe = readdirSync(linuxDir).find((n) => !n.includes('.') || n.endsWith('.bin'));
  return exe ? join(linuxDir, exe) : null;
}

function findWinExe() {
  const winDir = join(OUT, 'win-unpacked');
  if (!existsSync(winDir)) return null;
  const exe = readdirSync(winDir).find((n) => n.endsWith('.exe'));
  return exe ? join(winDir, exe) : null;
}

const bin =
  process.platform === 'darwin'
    ? findMacApp()
    : process.platform === 'win32'
      ? findWinExe()
      : findLinuxBin();

if (!bin || !existsSync(bin)) {
  process.stderr.write(`Packaged binary not found under ${OUT}\n`);
  process.exit(1);
}

const r = spawnSync(bin, [], {
  env: { ...process.env, SPIKE_HEADLESS: '1', ELECTRON_ENABLE_LOGGING: '1' },
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
