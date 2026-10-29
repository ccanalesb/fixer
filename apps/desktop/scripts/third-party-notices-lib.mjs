import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export const CONVERSION_NOTICE_LINE =
  'The first model conversion downloads Python, PyTorch, Transformers and their dependencies under their own licenses.';

export const SECTION_HEADERS = {
  backend: 'Backend Node.js packages',
  frontend: 'Frontend JavaScript packages',
  rust: 'Rust crates (Tauri host)',
  node: 'Node.js runtime',
  onnxruntime: 'ONNX Runtime',
  sharpLibvips: 'sharp-libvips (libvips and bundled native libraries)',
  librawWasm: 'libraw-wasm and LibRaw',
  uv: 'uv (model conversion tool)',
  conversion: 'Model conversion (downloaded on first use)',
};

const LICENSE_BASENAMES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENSE-MIT',
  'LICENCE',
  'LICENCE.md',
  'LICENCE.txt',
  'COPYING',
  'COPYING.txt',
  'NOTICE',
  'Notice.txt',
  'UNLICENSE',
];

export class MissingLicenseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MissingLicenseError';
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function normalizeLicenseId(raw) {
  if (raw == null) return undefined;
  if (typeof raw === 'string') return raw.trim() || undefined;
  if (typeof raw === 'object' && raw.type) return String(raw.type).trim() || undefined;
  return undefined;
}

export function findLicenseFileInDir(dir) {
  if (!existsSync(dir)) return undefined;
  for (const name of LICENSE_BASENAMES) {
    const p = join(dir, name);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  for (const name of readdirSync(dir)) {
    if (!/^license/i.test(name) && !/^copying/i.test(name) && !/^notice/i.test(name)) {
      continue;
    }
    const p = join(dir, name);
    if (statSync(p).isFile()) return p;
  }
  return undefined;
}

function readPackageMeta(pkgDir) {
  const pkgJsonPath = join(pkgDir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    throw new MissingLicenseError(`No package.json in ${pkgDir}`);
  }
  const pkg = readJson(pkgJsonPath);
  const name = pkg.name ?? basename(pkgDir);
  const version = pkg.version ?? 'unknown';
  const licenseId = normalizeLicenseId(pkg.license) ?? 'UNKNOWN';
  return { pkg, name, version, licenseId };
}

export function readPackageLicense(pkgDir) {
  const { name, version, licenseId } = readPackageMeta(pkgDir);
  const licensePath = findLicenseFileInDir(pkgDir);
  if (!licensePath) {
    throw new MissingLicenseError(
      `No LICENSE/COPYING/NOTICE file for npm package ${name}@${version} (${pkgDir})`,
    );
  }
  const licenseText = readFileSync(licensePath, 'utf8');
  return { name, version, licenseId, licenseText, licensePath };
}

function parseGithubRepo(repository) {
  if (!repository?.url) return undefined;
  const m = String(repository.url).match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!m) return undefined;
  return {
    owner: m[1],
    repo: m[2].replace(/\.git$/, ''),
    directory: repository.directory,
  };
}

function licenseFileNamesInTarball(tarListing) {
  return tarListing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line.startsWith('package/')) return false;
      const base = basename(line);
      return (
        LICENSE_BASENAMES.includes(base) ||
        /^license/i.test(base) ||
        /^copying/i.test(base) ||
        /^notice/i.test(base)
      );
    });
}

