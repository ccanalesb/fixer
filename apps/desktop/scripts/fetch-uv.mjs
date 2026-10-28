#!/usr/bin/env node
/**
 * Download the pinned official uv release for a Rust target triple, verify sha256, install to staged-resources/bin/.
 *
 * Usage: fetch-uv.mjs [triple] [--stage <staged-resources-root>]
 */
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { chmodSync, copyFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');

function readVersion() {
  return readFileSync(join(desktopRoot, 'uv-version.txt'), 'utf8').trim();
}

function tripleFromHost() {
  try {
    const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
    const m = out.match(/^host: (\S+)/m);
    if (m) return m[1];
  } catch {
    // fall through
  }
  throw new Error('Could not determine host triple; pass one as the first argument.');
}

function assetForTriple(triple) {
  switch (triple) {
    case 'aarch64-apple-darwin':
      return { archive: `uv-aarch64-apple-darwin.tar.gz`, kind: 'tar.gz', bin: 'uv' };
    case 'x86_64-pc-windows-msvc':
      return { archive: `uv-x86_64-pc-windows-msvc.zip`, kind: 'zip', bin: 'uv.exe' };
    case 'x86_64-unknown-linux-gnu':
      return { archive: `uv-x86_64-unknown-linux-gnu.tar.gz`, kind: 'tar.gz', bin: 'uv' };
    default:
      throw new Error(`Unsupported target triple: ${triple}`);
  }
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  await pipeline(res.body, createWriteStream(dest));
}

function sha256File(path) {
  const h = createHash('sha256');
  h.update(readFileSync(path));
  return h.digest('hex');
}

function expectedHash(sumsText, archiveName) {
  for (const line of sumsText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^([a-f0-9]{64})\s+\*?(.+)$/);
    if (m && m[2] === archiveName) return m[1];
  }
  throw new Error(`No sha256 entry for ${archiveName} in release sums`);
}

function findExtractedBin(work, binName) {
  const direct = join(work, binName);
  if (existsSync(direct)) return direct;
  for (const entry of readdirSync(work, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = join(work, entry.name, binName);
    if (existsSync(nested)) return nested;
  }
  throw new Error(`Could not find ${binName} after extracting uv archive`);
}

function extract(work, archivePath, kind, binName, outPath) {
  if (kind === 'tar.gz') {
    execFileSync('tar', ['-xzf', archivePath, '-C', work], { stdio: 'inherit' });
  } else if (kind === 'zip') {
    try {
      execFileSync('unzip', ['-q', archivePath, binName, '-d', work], { stdio: 'inherit' });
    } catch {
      execFileSync('tar', ['-xf', archivePath, '-C', work], { stdio: 'inherit' });
    }
  } else {
    throw new Error(`Unknown archive kind: ${kind}`);
  }
  copyFileSync(findExtractedBin(work, binName), outPath);
  chmodSync(outPath, 0o755);
}

function parseArgs(argv) {
  let triple;
  let stageRoot = join(desktopRoot, 'staged-resources');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stage') stageRoot = resolve(argv[++i]);
    else if (a === '-h' || a === '--help') {
      console.error('Usage: fetch-uv.mjs [triple] [--stage <dir>]');
      process.exit(2);
    } else if (!a.startsWith('-')) triple = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return { triple: triple ?? tripleFromHost(), stageRoot };
}

async function main() {
  const { triple, stageRoot } = parseArgs(process.argv.slice(2));
  const version = readVersion();
  const { archive, kind, bin } = assetForTriple(triple);
  const base = `https://github.com/astral-sh/uv/releases/download/${version}`;
  const binDir = join(stageRoot, 'bin');
  mkdirSync(binDir, { recursive: true });
  const outName = triple.includes('windows') ? 'uv.exe' : 'uv';
  const outPath = join(binDir, outName);
  if (existsSync(outPath)) {
    console.log(`uv already present: ${outPath}`);
    return;
  }

  const work = mkdtempSync(join(tmpdir(), 'fixer-fetch-uv-'));
  try {
    const archivePath = join(work, archive);
    await download(`${base}/${archive}`, archivePath);
    const sumsPath = join(work, 'sha256.sum');
    await download(`${base}/sha256.sum`, sumsPath);
    const expected = expectedHash(readFileSync(sumsPath, 'utf8'), archive);
    const got = sha256File(archivePath);
    if (got !== expected) {
      throw new Error(`sha256 mismatch for ${archive}: expected ${expected}, got ${got}`);
    }
    extract(work, archivePath, kind, bin, outPath);
    console.log(`Installed ${outPath} (uv ${version}, ${triple})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
