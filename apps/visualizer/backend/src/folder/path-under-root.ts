/**
 * Whether a file path resolves under a folder catalog root (symlink-safe).
 */
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { canonicalPath, isPathUnderAllowedRoots } from '../api/images/common.js';

export function pathUnderCatalogRoot(catalogRoot: string, filePath: string): boolean {
  const root = canonicalPath(catalogRoot);
  if (!root || !String(filePath).trim()) return false;
  if (existsSync(filePath)) return isPathUnderAllowedRoots(filePath, [root]);
  const abs = resolve(filePath);
  const parent = canonicalPath(dirname(abs));
  if (!parent) return false;
  const rel = relative(root, join(parent, basename(abs)));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function assertPathUnderCatalogRoot(catalogRoot: string, filePath: string): void {
  if (!pathUnderCatalogRoot(catalogRoot, filePath)) {
    throw new Error('Path is outside the catalog root.');
  }
}
