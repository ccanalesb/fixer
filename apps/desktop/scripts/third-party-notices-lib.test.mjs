import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CONVERSION_NOTICE_LINE,
  MissingLicenseError,
  collectNpmPackagesFromNodeModules,
  findLicenseFileInDir,
  formatSection,
  readPackageLicense,
  sharpLibvipsPackageName,
  sharpLibvipsReleaseVersion,
} from './third-party-notices-lib.mjs';

test('findLicenseFileInDir prefers LICENSE', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpl-'));
  writeFileSync(join(dir, 'NOTICE'), 'notice');
  writeFileSync(join(dir, 'LICENSE'), 'license text');
  assert.equal(findLicenseFileInDir(dir), join(dir, 'LICENSE'));
  rmSync(dir, { recursive: true });
});

test('readPackageLicense throws when license file is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpl-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'no-license-pkg', version: '1.0.0', license: 'MIT' }),
  );
  assert.throws(() => readPackageLicense(dir), MissingLicenseError);
  rmSync(dir, { recursive: true });
});

test('collectNpmPackagesFromNodeModules gathers nested packages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tpl-'));
  const nm = join(root, 'node_modules');
  const pkgA = join(nm, 'alpha');
  const pkgB = join(nm, 'beta', 'node_modules', 'nested');
  mkdirSync(pkgA, { recursive: true });
  mkdirSync(pkgB, { recursive: true });
  for (const [dir, name] of [
    [pkgA, 'alpha'],
    [pkgB, 'nested'],
  ]) {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name, version: '0.1.0', license: 'ISC' }),
    );
    writeFileSync(join(dir, 'LICENSE'), `Copyright ${name}`);
  }
  const pkgs = await collectNpmPackagesFromNodeModules(nm);
  assert.equal(pkgs.length, 2);
  assert.deepEqual(
    pkgs.map((p) => p.name).sort(),
    ['alpha', 'nested'],
  );
  rmSync(root, { recursive: true });
});

test('collectNpmPackagesFromNodeModules fails on missing license in tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tpl-'));
  const nm = join(root, 'node_modules', 'bad');
  mkdirSync(nm, { recursive: true });
  writeFileSync(
    join(nm, 'package.json'),
    JSON.stringify({ name: 'bad', version: '1.0.0' }),
  );
  const fetchFail = async () => {
    throw new Error('offline');
  };
  await assert.rejects(
    () => collectNpmPackagesFromNodeModules(join(root, 'node_modules'), fetchFail),
    MissingLicenseError,
  );
  rmSync(root, { recursive: true });
});

test('sharpLibvipsPackageName maps linux x64', () => {
  assert.equal(sharpLibvipsPackageName('linux', 'x64'), '@img/sharp-libvips-linux-x64');
});

test('sharpLibvipsPackageName maps win32 x64 to the sharp platform package', () => {
  assert.equal(sharpLibvipsPackageName('win32', 'x64'), '@img/sharp-win32-x64');
});

test('sharpLibvipsReleaseVersion reads the release sharp pins when libvips has no package of its own', () => {
  const root = mkdtempSync(join(tmpdir(), 'notices-sharp-'));
  try {
    mkdirSync(join(root, 'sharp'), { recursive: true });
    writeFileSync(
      join(root, 'sharp', 'package.json'),
      JSON.stringify({ name: 'sharp', version: '0.34.5', optionalDependencies: { '@img/sharp-libvips-darwin-arm64': '1.2.4', '@img/sharp-win32-x64': '0.34.5' } }),
    );
    assert.equal(sharpLibvipsReleaseVersion(root, '@img/sharp-win32-x64', '0.34.5'), '1.2.4');
    assert.equal(sharpLibvipsReleaseVersion(root, '@img/sharp-libvips-linux-x64', '1.2.4'), '1.2.4');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('formatSection includes header rule', () => {
  const out = formatSection('Backend Node.js packages', 'body');
  assert.match(out, /^=+\nBackend Node\.js packages\n=+/);
});

test('conversion notice line is fixed copy', () => {
  assert.match(CONVERSION_NOTICE_LINE, /PyTorch/);
  assert.match(CONVERSION_NOTICE_LINE, /Transformers/);
});
