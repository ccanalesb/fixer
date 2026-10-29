#!/usr/bin/env node
/**
 * Build THIRD-PARTY-NOTICES from the pruned staged resource tree for one target platform.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildThirdPartyNotices } from './third-party-notices-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, '..');

function usage() {
  console.error(`Usage: generate-third-party-notices.mjs \\
  --stage <staged-resources-dir> \\
  [--frontend <frontend-dir>] \\
  [--cargo-manifest <Cargo.toml>] \\
  [--platform darwin|linux|win32] \\
  [--arch arm64|x64] \\
  [--node-version-file <path>] \\
  [--uv-version-file <path>] \\
  [--output <path>]`);
  process.exit(2);
}

function readTrimmed(path) {
  return readFileSync(path, 'utf8').trim();
}

function parseArgs(argv) {
  let stage;
  let frontend = join(desktopRoot, '../visualizer/frontend');
  let cargoManifest = join(desktopRoot, 'src-tauri/Cargo.toml');
  let platform;
  let arch;
  let nodeVersionFile = join(desktopRoot, 'node-version.txt');
  let uvVersionFile = join(desktopRoot, 'uv-version.txt');
  let output;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stage') stage = argv[++i];
    else if (a === '--frontend') frontend = argv[++i];
    else if (a === '--cargo-manifest') cargoManifest = argv[++i];
    else if (a === '--platform') platform = argv[++i];
    else if (a === '--arch') arch = argv[++i];
    else if (a === '--node-version-file') nodeVersionFile = argv[++i];
    else if (a === '--uv-version-file') uvVersionFile = argv[++i];
    else if (a === '--output') output = argv[++i];
    else if (a === '-h' || a === '--help') usage();
    else {
      console.error(`Unknown argument: ${a}`);
      usage();
    }
  }

  if (!stage) usage();
  stage = resolve(stage);
  frontend = resolve(frontend);
  cargoManifest = resolve(cargoManifest);
  if (!platform) platform = process.platform;
  if (!arch) arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (!['darwin', 'linux', 'win32'].includes(platform)) {
    console.error(`Unsupported platform: ${platform}`);
    process.exit(1);
  }
  if (!['arm64', 'x64'].includes(arch)) {
    console.error(`Unsupported arch: ${arch}`);
    process.exit(1);
  }
  if (!output) output = join(stage, 'THIRD-PARTY-NOTICES');

  return {
    stage,
    frontend,
    cargoManifest,
    platform,
    arch,
    nodeVersion: readTrimmed(nodeVersionFile),
    uvVersion: readTrimmed(uvVersionFile),
    output,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(
    `Generating THIRD-PARTY-NOTICES (${args.platform}/${args.arch}) → ${args.output}`,
  );

  const text = await buildThirdPartyNotices({
    stageRoot: args.stage,
    frontendDir: args.frontend,
    cargoManifest: args.cargoManifest,
    platform: args.platform,
    arch: args.arch,
    nodeVersion: args.nodeVersion,
    uvVersion: args.uvVersion,
  });

  writeFileSync(args.output, text, 'utf8');
  console.log(`Wrote ${text.length} bytes`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
