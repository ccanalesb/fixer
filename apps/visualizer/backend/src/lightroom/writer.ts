/**
 * Keyword writes into a live Lightroom `.lrcat`.
 *
 * This is the only code in the backend that mutates a file Lightroom itself owns,
 * so the safety rules are load-bearing rather than defensive:
 *
 *   - refuse to write while Lightroom holds the catalog (`raiseIfCatalogLocked`);
 *     SQLite would happily write into a catalog Lightroom has cached in memory, and
 *     Lightroom would then overwrite it on quit
 *   - take a backup before the first write of the day, and reuse it afterwards
 *   - `AgLibraryKeywordImage.image` references `Adobe_images.id_local`, NOT
 *     `AgLibraryFile.id_local`. Getting that wrong links the keyword to a different
 *     photo, silently.
 */
import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { Db } from '../db/connection.js';

export type KeywordAddResult = 'added' | 'already_present' | 'image_not_found';
export type KeywordRemoveResult = 'removed' | 'not_present' | 'image_not_found';

export const CULL_KEYWORD = 'lrt-cull';
export const AUTO_STARS_KEYWORD = 'lrt-auto-stars';
export const AUTO_REJECT_KEYWORD = 'lrt-auto-reject';

export type PickRatingWriteResult = 'updated' | 'skipped' | 'image_not_found';

export interface LivePickRating {
  pick: number | null;
  rating: number | null;
}

/** One backup per day of activity. See `backupCatalogIfNeeded`. */
export const BACKUP_MIN_INTERVAL_SECONDS = 24 * 60 * 60;

function catalogLockCandidates(catalogPath: string): string[] {
  const dir = dirname(catalogPath);
  const name = basename(catalogPath);
  const stem = name.slice(0, name.length - extname(name).length);
  return [join(dir, `${stem}.lrcat-lock`), join(dir, `${name}.lock`)];
}

/** Throw when Lightroom appears to hold the catalog open. */
export function raiseIfCatalogLocked(catalogPath: string): void {
  for (const path of catalogLockCandidates(catalogPath)) {
    if (existsSync(path)) {
      throw new Error('Close Lightroom before writing to catalog.');
    }
  }
}

/** Whether Lightroom currently holds the catalog (lock file present). */
export function isCatalogLocked(catalogPath: string): boolean {
  for (const path of catalogLockCandidates(catalogPath)) {
    if (existsSync(path)) return true;
  }
  return false;
}

/** Basename used in `AgLibraryFile.baseName` for a library `image_key`. */
export function catalogBaseNameFromImageKey(imageKey: string): string {
  let filename = imageKey;
  if (filename.includes('_')) filename = filename.slice(filename.indexOf('_') + 1);
  const dot = filename.lastIndexOf('.');
  if (dot > 0) filename = filename.slice(0, dot);
  return filename;
}

/**
 * Copy the catalog aside before writing, at most once per interval.
 *
 * The per-write copy this used to do was actively harmful: with `maxBackups = 2`,
 * the second write evicts the only snapshot predating every write we made, so
 * backing up more often left *less* to recover from. A real catalog here is 3 GB, so
 * it also cost seconds and gigabytes per toggle. When a backup younger than
 * `minIntervalSeconds` exists it is reused and nothing is copied; its path is
 * returned either way.
 */
