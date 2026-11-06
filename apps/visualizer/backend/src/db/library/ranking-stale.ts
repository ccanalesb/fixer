/**
 * Tracks catalog changes picked up by any sync so the cache check can redo stacks
 * and similarity after standalone syncs, interrupted chains, or CLI runs.
 */
import type { Db } from '../connection.js';
import { nowIsoUtc } from '../../utils/datetime.js';
import { getLibraryMeta, setLibraryMeta } from './bootstrap.js';
import { libraryWrite } from './write.js';

export const CHANGED_SINCE_RANKING_META_KEY = 'changed_since_ranking_at';

export function hasChangedSinceRanking(db: Db): boolean {
  return getLibraryMeta(db, CHANGED_SINCE_RANKING_META_KEY) !== null;
}

export function markChangedSinceRanking(db: Db): void {
  setLibraryMeta(db, CHANGED_SINCE_RANKING_META_KEY, nowIsoUtc());
}

export function clearChangedSinceRanking(db: Db): void {
  db.prepare('DELETE FROM library_meta WHERE key = ?').run(CHANGED_SINCE_RANKING_META_KEY);
}

export interface FolderSyncRankingSignals {
  added: number;
  changed: number;
  metadata_changed: number;
  moved: number;
  newly_gone: number;
}

export function noteRankingStaleAfterFolderSync(db: Db, report: FolderSyncRankingSignals): void {
  if (
    report.added > 0 ||
    report.changed > 0 ||
    report.metadata_changed > 0 ||
    report.moved > 0 ||
    report.newly_gone > 0
  ) {
    libraryWrite(db, () => markChangedSinceRanking(db));
  }
}

export function noteRankingStaleAfterLightroomSync(
  db: Db,
  added: number,
  newlyRemovedFromCatalog: number,
): void {
  if (added > 0 || newlyRemovedFromCatalog > 0) {
    libraryWrite(db, () => markChangedSinceRanking(db));
  }
}

/** Photos indexed from Lightroom whose id no longer appears in the catalog. */
export function markNewlyRemovedLightroomPhotos(db: Db, catalogIds: ReadonlySet<number>): number {
  const rows = db
    .prepare(
      `SELECT key, id, catalog_missing_since FROM images
       WHERE id IS NOT NULL AND TRIM(id) != ''`,
    )
    .all() as { key: string; id: string; catalog_missing_since: string | null }[];
  const sinceIso = nowIsoUtc();
  let newly = 0;
  libraryWrite(db, () => {
    const markGone = db.prepare(
      'UPDATE images SET catalog_missing_since = ? WHERE key = ? AND catalog_missing_since IS NULL',
    );
    const clearGone = db.prepare(
      'UPDATE images SET catalog_missing_since = NULL WHERE key = ? AND catalog_missing_since IS NOT NULL',
    );
    for (const row of rows) {
      const text = String(row.id).trim();
      if (!/^[+-]?\d+$/.test(text)) continue;
      const id = Number(text);
      if (catalogIds.has(id)) {
        // Back in the catalog: no longer gone.
        clearGone.run(row.key);
        continue;
      }
      const changed = markGone.run(sinceIso, row.key).changes;
      newly += changed;
    }
  });
  return newly;
}
