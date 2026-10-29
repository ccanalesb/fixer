#!/usr/bin/env node
/**
 * Drop dev deps and non-host native blobs from the backend tree copied into app resources.
 * Run after `ONNXRUNTIME_NODE_INSTALL=skip npm ci` in that tree.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
function usage() {
  console.error(`Usage: prune-staged-backend.mjs --root <staged-backend-dir> [--platform darwin|linux|win32] [--arch arm64|x64]`);
  process.exit(2);
}

function parseArgs(argv) {
  let root;
  let platform;
  let arch;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') root = argv[++i];
    else if (a === '--platform') platform = argv[++i];
    else if (a === '--arch') arch = argv[++i];
    else if (a === '-h' || a === '--help') usage();
    else {
      console.error(`Unknown argument: ${a}`);
      usage();
    }
  }
  if (!root) usage();
  if (!platform) platform = process.platform;
  if (!arch) {
    arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  }
  if (!['darwin', 'linux', 'win32'].includes(platform)) {
    console.error(`Unsupported platform: ${platform}`);
    process.exit(1);
  }
  if (!['arm64', 'x64'].includes(arch)) {
    console.error(`Unsupported arch: ${arch}`);
    process.exit(1);
  }
  return { root, platform, arch };
}

function dirSizeBytes(path) {
  if (!existsSync(path)) return 0;
  let total = 0;
  const stack = [path];
  while (stack.length) {
    const current = stack.pop();
    for (const name of readdirSync(current, { withFileTypes: true })) {
      const p = join(current, name.name);
      if (name.isDirectory()) stack.push(p);
      else total += statSync(p).size;
    }
  }
  return total;
}

function formatMiB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function pruneOrtPrebuilds(nodeModules, platform, arch) {
  const napiRoot = join(nodeModules, 'onnxruntime-node', 'bin', 'napi-v6');
  if (!existsSync(napiRoot)) {
    console.warn(`No onnxruntime-node prebuild root at ${napiRoot}`);
    return;
  }
  for (const osName of readdirSync(napiRoot, { withFileTypes: true })) {
    if (!osName.isDirectory()) continue;
    const osPath = join(napiRoot, osName.name);
    for (const archName of readdirSync(osPath, { withFileTypes: true })) {
      if (!archName.isDirectory()) continue;
      if (osName.name === platform && archName.name === arch) continue;
      const target = join(osPath, archName.name);
      rmSync(target, { recursive: true, force: true });
      console.log(`Removed ORT prebuild ${osName.name}/${archName.name}`);
    }
    try {
      if (readdirSync(osPath).length === 0) {
        rmSync(osPath, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
}

function pruneTransformersBrowserDist(nodeModules) {
  const dist = join(nodeModules, '@huggingface', 'transformers', 'dist');
  const drop = [
    'ort-wasm-simd-threaded.jsep.mjs',
    'transformers.js',
    'transformers.min.js',
    'transformers.web.js',
    'transformers.web.min.js',
  ];
  for (const file of drop) {
    const p = join(dist, file);
    if (existsSync(p)) {
      rmSync(p, { force: true });
      console.log(`Removed ${file}`);
    }
  }
  const cache = join(nodeModules, '@huggingface', 'transformers', '.cache');
  if (existsSync(cache)) {
    rmSync(cache, { recursive: true, force: true });
    console.log('Removed @huggingface/transformers/.cache');
  }
}

const { root, platform, arch } = parseArgs(process.argv.slice(2));
const nodeModules = join(root, 'node_modules');
if (!existsSync(nodeModules)) {
  console.error(`Missing node_modules under ${root}`);
  process.exit(1);
}

const before = dirSizeBytes(nodeModules);
console.log(`node_modules before prune: ${formatMiB(before)} (${platform}/${arch})`);

const npm = spawnSync('npm', ['prune', '--omit=dev'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (npm.status !== 0) {
  process.exit(npm.status ?? 1);
}

rmSync(join(nodeModules, 'onnxruntime-web'), { recursive: true, force: true });
console.log('Removed onnxruntime-web (if present)');

pruneOrtPrebuilds(nodeModules, platform, arch);
pruneTransformersBrowserDist(nodeModules);

const after = dirSizeBytes(nodeModules);
console.log(`node_modules after prune: ${formatMiB(after)} (saved ${formatMiB(before - after)})`);