export function backupCatalogIfNeeded(
  catalogPath: string,
  opts: { maxBackups?: number; minIntervalSeconds?: number } = {},
): string {
  const maxBackups = opts.maxBackups ?? 2;
  const minIntervalSeconds = opts.minIntervalSeconds ?? BACKUP_MIN_INTERVAL_SECONDS;
  const parent = dirname(catalogPath);
  const name = basename(catalogPath);
  const prefix = `${name}.backup-`;

  const listBackups = (): { path: string; mtimeMs: number }[] =>
    readdirSync(parent)
      .filter((f) => f.startsWith(prefix))
      .map((f) => join(parent, f))
      .map((p) => ({ path: p, mtimeMs: statSync(p).mtimeMs }))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

  if (minIntervalSeconds > 0) {
    const existing = listBackups();
    const newest = existing.at(-1);
    if (newest && (Date.now() - newest.mtimeMs) / 1000 < minIntervalSeconds) {
      return newest.path;
    }
  }

  for (;;) {
    const existing = listBackups();
    if (existing.length < maxBackups) break;
    try {
      unlinkSync(existing[0]!.path);
    } catch {
      // Already gone; the loop re-reads the directory either way.
      break;
    }
  }

  // Local wall-clock timestamp with colons replaced: `YYYY-MM-DDTHH-MM-SS`.
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const dest = join(parent, `${name}.backup-${ts}`);
  copyFileSync(catalogPath, dest);
  return dest;
}

/**
 * Open the `.lrcat`.
 *
 * Deliberately NOT routed through `openDb`: the Lightroom catalog is not our
 * database. It must not get a WAL-mode switch (which rewrites the file header and
 * would confuse Lightroom) and it has no sqlite-vec tables to load.
 */
export function connectCatalog(catalogPath: string): Db {
  return new Database(catalogPath);
}

export function getKeywordId(conn: Db, keywordName: string): number | null {
  const row = conn
    .prepare('SELECT id_local FROM AgLibraryKeyword WHERE name = ?')
    .get(keywordName) as { id_local: number } | undefined;
  return row ? Number(row.id_local) : null;
}

export function keywordExists(conn: Db, keywordName: string): boolean {
  return getKeywordId(conn, keywordName) !== null;
}

/** Create a keyword row, with a Lightroom-shaped `id_global`. */
export function createKeyword(conn: Db, keywordName: string): number {
  // 32 uppercase hex characters without dashes, the format Lightroom writes.
  const idGlobal = randomUUID().replaceAll('-', '').toUpperCase();
  const info = conn
    .prepare(
      `INSERT INTO AgLibraryKeyword
         (id_global, name, lc_name, dateCreated, keywordType)
       VALUES (?, ?, ?, datetime('now'), 0)`,
    )
    .run(idGlobal, keywordName, keywordName.toLowerCase());
  return Number(info.lastInsertRowid);
}

export function getOrCreateKeyword(conn: Db, keywordName: string): number {
  return getKeywordId(conn, keywordName) ?? createKeyword(conn, keywordName);
}

/**
 * Resolve our `YYYY-MM-DD_basename` key to `Adobe_images.id_local`.
 *
 * The join through `AgLibraryFile` is the whole point: `AgLibraryKeywordImage.image`
 * references `Adobe_images.id_local`, and using the file id instead would attach the
 * keyword to whichever photo happened to share that number.
 */
export function getImageLocalId(conn: Db, imageKey: string): number | null {
  const filename = catalogBaseNameFromImageKey(imageKey);

  const row = conn
    .prepare(
      `SELECT ai.id_local
       FROM AgLibraryFile f
       JOIN Adobe_images ai ON ai.rootFile = f.id_local
       WHERE f.baseName = ?`,
    )
    .get(filename) as { id_local: number } | undefined;
  return row ? Number(row.id_local) : null;
}

export function imageHasKeyword(conn: Db, imageId: number, keywordId: number): boolean {
  const row = conn
    .prepare('SELECT COUNT(*) AS c FROM AgLibraryKeywordImage WHERE image = ? AND tag = ?')
    .get(imageId, keywordId) as { c: number };
  return Number(row.c) > 0;
}

/** Link a keyword to an image. Returns false when the link already existed. */
export function addKeywordToImage(conn: Db, imageId: number, keywordId: number): boolean {
  if (imageHasKeyword(conn, imageId, keywordId)) return false;
  conn
    .prepare('INSERT INTO AgLibraryKeywordImage (image, tag) VALUES (?, ?)')
    .run(imageId, keywordId);
  return true;
}

