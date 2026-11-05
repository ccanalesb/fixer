/**
 * Vision image caching.
 *
 * The cache is what makes the whole pipeline usable offline: the originals live
 * on a NAS, and a 1024px JPEG per image is ~50–135 KB, so the entire 43,000-image
 * catalog fits in about 4 GB locally. Describe, score and frame-substance
 * detection all run off it, and the NAS is only needed to *build* it.
 */
import { copyFile, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { config, loadLibraryConfig } from '../config.js';
import { resolveOpenLibraryPaths } from '../open-library.js';
import type { Db } from '../db/connection.js';
import { getCatalogImagesMissingCache, getImageOrientation } from '../db/library/catalog.js';
import {
  getVisionCachedImage,
  VISION_CACHE_OVERSIZED_SENTINEL,
  type VisionCacheRow,
} from '../db/library/vision-cache.js';
import { libraryWrite } from '../db/library/write.js';
import { nowIsoLocal } from '../utils/datetime.js';
import { resolveCatalogImageFilePath } from '../utils/path-resolve.js';
import { compressImage, getViewablePathManaged, isRawPath, isVideoPath } from '../imaging/image-prep.js';
import {
  normalizeOrientation,
  remainingOrientation,
  UPRIGHT,
  type OrientationCode,
} from '../imaging/orientation.js';
import { phashFromFile } from '../imaging/phash-file.js';

/**
 * A working cached JPEG is 50–135 KB. Anything much larger means compression
 * failed or the original is pathological, and caching it would waste the disk
 * the cache exists to save.
 */
export const MAX_CACHED_IMAGE_KB = 512;

/** Whether a path is under the system temp directory, i.e. ours to move. */
function isPathInTempDir(path: string): boolean {
  if (!path) return false;
  const tmp = resolve(tmpdir());
  const ap = resolve(path);
  return ap === tmp || ap.startsWith(tmp + sep);
}

async function sizeKb(path: string): Promise<number> {
  return (await stat(path)).size / 1024;
}

/**
 * Move or copy `source` into the cache path without clobbering user-owned files.
 *
 * A temp file is moved (cheap); anything else — a sidecar JPEG next to the
 * user's RAW, say — is *copied*, because moving it would delete their file.
 * The cross-device fallback exists because the temp dir and the cache dir are
 * often on different volumes.
 */
async function placeIntoCache(
  source: string,
  targetPath: string,
  tempFiles: Set<string>,
): Promise<void> {
  if (isPathInTempDir(source)) {
    try {
      await rename(source, targetPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      await copyFile(source, targetPath);
      await unlink(source).catch(() => undefined);
    }
    tempFiles.delete(source);
  } else {
    await copyFile(source, targetPath);
  }
}

/** Persist a cache row. Wrapped in `libraryWrite` because it is on a hot path. */
function storeVisionCachedImage(
  db: Db,
  catalogKey: string,
  compressedPath: string,
  phash: string | null,
  originalMtime: number,
  orientation: OrientationCode,
): void {
  libraryWrite(db, () => {
    db.prepare(
      `
      INSERT INTO vision_cache (key, compressed_path, phash, compressed_at, original_mtime, orientation)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
          compressed_path=excluded.compressed_path, phash=excluded.phash,
          compressed_at=excluded.compressed_at, original_mtime=excluded.original_mtime,
          orientation=excluded.orientation
      `,
    ).run(catalogKey, compressedPath, phash, nowIsoLocal(), originalMtime, orientation);
  });
}

/** Whether a cache row's JPEG is turned the way the photo currently shows in Lightroom. */
function cacheOrientationCurrent(db: Db, catalogKey: string, cached: VisionCacheRow): boolean {
  return normalizeOrientation(cached.orientation) === getImageOrientation(db, catalogKey);
}

/**
 * Whether the cached entry is still valid, by orientation and original mtime.
 *
 * Three special cases, all of them earned. A video is never valid — it cannot be
 * described. A RAW whose cache path *is* the original means a failed conversion,
 * so it must be retried. And the oversized sentinel is invalid for a RAW because
 * a later sidecar may have appeared.
 */
export async function isVisionCacheValid(
  db: Db,
  catalogKey: string,
  originalPath: string,
): Promise<boolean> {
  const cached = getVisionCachedImage(db, catalogKey);
  if (!cached) return false;
  if (!cacheOrientationCurrent(db, catalogKey, cached)) return false;
  const comp = cached.compressed_path ?? '';

  if (isVideoPath(originalPath)) return false;

  if (isRawPath(originalPath)) {
    if (comp === originalPath) return false;
    if (comp === VISION_CACHE_OVERSIZED_SENTINEL) return false;
  }

  const currentMtime = await stat(originalPath)
    .then((s) => s.mtimeMs / 1000)
    .catch(() => null);
  if (currentMtime === null) return false;

  if (comp === VISION_CACHE_OVERSIZED_SENTINEL) {
    return cached.original_mtime === currentMtime;
  }
  if (!comp || !existsSync(comp)) return false;
  return cached.original_mtime === currentMtime;
}

/**
 * The cached compressed path, building it if needed. `null` when unusable.
 *
 * Writes the compressed file to a temp path first and then moves it into place,
 * so a crash mid-write cannot leave a truncated JPEG in the cache that every
 * later run would happily reuse.
 */
export async function getOrCreateCachedImage(
  db: Db,
  catalogKey: string,
  originalPath: string,
): Promise<string | null> {
  const cfg = loadLibraryConfig(config.LT_CONFIG_YAML);
  const { visionCacheDir: cacheDir } = resolveOpenLibraryPaths();
  const orientation = getImageOrientation(db, catalogKey);
  // Cache disabled: compress on the fly and hand back a temp file.
  if (!cfg.visionCacheEnabled) return compressImage(originalPath, { orientation });

  await mkdir(cacheDir, { recursive: true });

  if (await isVisionCacheValid(db, catalogKey, originalPath)) {
    const cached = getVisionCachedImage(db, catalogKey);
    if (cached) {
      const path = cached.compressed_path;
      if (path === VISION_CACHE_OVERSIZED_SENTINEL) return null;
      return path;
    }
  }

  // A key can contain a slash in principle; flatten it so the cache stays one
  // directory deep.
  const targetPath = join(cacheDir, `${catalogKey.replaceAll('/', '_')}.jpg`);
  const tempFiles = new Set<string>();

  try {
    const viewable = await getViewablePathManaged(originalPath);
    if (viewable.isTemp) tempFiles.add(viewable.path);

    const compressed = await compressImage(viewable.path, {
      orientation: remainingOrientation(orientation, viewable.orientation),
    });
    if (compressed !== viewable.path) tempFiles.add(compressed);

    // Hashed from the *viewable* image, not the compressed one: the phash has to
    // describe the photograph, and compression is lossy.
    const phash = await phashFromFile(viewable.path).catch(() => null);
    const originalMtime = (await stat(originalPath)).mtimeMs / 1000;

    if (compressed === viewable.path && viewable.path === originalPath) {
      // Neither conversion nor compression did anything — the original is
      // already a plain JPEG, or both steps failed.
      if ((await sizeKb(originalPath)) > MAX_CACHED_IMAGE_KB) {
        storeVisionCachedImage(
          db,
          catalogKey,
          VISION_CACHE_OVERSIZED_SENTINEL,
          null,
          originalMtime,
          orientation,
        );
        return null;
      }
      // The original's own pixels, unturned: a turned photo stays invalid and is
      // retried, rather than being described sideways.
      storeVisionCachedImage(db, catalogKey, originalPath, phash, originalMtime, UPRIGHT);
      return originalPath;
    }

    const source = compressed !== viewable.path ? compressed : viewable.path;
    await placeIntoCache(source, targetPath, tempFiles);

    if ((await sizeKb(targetPath)) > MAX_CACHED_IMAGE_KB) {
      await unlink(targetPath).catch(() => undefined);
      storeVisionCachedImage(
        db,
        catalogKey,
        VISION_CACHE_OVERSIZED_SENTINEL,
        null,
        originalMtime,
        orientation,
      );
      return null;
    }

    storeVisionCachedImage(db, catalogKey, targetPath, phash, originalMtime, orientation);
    return targetPath;
  } finally {
    for (const tf of tempFiles) {
      if (tf && existsSync(tf)) await unlink(tf).catch(() => undefined);
    }
  }
}

/**
 * The image to feed a vision op, preferring the local cache.
 *
 * `silentCompression` is true when the returned path is an already-compressed
 * cache file that must not be recompressed — re-running compression on a resume
 * only burns CPU and prints noise.
 *
 * The unreachable-original branch is the offline contract: with the NAS
 * unmounted, describe and score still run entirely off the local cache.
 */
export async function resolveVisionImage(
  db: Db,
  catalogKey: string,
  originalPath: string,
): Promise<{ path: string | null; silentCompression: boolean }> {
  if (existsSync(originalPath)) {
    const cached = await getOrCreateCachedImage(db, catalogKey, originalPath);
    if (cached && existsSync(cached)) return { path: cached, silentCompression: true };
    return { path: null, silentCompression: false };
  }

  const rec = getVisionCachedImage(db, catalogKey);
  const cachePath = rec?.compressed_path ?? null;
  if (
    rec &&
    // Turned the wrong way, it would be described sideways; wait for the NAS.
    cacheOrientationCurrent(db, catalogKey, rec) &&
    cachePath &&
    cachePath !== VISION_CACHE_OVERSIZED_SENTINEL &&
    existsSync(cachePath)
  ) {
    return { path: cachePath, silentCompression: true };
  }
  return { path: null, silentCompression: false };
}

/** The pre-computed phash for a key, when the cache holds one. */
export function getCachedPhash(db: Db, catalogKey: string): string | null {
  const cached = getVisionCachedImage(db, catalogKey);
  return cached?.phash || null;
}

export interface WarmCacheResult {
  processed: number;
  skipped: number;
  errors: number;
}

/**
 * Build cache entries for catalog images that have none. Backs `enrich-catalog`.
 *
 * Sequential: the work is RAW decoding and JPEG compression, which `sharp` and
 * `libraw-wasm` already thread internally, and the originals are on a NAS where
 * concurrent readers make it slower rather than faster.
 *
 * An unreachable original is `skipped`, not an error — with the NAS unmounted
 * every image is unreachable, and that is a mount problem the counts should say
 * plainly rather than 43,000 failures. An image that is reachable but yields no
 * cache entry is an `error`, which includes the oversized ones: they return the
 * sentinel every run, so a steady handful of errors here is expected.
 */
export async function warmVisionCache(db: Db, limit?: number | null): Promise<WarmCacheResult> {
  let images = getCatalogImagesMissingCache(db);
  // A limit of 0 means "no limit".
  if (limit) images = images.slice(0, limit);

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const record of images) {
    const key = record['key'];
    if (!key || typeof key !== 'string') {
      skipped += 1;
      continue;
    }

    const raw = record['filepath'];
    const filepath = resolveCatalogImageFilePath(typeof raw === 'string' ? raw : '');
    if (!filepath) {
      skipped += 1;
      continue;
    }

    try {
      const cachedPath = await getOrCreateCachedImage(db, key, filepath);
      if (cachedPath) processed += 1;
      else errors += 1;
    } catch {
      errors += 1;
    }
  }

  return { processed, skipped, errors };
}

/** Write bytes into the cache directory directly. Used by the cache-build job. */
export async function writeCacheFile(name: string, data: Buffer): Promise<string> {
  const { visionCacheDir } = resolveOpenLibraryPaths();
  await mkdir(visionCacheDir, { recursive: true });
  const path = isAbsolute(name) ? name : join(visionCacheDir, name);
  await writeFile(path, data);
  return path;
}
