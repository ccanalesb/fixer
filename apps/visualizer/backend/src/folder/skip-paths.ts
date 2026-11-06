/**
 * Names and paths skipped when walking a folder catalog tree.
 *
 * The name rules apply to entries below the root: a root the user chose is
 * walked whatever it is called.
 */
import path from 'node:path';
import { dataRoot } from '../config.js';
import { resolveOpenLibraryPaths } from '../open-library.js';
import { isResolvedPathInsideDir, type PathContainmentModule } from '../utils/path-containment.js';

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

/** The `candidates` that are `catalogRoot` or sit below it. */
export function skipRootsInside(
  catalogRoot: string,
  candidates: readonly string[],
  pathMod: PathContainmentModule = path,
): string[] {
  return candidates.filter((c) => isResolvedPathInsideDir(catalogRoot, c, pathMod));
}

/** The app's data folder and vision cache, when they sit under `catalogRoot`. */
export function skipRootsUnderCatalog(catalogRoot: string): string[] {
  const candidates = [dataRoot()];
  try {
    candidates.push(resolveOpenLibraryPaths().visionCacheDir);
  } catch {
    /* library not resolved yet */
  }
  return skipRootsInside(catalogRoot, candidates);
}

export function isUnderSkippedRoot(
  absPath: string,
  skipRoots: readonly string[],
  pathMod: PathContainmentModule = path,
): boolean {
  return skipRoots.some((root) => isResolvedPathInsideDir(root, absPath, pathMod));
}