export function addKeywordByKey(
  conn: Db,
  imageKey: string,
  keywordName: string,
): KeywordAddResult {
  const imageId = getImageLocalId(conn, imageKey);
  if (!imageId) return 'image_not_found';
  const keywordId = getOrCreateKeyword(conn, keywordName);
  return addKeywordToImage(conn, imageId, keywordId) ? 'added' : 'already_present';
}

/** Unlink a keyword from an image. Returns false when it was not linked. */
export function removeKeywordFromImage(conn: Db, imageId: number, keywordId: number): boolean {
  if (!imageHasKeyword(conn, imageId, keywordId)) return false;
  conn
    .prepare('DELETE FROM AgLibraryKeywordImage WHERE image = ? AND tag = ?')
    .run(imageId, keywordId);
  return true;
}

/**
 * Remove a keyword from one image.
 *
 * Leaves the keyword row itself in the catalog when the last image loses it —
 * deleting it would remove a keyword the user may have created.
 */
export function removeKeywordByKey(
  conn: Db,
  imageKey: string,
  keywordName: string,
): KeywordRemoveResult {
  const imageId = getImageLocalId(conn, imageKey);
  if (!imageId) return 'image_not_found';
  const keywordId = getKeywordId(conn, keywordName);
  if (!keywordId) return 'not_present';
  return removeKeywordFromImage(conn, imageId, keywordId) ? 'removed' : 'not_present';
}

export function imageHasKeywordByKey(
  conn: Db,
  imageKey: string,
  keywordName: string,
): boolean {
  const imageId = getImageLocalId(conn, imageKey);
  if (!imageId) return false;
  const keywordId = getKeywordId(conn, keywordName);
  if (!keywordId) return false;
  return imageHasKeyword(conn, imageId, keywordId);
}

export function readPickRating(conn: Db, imageKey: string): LivePickRating | null {
  const imageId = getImageLocalId(conn, imageKey);
  if (!imageId) return null;
  const row = conn
    .prepare('SELECT pick, rating FROM Adobe_images WHERE id_local = ?')
    .get(imageId) as { pick: number | null; rating: number | null } | undefined;
  if (!row) return null;
  return {
    pick: row.pick === null || row.pick === undefined ? null : Number(row.pick),
    rating: row.rating === null || row.rating === undefined ? null : Number(row.rating),
  };
}

/** Set reject flag only when pick is unflagged (0 or NULL). */
export function updatePickIfUnflagged(conn: Db, imageKey: string, pick: -1): PickRatingWriteResult {
  const imageId = getImageLocalId(conn, imageKey);
  if (!imageId) return 'image_not_found';
  const info = conn
    .prepare(
      `UPDATE Adobe_images SET pick = ?
       WHERE id_local = ? AND (pick IS NULL OR pick = 0)`,
    )
    .run(pick, imageId);
  return info.changes > 0 ? 'updated' : 'skipped';
}

/** Set star rating only when rating is unset. Uses REAL values (Lightroom stores 1.0, 2.0, …). */
export function updateRatingIfUnset(conn: Db, imageKey: string, rating: number): PickRatingWriteResult {
  const imageId = getImageLocalId(conn, imageKey);
  if (!imageId) return 'image_not_found';
  const info = conn
    .prepare(`UPDATE Adobe_images SET rating = ? WHERE id_local = ? AND rating IS NULL`)
    .run(rating, imageId);
  return info.changes > 0 ? 'updated' : 'skipped';
}

/** Restore pick when LR still holds the app-written reject. */
export function clearPickIfMatches(conn: Db, imageKey: string, writtenPick: -1): PickRatingWriteResult {
  const imageId = getImageLocalId(conn, imageKey);
  if (!imageId) return 'image_not_found';
  const info = conn
    .prepare(`UPDATE Adobe_images SET pick = 0 WHERE id_local = ? AND pick = ?`)
    .run(imageId, writtenPick);
  return info.changes > 0 ? 'updated' : 'skipped';
}

