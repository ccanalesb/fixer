#!/usr/bin/env node
/**
 * Fail if a release tag does not match the root package.json version.
 *
 * Usage: check-release-version.mjs <tag>   (tag may be v1.2.3 or 1.2.3)
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function packageVersion() {
  const raw = readFileSync(join(repoRoot, 'package.json'), 'utf8');
  const pkg = JSON.parse(raw);
  if (typeof pkg.version !== 'string' || !pkg.version) {
    throw new Error('Root package.json has no version string');
  }
  return pkg.version;
}

function normalizeTag(tag) {
  const t = tag.trim();
  if (t.startsWith('refs/tags/')) return t.slice('refs/tags/'.length);
  return t.startsWith('v') ? t.slice(1) : t;
}

function main() {
  const tagArg = process.argv[2];
  if (!tagArg) {
    console.error('Usage: check-release-version.mjs <tag>');
    process.exit(2);
  }
  const fromTag = normalizeTag(tagArg);
  const fromPkg = packageVersion();
  if (fromTag !== fromPkg) {
    console.error(
      `Release tag version "${fromTag}" does not match package.json version "${fromPkg}".`,
    );
    process.exit(1);
  }
  console.log(`Version check ok: v${fromPkg}`);
}

main();
