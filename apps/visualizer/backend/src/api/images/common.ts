/**
 * Cross-cutting helpers for the images API routes (D-08).
 *
 * The containment check here is the only thing standing between the thumbnail route
 * and arbitrary file disclosure: image keys come from the URL, and the paths they
 * resolve to come out of the database, so neither is trustworthy on its own.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { config, expandUserPath, loadLibraryConfig } from '../../config.js';
import { inferCatalogKind } from '../../catalog-library.js';
import { resolveOpenLibraryPaths } from '../../open-library.js';

/** Fully resolve a path: trim, expand `~`, then follow symlinks. `null` if unusable. */
export function canonicalPath(path: string | null | undefined): string | null {
  if (!path || !String(path).trim()) return null;
  try {
    return realpathSync(expandUserPath(String(path).trim()));
  } catch {
    // realpath throws for a nonexistent path — same as an unusable path.
    return null;
  }
}

/** The containing directory of `path`, if that directory exists. */
export function parentDirIfExists(path: string | null | undefined): string | null {
  const base = canonicalPath(path);
  if (!base) return null;
  const parent = dirname(base);
  try {
    if (parent && statSync(parent).isDirectory()) return parent;
  } catch {
    return null;
  }
  return null;
}

/**
 * Whether `filePath` resolves to a location at or beneath one of `roots`.
 *
 * Comparing *resolved* paths is the point: a symlink inside the cache directory
 * pointing at `/etc/passwd` must not pass, and neither must `../` traversal in an
 * image key. An empty `roots` denies everything rather than allowing everything.
 */
export function isPathUnderAllowedRoots(filePath: string, roots: readonly string[]): boolean {
  if (!filePath || roots.length === 0) return false;
  let realFile: string;
  try {
    realFile = realpathSync(filePath);
  } catch {
    return false;
  }
  for (const root of roots) {
    if (!root) continue;
    if (realFile === root) return true;
    // The separator matters: without it, `/photos-private` would count as being
    // under the root `/photos`.
    if (realFile.startsWith(root + sep)) return true;
  }
  return false;
}

/**
 * Directories a catalog thumbnail is allowed to be served from: the vision cache,
 * the configured NAS mount point, and the folders holding the `.lrcat` files.
 *
 * Order is preserved and duplicates dropped.
 */
export function catalogThumbnailRoots(): string[] {
  const cfg = loadLibraryConfig(config.LT_CONFIG_YAML);
  const { visionCacheDir } = resolveOpenLibraryPaths();
  const roots: string[] = [];

  const vc = canonicalPath(visionCacheDir);
  if (vc) roots.push(vc);

  const mp = (cfg.mountPoint ?? '').trim();
  if (mp) {
    const mpReal = canonicalPath(mp);
    if (mpReal && existsSync(mpReal) && statSync(mpReal).isDirectory()) roots.push(mpReal);
  }

  for (const p of [cfg.catalogPathRaw, cfg.smallCatalogPath]) {
    const trimmed = (p ?? '').trim();
    if (!trimmed) continue;
    const resolved = expandUserPath(trimmed);
    if (inferCatalogKind(resolved) === 'folder') {
      const root = canonicalPath(resolved);
      try {
        if (root && statSync(root).isDirectory() && !roots.includes(root)) roots.push(root);
      } catch {
        /* missing folder */
      }
    } else {
      const par = parentDirIfExists(trimmed);
      if (par && !roots.includes(par)) roots.push(par);
    }
  }

  return [...new Set(roots)];
}