function licenseFromNpmTarball(name, version) {
  const work = mkdtempSync(join(tmpdir(), 'npm-pack-'));
  try {
    const spec = `${name}@${version}`;
    const pack = spawnSync('npm', ['pack', spec, '--pack-destination', work], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (pack.status !== 0) {
      return undefined;
    }
    const lines = pack.stdout.trim().split(/\r?\n/).filter(Boolean);
    const tgzPath = join(work, lines[lines.length - 1]);
    if (!existsSync(tgzPath)) return undefined;
    const list = spawnSync('tar', ['-tzf', tgzPath], { encoding: 'utf8' });
    if (list.status !== 0) return undefined;
    const candidates = licenseFileNamesInTarball(list.stdout);
    if (candidates.length === 0) return undefined;
    const pick = candidates.sort((a, b) => a.length - b.length)[0];
    const extracted = spawnSync('tar', ['-xOf', tgzPath, pick], { encoding: 'utf8' });
    if (extracted.status !== 0 || !extracted.stdout.trim()) return undefined;
    return { text: extracted.stdout, file: pick.replace(/^package\//, '') };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function licenseFromGithub(pkg, version, fetchImpl) {
  const gh = parseGithubRepo(pkg.repository);
  if (!gh) return undefined;
  const tags = [`v${version}`, version];
  const files = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING', 'NOTICE'];
  for (const tag of tags) {
    for (const file of files) {
      const paths = [`${file}`];
      if (gh.directory) paths.push(`${gh.directory}/${file}`);
      for (const rel of paths) {
        const url = `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${tag}/${rel}`;
        try {
          const text = await fetchText(url, fetchImpl);
          if (text.trim()) return { text, file: `github:${rel}@${tag}` };
        } catch {
          // try next
        }
      }
    }
  }
  return undefined;
}

function isSimpleSpdxId(licenseId) {
  if (!licenseId || licenseId === 'UNKNOWN') return false;
  if (/ OR | AND |\(|\)/.test(licenseId)) return false;
  return /^[A-Za-z0-9.-]+$/.test(licenseId);
}

async function licenseFromSpdx(licenseId, fetchImpl) {
  if (!isSimpleSpdxId(licenseId)) return undefined;
  const url = `https://raw.githubusercontent.com/spdx/license-list-data/main/text/${encodeURIComponent(licenseId)}.txt`;
  try {
    const text = await fetchText(url, fetchImpl);
    if (text.trim()) return { text, file: `spdx:${licenseId}` };
  } catch {
    // not in SPDX list
  }
  return undefined;
}

async function licenseFromCompoundId(licenseId, fetchImpl) {
  const normalized = licenseId.trim();
  const dualMitApache = /^MIT\s+OR\s+Apache(?:-2\.0)?(?:-2\.0)?$/i;
  if (dualMitApache.test(normalized)) {
    const mit = await licenseFromSpdx('MIT', fetchImpl);
    const apache = await licenseFromSpdx('Apache-2.0', fetchImpl);
    if (mit?.text && apache?.text) {
      return {
        text: `${mit.text.trimEnd()}\n\n---\n\n${apache.text.trimEnd()}\n`,
        file: 'spdx:MIT+Apache-2.0',
      };
    }
  }
  return undefined;
}

export async function resolveNpmPackageLicense(pkgDir, fetchImpl = fetch, cache = new Map()) {
  const { pkg, name, version, licenseId } = readPackageMeta(pkgDir);
  const cacheKey = `${name}@${version}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const licensePath = findLicenseFileInDir(pkgDir);
  if (licensePath) {
    const result = {
      name,
      version,
      licenseId,
      licenseText: readFileSync(licensePath, 'utf8'),
      licensePath,
    };
    cache.set(cacheKey, result);
    return result;
  }

  const tarballHit = licenseFromNpmTarball(name, version);
  if (tarballHit) {
    const result = {
      name,
      version,
      licenseId,
      licenseText: tarballHit.text,
      licensePath: `npm tarball (${tarballHit.file})`,
    };
    cache.set(cacheKey, result);
    return result;
  }

  const githubHit = await licenseFromGithub(pkg, version, fetchImpl);
  if (githubHit) {
    const result = {
      name,
      version,
      licenseId,
      licenseText: githubHit.text,
      licensePath: githubHit.file,
    };
    cache.set(cacheKey, result);
    return result;
  }

  const spdxHit = await licenseFromSpdx(licenseId, fetchImpl);
  if (spdxHit) {
    const result = {
      name,
      version,
      licenseId,
      licenseText: spdxHit.text,
      licensePath: spdxHit.file,
    };
    cache.set(cacheKey, result);
    return result;
  }

  const compoundHit = await licenseFromCompoundId(licenseId, fetchImpl);
  if (compoundHit) {
    const result = {
      name,
      version,
      licenseId,
      licenseText: compoundHit.text,
      licensePath: compoundHit.file,
    };
    cache.set(cacheKey, result);
    return result;
  }

  throw new MissingLicenseError(
    `No discoverable license for npm package ${name}@${version} (${pkgDir})`,
  );
}

export function listNodeModulesPackageDirs(nodeModulesRoot) {
  const dirs = [];
  if (!existsSync(nodeModulesRoot)) return dirs;

  function walk(nmDir) {
    for (const entry of readdirSync(nmDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (name === '.bin' || name.startsWith('.')) continue;
      if (name.startsWith('@')) {
        const scopePath = join(nmDir, name);
        for (const scoped of readdirSync(scopePath, { withFileTypes: true })) {
          if (!scoped.isDirectory()) continue;
          visitPackage(join(scopePath, scoped.name));
        }
      } else {
        visitPackage(join(nmDir, name));
      }
    }
  }

  function visitPackage(pkgDir) {
    if (existsSync(join(pkgDir, 'package.json'))) {
      dirs.push(pkgDir);
    }
    const nested = join(pkgDir, 'node_modules');
    if (existsSync(nested)) walk(nested);
  }

  walk(nodeModulesRoot);
  return dirs;
}

export async function collectNpmPackagesFromNodeModules(nodeModulesRoot, fetchImpl = fetch) {
  const seen = new Map();
  const cache = new Map();
  for (const dir of listNodeModulesPackageDirs(nodeModulesRoot)) {
    const info = await resolveNpmPackageLicense(dir, fetchImpl, cache);
    const key = `${info.name}@${info.version}`;
    if (!seen.has(key)) seen.set(key, info);
  }
  return [...seen.values()].sort((a, b) =>
    a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

function flattenNpmLs(node, packageName) {
  const out = [];
  if (!node || typeof node !== 'object') return out;
  if (node.name && node.version) {
    out.push({ name: node.name, version: node.version });
  } else if (packageName && node.version) {
    out.push({ name: packageName, version: node.version });
  }
  const deps = node.dependencies;
  if (deps && typeof deps === 'object') {
    for (const [depName, child] of Object.entries(deps)) {
      out.push(...flattenNpmLs(child, depName));
    }
  }
  return out;
}

export async function collectFrontendProductionPackages(frontendDir, fetchImpl = fetch) {
  const ls = spawnSync('npm', ['ls', '--all', '--omit=dev', '--json'], {
    cwd: frontendDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (ls.status !== 0) {
    throw new Error(
      `npm ls failed in ${frontendDir}: ${ls.stderr || ls.stdout || ls.status}`,
    );
  }
  const tree = JSON.parse(ls.stdout);
  const nmRoot = join(frontendDir, 'node_modules');
  const seen = new Map();
  const cache = new Map();
  for (const { name, version } of flattenNpmLs(tree)) {
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;
    const pkgDir = resolvePackageDir(nmRoot, name);
    if (!pkgDir) {
      if (tree.name === name && tree.version === version) {
        continue;
      }
      throw new MissingLicenseError(
        `Frontend production package ${key} not found under ${nmRoot}`,
      );
    }
    seen.set(key, await resolveNpmPackageLicense(pkgDir, fetchImpl, cache));
  }
  return [...seen.values()].sort((a, b) =>
    a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

function resolvePackageDir(nodeModulesRoot, packageName) {
  const parts = packageName.split('/');
  let dir = nodeModulesRoot;
  for (const part of parts) {
    dir = join(dir, part);
  }
  if (existsSync(join(dir, 'package.json'))) return dir;
  return undefined;
}

function findCargoRegistryDir(crateName, crateVersion) {
  const registryRoot = join(homedir(), '.cargo', 'registry', 'src');
  if (!existsSync(registryRoot)) return undefined;
  for (const indexDir of readdirSync(registryRoot)) {
    const candidate = join(registryRoot, indexDir, `${crateName}-${crateVersion}`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function resolveRustCrateLicense(pkg, fetchImpl) {
  const licenseId = (pkg.license ?? '').trim() || 'UNKNOWN';
  const src = findCargoRegistryDir(pkg.name, pkg.version);
  if (src) {
    const licensePath = findLicenseFileInDir(src);
    if (licensePath) {
      return {
        name: pkg.name,
        version: pkg.version,
        licenseId,
        licenseText: readFileSync(licensePath, 'utf8'),
        licensePath,
      };
    }
    if (pkg.license_file) {
      const explicit = join(src, pkg.license_file);
      if (existsSync(explicit)) {
        return {
          name: pkg.name,
          version: pkg.version,
          licenseId,
          licenseText: readFileSync(explicit, 'utf8'),
          licensePath: explicit,
        };
      }
    }
  }

  const spdxHit = await licenseFromSpdx(licenseId, fetchImpl);
  if (spdxHit) {
    return {
      name: pkg.name,
      version: pkg.version,
      licenseId,
      licenseText: spdxHit.text,
      licensePath: spdxHit.file,
    };
  }
  const compoundHit = await licenseFromCompoundId(licenseId, fetchImpl);
  if (compoundHit) {
    return {
      name: pkg.name,
      version: pkg.version,
      licenseId,
      licenseText: compoundHit.text,
      licensePath: compoundHit.file,
    };
  }

  const orParts = licenseId.split(/\s+OR\s+|\s*\/\s*/i).map((s) => s.trim()).filter(Boolean);
  if (orParts.length > 1) {
    const chunks = [];
    for (const part of orParts) {
      const hit =
        (await licenseFromSpdx(part, fetchImpl)) ??
        (await licenseFromCompoundId(part, fetchImpl));
      if (!hit?.text) {
        throw new MissingLicenseError(
          `No license text for ${pkg.name}@${pkg.version} (license: ${licenseId})`,
        );
      }
      chunks.push(hit.text.trimEnd());
    }
    return {
      name: pkg.name,
      version: pkg.version,
      licenseId,
      licenseText: `${chunks.join('\n\n---\n\n')}\n`,
      licensePath: `spdx:${licenseId}`,
    };
  }

  throw new MissingLicenseError(
    `No discoverable license for Rust crate ${pkg.name}@${pkg.version} (${licenseId})`,
  );
}

export async function collectRustCrates(manifestPath, fetchImpl = fetch) {
  const meta = spawnSync(
    'cargo',
    ['metadata', '--format-version', '1', '--manifest-path', manifestPath, '--locked'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (meta.error) {
    throw new Error(`cargo metadata failed: ${meta.error.message}`);
  }
  if (meta.status !== 0) {
    throw new Error(`cargo metadata failed: ${meta.stderr || meta.stdout}`);
  }
  const data = JSON.parse(meta.stdout);
  const seen = new Map();
  for (const pkg of data.packages) {
    if (!pkg.source?.startsWith('registry+')) {
      continue;
    }
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    seen.set(key, await resolveRustCrateLicense(pkg, fetchImpl));
  }
  return [...seen.values()].sort((a, b) =>
    a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

export function sharpLibvipsPackageName(platform, arch) {
  if (platform === 'darwin') {
    return `@img/sharp-libvips-darwin-${arch}`;
  }
  // On Windows sharp ships libvips inside its own platform package.
  if (platform === 'win32') {
    return `@img/sharp-win32-${arch}`;
  }
  if (platform === 'linux') {
    return `@img/sharp-libvips-linux-${arch}`;
  }
  throw new Error(`Unsupported platform for sharp-libvips: ${platform}`);
}

/** The sharp-libvips release that `sharp` pins; its tag holds the upstream notices. */
export function sharpLibvipsReleaseVersion(nodeModulesRoot, libvipsPackageName, libvipsPackageVersion) {
  if (libvipsPackageName.startsWith('@img/sharp-libvips-')) return libvipsPackageVersion;
  const sharpDir = resolvePackageDir(nodeModulesRoot, 'sharp');
  if (!sharpDir) throw new Error('sharp not found in staged backend node_modules');
  const sharpPkg = JSON.parse(readFileSync(join(sharpDir, 'package.json'), 'utf8'));
  const pinned = Object.entries(sharpPkg.optionalDependencies ?? {}).find(([name]) =>
    name.startsWith('@img/sharp-libvips-'),
  );
  if (!pinned) throw new Error('sharp does not pin a sharp-libvips release');
  return pinned[1];
}

export function findSharpLibvipsDir(nodeModulesRoot, platform, arch) {
  const expected = sharpLibvipsPackageName(platform, arch);
  const direct = resolvePackageDir(nodeModulesRoot, expected);
  if (direct) return { dir: direct, packageName: expected };
  const matches = [];
  const imgDir = join(nodeModulesRoot, '@img');
  if (existsSync(imgDir)) {
    for (const entry of readdirSync(imgDir)) {
      if (entry.startsWith('sharp-libvips-')) {
        matches.push({ dir: join(imgDir, entry), packageName: `@img/${entry}` });
      }
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const preferred = matches.find((m) => m.packageName === expected);
    if (preferred) return preferred;
  }
  throw new Error(
    `No @img/sharp-libvips package found under ${nodeModulesRoot} for ${platform}/${arch}`,
  );
}

export function formatPackageBlock(title, { name, version, licenseId, licenseText }, extraLines = []) {
  const lines = [
    `${title}`,
    `Name: ${name}`,
    `Version: ${version}`,
    `License: ${licenseId}`,
    ...extraLines,
    '',
    licenseText.trimEnd(),
    '',
  ];
  return lines.join('\n');
}

export function formatSection(header, body) {
  const rule = '='.repeat(header.length);
  return `${rule}\n${header}\n${rule}\n\n${body.trimEnd()}\n\n`;
}

export function formatNpmSection(packages) {
  return packages
    .map((pkg) => formatPackageBlock('Package', pkg))
    .join('\n');
}

export async function fetchText(url, fetchImpl = fetch) {
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.text();
}

export async function loadNodeRuntimeLicense(nodeVersion, fetchImpl = fetch) {
  const url = `https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`;
  const licenseText = await fetchText(url, fetchImpl);
  return {
    name: 'Node.js',
    version: nodeVersion,
    licenseId: 'Multiple (see LICENSE)',
    licenseText,
  };
}

export async function loadOnnxRuntimeThirdPartyNotices(ortVersion, fetchImpl = fetch) {
  const url = `https://raw.githubusercontent.com/microsoft/onnxruntime/v${ortVersion}/ThirdPartyNotices.txt`;
  const licenseText = await fetchText(url, fetchImpl);
  return {
    name: 'ONNX Runtime',
    version: ortVersion,
    licenseId: 'See ThirdPartyNotices.txt',
    licenseText,
  };
}

export async function loadSharpLibvipsNotices(libvipsNpmVersion, fetchImpl = fetch) {
  const sourceUrl = `https://github.com/lovell/sharp-libvips/tree/v${libvipsNpmVersion}`;
  const url = `https://raw.githubusercontent.com/lovell/sharp-libvips/v${libvipsNpmVersion}/THIRD-PARTY-NOTICES.md`;
  let licenseText;
  try {
    licenseText = await fetchText(url, fetchImpl);
  } catch {
    licenseText = `(Could not fetch THIRD-PARTY-NOTICES.md from ${url})`;
  }
  return { sourceUrl, licenseText, version: libvipsNpmVersion };
}

export async function loadLibRawNotices({ librawWasmVersion, librawVersion }, fetchImpl = fetch) {
  const wasmSourceUrl = `https://github.com/ybouane/LibRaw-Wasm/tree/v${librawWasmVersion}`;
  const librawSourceUrl = `https://github.com/LibRaw/LibRaw/tree/${librawVersion}`;
  const librawLicenseUrl = `https://raw.githubusercontent.com/LibRaw/LibRaw/${librawVersion}/LICENSE.LGPL`;
  let librawLicenseText;
  try {
    librawLicenseText = await fetchText(librawLicenseUrl, fetchImpl);
  } catch {
    librawLicenseText = await fetchText(
      `https://raw.githubusercontent.com/LibRaw/LibRaw/${librawVersion}/COPYRIGHT`,
      fetchImpl,
    );
  }
  return { wasmSourceUrl, librawSourceUrl, librawLicenseText, librawVersion };
}

export async function loadUvLicenses(uvVersion, fetchImpl = fetch) {
  const base = `https://raw.githubusercontent.com/astral-sh/uv/${uvVersion}`;
  const mit = await fetchText(`${base}/LICENSE-MIT`, fetchImpl);
  const apache = await fetchText(`${base}/LICENSE-APACHE`, fetchImpl);
  return {
    name: 'uv',
    version: uvVersion,
    licenseId: 'MIT OR Apache-2.0',
    licenseText: `${mit.trimEnd()}\n\n---\n\n${apache.trimEnd()}\n`,
    sourceUrl: `https://github.com/astral-sh/uv/tree/${uvVersion}`,
  };
}

export function inferLibRawVersionFromWasmPackage(pkgDir) {
  const readme = join(pkgDir, 'readme.md');
  if (existsSync(readme)) {
    const text = readFileSync(readme, 'utf8');
    const m = text.match(/LibRaw[^\d]*(\d+\.\d+\.\d+)/i);
    if (m) return m[1];
  }
  return '0.22.1';
}

export async function buildThirdPartyNotices(options) {
  const {
    stageRoot,
    frontendDir,
    cargoManifest,
    platform,
    arch,
    nodeVersion,
    uvVersion,
    librawVersion = '0.22.1',
    fetchImpl = fetch,
  } = options;

  const npmCache = new Map();
  const backendNm = join(stageRoot, 'node_modules');
  const backendPackages = await collectNpmPackagesFromNodeModules(backendNm, fetchImpl);
  const frontendPackages = await collectFrontendProductionPackages(frontendDir, fetchImpl);
  const rustCrates = await collectRustCrates(cargoManifest, fetchImpl);

  const { dir: sharpDir, packageName: sharpPkgName } = findSharpLibvipsDir(
    backendNm,
    platform,
    arch,
  );
  const sharpPkg = await resolveNpmPackageLicense(sharpDir, fetchImpl, npmCache);
  const sharpUpstream = await loadSharpLibvipsNotices(
    sharpLibvipsReleaseVersion(backendNm, sharpPkgName, sharpPkg.version),
    fetchImpl,
  );

  const librawWasmDir = resolvePackageDir(backendNm, 'libraw-wasm');
  if (!librawWasmDir) {
    throw new Error('libraw-wasm not found in staged backend node_modules');
  }
  const librawWasmPkg = await resolveNpmPackageLicense(librawWasmDir, fetchImpl, npmCache);
  const librawUpstream = await loadLibRawNotices(
    { librawWasmVersion: librawWasmPkg.version, librawVersion },
    fetchImpl,
  );

  const ortPkg = await resolveNpmPackageLicense(
    resolvePackageDir(backendNm, 'onnxruntime-node'),
    fetchImpl,
    npmCache,
  );
  const nodeRuntime = await loadNodeRuntimeLicense(nodeVersion, fetchImpl);
  const ortNotices = await loadOnnxRuntimeThirdPartyNotices(ortPkg.version, fetchImpl);
  const uv = await loadUvLicenses(uvVersion, fetchImpl);

  const parts = [
    'THIRD-PARTY-NOTICES',
    '',
    'This file lists open-source components shipped with Fixer and their license terms.',
    '',
    formatSection(SECTION_HEADERS.backend, formatNpmSection(backendPackages)),
    formatSection(SECTION_HEADERS.frontend, formatNpmSection(frontendPackages)),
    formatSection(
      SECTION_HEADERS.rust,
      rustCrates.map((c) => formatPackageBlock('Crate', c)).join('\n'),
    ),
    formatSection(
      SECTION_HEADERS.node,
      formatPackageBlock('Runtime', nodeRuntime),
    ),
    formatSection(
      SECTION_HEADERS.onnxruntime,
      formatPackageBlock('Component', ortNotices),
    ),
    formatSection(
      SECTION_HEADERS.sharpLibvips,
      [
        `Package: ${sharpPkgName}`,
        `Version: ${sharpPkg.version}`,
        `Upstream source (LGPL components): ${sharpUpstream.sourceUrl}`,
        '',
        sharpUpstream.licenseText.trimEnd(),
        '',
        '---',
        '',
        formatPackageBlock('npm package metadata', sharpPkg, [
          `Upstream source: ${sharpUpstream.sourceUrl}`,
        ]),
      ].join('\n'),
    ),
    formatSection(
      SECTION_HEADERS.librawWasm,
      [
        formatPackageBlock('npm package (glue)', librawWasmPkg, [
          `Upstream source: ${librawUpstream.wasmSourceUrl}`,
        ]),
        'LibRaw (linked inside libraw.wasm)',
        `Version: ${librawUpstream.librawVersion}`,
        `Upstream source: ${librawUpstream.librawSourceUrl}`,
        'License: LGPL-2.1-or-later OR CDDL-1.0',
        '',
        librawUpstream.librawLicenseText.trimEnd(),
        '',
      ].join('\n'),
    ),
    formatSection(
      SECTION_HEADERS.uv,
      formatPackageBlock('Tool', uv, [`Upstream source: ${uv.sourceUrl}`]),
    ),
    formatSection(SECTION_HEADERS.conversion, CONVERSION_NOTICE_LINE),
  ];

  return parts.join('\n');
}
