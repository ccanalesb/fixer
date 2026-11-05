/**
 * Names and paths skipped when walking a folder catalog tree.
 */
import { basename, join } from 'node:path';
import { dataRoot } from '../config.js';
import { resolveOpenLibraryPaths } from '../open-library.js';

const SKIP_BASENAMES = new Set([
  '@eadir',
  '#recycle',
  '$recycle.bin',
  'system volume information',
]);

const SKIP_SUFFIXES = ['.lrdata', '.photoslibrary'];

export function shouldSkipEntryName(name: string): boolean {
  if (name.startsWith('.')) return true;
  const lower = name.toLowerCase();
  if (SKIP_BASENAMES.has(lower)) return true;
  for (const suffix of SKIP_SUFFIXES) {
    if (lower.endsWith(suffix)) return true;
  }
  return false;
}

/** Absolute paths under `catalogRoot` that must not be walked. */
export function skipRootsUnderCatalog(catalogRoot: string): string[] {
  const roots: string[] = [];
  const data = dataRoot();
  if (data.startsWith(catalogRoot + '/') || data === catalogRoot) roots.push(data);
  try {
    const { visionCacheDir } = resolveOpenLibraryPaths();
    if (visionCacheDir.startsWith(catalogRoot + '/') || visionCacheDir === catalogRoot) {
      roots.push(visionCacheDir);
    }
  } catch {
    /* library not resolved yet */
  }
  return roots;
}

export function isUnderSkippedRoot(absPath: string, skipRoots: readonly string[]): boolean {
  for (const root of skipRoots) {
    if (absPath === root || absPath.startsWith(root + '/')) return true;
  }
  return false;
}

export function skipDirectory(absDir: string, skipRoots: readonly string[]): boolean {
  if (isUnderSkippedRoot(absDir, skipRoots)) return true;
  return shouldSkipEntryName(basename(absDir));
}
