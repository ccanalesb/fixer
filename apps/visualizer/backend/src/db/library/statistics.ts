/**
 * Catalog statistics queries against `library.db`.
 */
import { statSync } from 'node:fs';
import type { Db } from '../connection.js';

function scalarCount(db: Db, sql: string): number {
  const row = db.prepare(sql).get() as { cnt: number } | undefined;
  return Number(row?.cnt ?? 0);
}

/** Total catalog image count. */
export function getImageCount(db: Db): number {
  return scalarCount(db, 'SELECT COUNT(*) AS cnt FROM images');
}

/**
 * Count catalog images marked as posted to Instagram.
 *
 * Reads the `instagram_posted` column only — it is set manually by the user and is
 * never derived from the retired Instagram dump rows.
 */
export function getPostedImagesCount(db: Db): number {
  return scalarCount(db, 'SELECT COUNT(*) AS cnt FROM images WHERE instagram_posted = 1');
}

export interface CacheStats {
  total_images: number;
  cached_images: number;
  missing: number;
  cache_size_mb: number;
  cache_dir: string;
}

/**
 * Vision cache statistics.
 *
 * `cache_size_mb` sums the on-disk size of each cached JPEG; rows whose file has
 * gone missing contribute nothing rather than throwing.
 */
export function getCacheStats(db: Db, cacheDir: string): CacheStats {
  const total = getImageCount(db);
  const cached = scalarCount(db, 'SELECT COUNT(*) AS cnt FROM vision_cache');

  const rows = db
    .prepare('SELECT compressed_path FROM vision_cache')
    .all() as { compressed_path: string | null }[];
  let bytes = 0;
  for (const row of rows) {
    if (!row.compressed_path) continue;
    try {
      bytes += statSync(row.compressed_path).size;
    } catch {
      // Cached file was removed out from under the row; ignore.
    }
  }

  return {
    total_images: total,
    cached_images: cached,
    missing: total - cached,
    cache_size_mb: bytes / 1024 / 1024,
    cache_dir: cacheDir,
  };
}

/** True when the catalog vision cache has any prepared entries. */
export function hasCachedEntries(db: Db): boolean {
  return scalarCount(db, 'SELECT COUNT(*) AS cnt FROM vision_cache') > 0;
}
