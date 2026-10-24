/**
 * Download official nodejs.org Node 24 binary for the current host into src-tauri/binaries/
 * with Tauri externalBin target-triple naming (binaries/node-<triple>).
 */
import { createWriteStream, existsSync, mkdirSync, chmodSync, renameSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const NODE_VERSION = 'v24.11.0';
const HERE = dirname(fileURLToPath(import.meta.url));
const BIN_DIR = join(HERE, '..', 'src-tauri', 'binaries');

/** @returns {string} */
function targetTriple() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  }
  if (process.platform === 'win32') {
    return 'x86_64-pc-windows-msvc';
  }
  return 'x86_64-unknown-linux-gnu';
}

/** @returns {{ platform: string; arch: string; ext: string }} */
function nodeDistMeta() {
  if (process.platform === 'darwin') {
    return { platform: 'darwin', arch: process.arch === 'arm64' ? 'arm64' : 'x64', ext: 'tar.gz' };
  }
  if (process.platform === 'win32') {
    return { platform: 'win', arch: 'x64', ext: 'zip' };
  }
  return { platform: 'linux', arch: 'x64', ext: 'tar.xz' };
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  await pipeline(res.body, createWriteStream(dest));
}

async function main() {
  mkdirSync(BIN_DIR, { recursive: true });
  const triple = targetTriple();
  const isWin = process.platform === 'win32';
  const outName = isWin ? `node-${triple}.exe` : `node-${triple}`;
  const outPath = join(BIN_DIR, outName);

  if (existsSync(outPath)) {
    process.stdout.write(`fetch-node: already have ${outPath}\n`);
    return;
  }

  const { platform, arch, ext } = nodeDistMeta();
  const base = `node-${NODE_VERSION}-${platform}-${arch}`;
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${base}.${ext}`;
  const tmp = join(BIN_DIR, `_dl_${base}.${ext}`);

  process.stdout.write(`fetch-node: ${url}\n`);
  await download(url, tmp);

  const extractRoot = join(BIN_DIR, '_extract');
  rmSync(extractRoot, { recursive: true, force: true });
  mkdirSync(extractRoot, { recursive: true });

  if (ext === 'tar.gz') {
    execSync(`tar -xzf ${JSON.stringify(tmp)} -C ${JSON.stringify(extractRoot)} --strip-components=1`, {
      stdio: 'inherit',
    });
  } else if (ext === 'tar.xz') {
    execSync(`tar -xJf ${JSON.stringify(tmp)} -C ${JSON.stringify(extractRoot)} --strip-components=1`, {
      stdio: 'inherit',
    });
  } else {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Force -Path ${JSON.stringify(tmp)} -DestinationPath ${JSON.stringify(extractRoot)}"`,
      { stdio: 'inherit' },
    );
    const inner = join(extractRoot, base, 'node.exe');
    if (existsSync(inner)) {
      renameSync(inner, outPath);
      rmSync(tmp, { force: true });
      rmSync(extractRoot, { recursive: true, force: true });
      process.stdout.write(`fetch-node: wrote ${outPath}\n`);
      return;
    }
  }

  const nodeBin = isWin ? join(extractRoot, 'node.exe') : join(extractRoot, 'bin', 'node');
  if (!existsSync(nodeBin)) {
    throw new Error(`node binary not found after extract: ${nodeBin}`);
  }
  renameSync(nodeBin, outPath);
  if (!isWin) chmodSync(outPath, 0o755);
  rmSync(tmp, { force: true });
  rmSync(extractRoot, { recursive: true, force: true });
  process.stdout.write(`fetch-node: wrote ${outPath}\n`);
}

main().catch((e) => {
  process.stderr.write(String(e) + '\n');
  process.exit(1);
});