/** Restore rating when LR still holds the app-written stars. */
export function clearRatingIfMatches(conn: Db, imageKey: string, writtenRating: number): PickRatingWriteResult {
  const imageId = getImageLocalId(conn, imageKey);
  if (!imageId) return 'image_not_found';
  const info = conn
    .prepare(`UPDATE Adobe_images SET rating = NULL WHERE id_local = ? AND rating = ?`)
    .run(imageId, writtenRating);
  return info.changes > 0 ? 'updated' : 'skipped';
}

export interface WritebackCatalogHooks {
  afterPickBeforeKeyword?: () => void;
  afterRatingBeforeKeyword?: () => void;
}

/** Atomic reject write: pick then keyword in one catalog transaction. */
export function writeRejectToCatalog(
  conn: Db,
  imageKey: string,
  hooks: WritebackCatalogHooks = {},
): PickRatingWriteResult {
  const imageId = getImageLocalId(conn, imageKey);
  if (!imageId) return 'image_not_found';
  return conn.transaction(() => {
    const result = updatePickIfUnflagged(conn, imageKey, -1);
    if (result !== 'updated') return result;
    hooks.afterPickBeforeKeyword?.();
    addKeywordByKey(conn, imageKey, AUTO_REJECT_KEYWORD);
    return 'updated' as const;
  })();
}

export function clearRejectFromCatalog(conn: Db, imageKey: string): PickRatingWriteResult {
  const imageId = getImageLocalId(conn, imageKey);
  if (!imageId) return 'image_not_found';
  return conn.transaction(() => {
    clearPickIfMatches(conn, imageKey, -1);
    removeKeywordByKey(conn, imageKey, AUTO_REJECT_KEYWORD);
    return 'updated' as const;
  })();
}

export function undoRejectFromCatalog(
  conn: Db,
  imageKey: string,
  beforePick: number | null,
): PickRatingWriteResult {
  const imageId = getImageLocalId(conn, imageKey);
  if (!imageId) return 'image_not_found';
  return conn.transaction(() => {
    conn.prepare('UPDATE Adobe_images SET pick = ? WHERE id_local = ? AND pick = -1').run(beforePick ?? 0, imageId);
    removeKeywordByKey(conn, imageKey, AUTO_REJECT_KEYWORD);
    return 'updated' as const;
  })();
}

export function writeStarsToCatalog(
  conn: Db,
  imageKey: string,
  rating: number,
  hooks: WritebackCatalogHooks = {},
): PickRatingWriteResult {
  const imageId = getImageLocalId(conn, imageKey);
  if (!imageId) return 'image_not_found';
  return conn.transaction(() => {
    const result = updateRatingIfUnset(conn, imageKey, rating);
    if (result !== 'updated') return result;
    hooks.afterRatingBeforeKeyword?.();
    addKeywordByKey(conn, imageKey, AUTO_STARS_KEYWORD);
    return 'updated' as const;
  })();
}

export function clearStarsFromCatalog(conn: Db, imageKey: string, writtenRating: number): PickRatingWriteResult {
  const imageId = getImageLocalId(conn, imageKey);
  if (!imageId) return 'image_not_found';
  return conn.transaction(() => {
    clearRatingIfMatches(conn, imageKey, writtenRating);
    removeKeywordByKey(conn, imageKey, AUTO_STARS_KEYWORD);
    return 'updated' as const;
  })();
}

export function undoStarsFromCatalog(conn: Db, imageKey: string, beforeRating: number | null): PickRatingWriteResult {
  const imageId = getImageLocalId(conn, imageKey);
  if (!imageId) return 'image_not_found';
  return conn.transaction(() => {
    if (beforeRating === null) {
      conn.prepare('UPDATE Adobe_images SET rating = NULL WHERE id_local = ?').run(imageId);
    } else {
      conn.prepare('UPDATE Adobe_images SET rating = ? WHERE id_local = ?').run(beforeRating, imageId);
    }
    removeKeywordByKey(conn, imageKey, AUTO_STARS_KEYWORD);
    return 'updated' as const;
  })();
}
