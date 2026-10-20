import type { Db } from '../db/connection.js';
import { getWritebackState, type LrWritebackStateRow } from '../db/library/lr-writeback-state.js';
import type { LrWritebackSettings } from '../db/library/lr-writeback-settings.js';
import {
  clearStarsFromCatalog,
  writeStarsToCatalog,
  type LivePickRating,
} from './writer.js';
import { nowIsoUtc } from '../utils/datetime.js';
import {
  desiredStarsRating,
  liveMatchesWritten,
  notFoundState,
  syncWrittenFromLiveCatalog,
  userChangedAfterWrite,
  type ReconcileRunTally,
  type WritebackTrigger,
} from './writeback-shared.js';

export function planStarsPhoto(
  db: Db,
  settings: LrWritebackSettings,
  starsSlug: string | null,
  starsVersionId: number | null,
  live: LivePickRating | null,
  imageKey: string,
  trigger: WritebackTrigger,
  canWrite: boolean,
  conn: Db | null,
  tally: ReconcileRunTally,
): Omit<LrWritebackStateRow, 'updated_at'> | null {
  const row = getWritebackState(db, imageKey, 'stars');
  const rating = desiredStarsRating(db, settings, imageKey, starsSlug);

  if (conn && live === null) {
    return notFoundState(imageKey, 'stars', row, tally);
  }

  if (live && row && userChangedAfterWrite('stars', live, row)) {
    return { ...row, status: 'skipped' };
  }

  if (row?.status === 'undone' && starsVersionId !== null && row.stars_recipe_version_id === starsVersionId) {
    return null;
  }

  if (rating === null) {
    if (row?.status === 'written' && live && liveMatchesWritten('stars', live, row) && conn && canWrite) {
      clearStarsFromCatalog(conn, imageKey, row.written_rating!);
      tally.catalog_cleared_stars += 1;
      return { ...row, status: 'pending', written_rating: null, written_at: null };
    }
    if (row?.status === 'written' && live && !liveMatchesWritten('stars', live, row)) {
      return { ...row, status: 'pending', written_rating: null, written_at: null };
    }
    return null;
  }

  if (live && conn) {
    const synced = syncWrittenFromLiveCatalog(conn, 'stars', imageKey, rating, false, live);
    if (synced && row?.status !== 'written') return { ...synced, stars_recipe_version_id: starsVersionId };
  }

  if (!live) {
    return {
      image_key: imageKey,
      kind: 'stars',
      status: 'pending',
      before_pick: null,
      before_rating: row?.before_rating ?? null,
      written_pick: null,
      written_rating: row?.written_rating ?? null,
      stars_recipe_version_id: row?.stars_recipe_version_id ?? starsVersionId,
      written_at: row?.written_at ?? null,
    };
  }

  if (live.rating !== null) {
    return {
      image_key: imageKey,
      kind: 'stars',
      status: 'skipped',
      before_pick: null,
      before_rating: live.rating,
      written_pick: null,
      written_rating: row?.written_rating ?? null,
      stars_recipe_version_id: row?.stars_recipe_version_id ?? starsVersionId,
      written_at: row?.written_at ?? null,
    };
  }

  if (row?.status === 'written' && liveMatchesWritten('stars', live, row) && row.written_rating === rating) {
    return null;
  }

  if (!canWrite || !conn || trigger === 'switch_on') {
    return {
      image_key: imageKey,
      kind: 'stars',
      status: 'pending',
      before_pick: null,
      before_rating: null,
      written_pick: null,
      written_rating: row?.written_rating ?? null,
      stars_recipe_version_id: starsVersionId,
      written_at: row?.written_at ?? null,
    };
  }

  const result = writeStarsToCatalog(conn, imageKey, rating);
  if (result === 'image_not_found') return notFoundState(imageKey, 'stars', row, tally);
  if (result !== 'updated') {
    return {
      image_key: imageKey,
      kind: 'stars',
      status: 'skipped',
      before_pick: null,
      before_rating: null,
      written_pick: null,
      written_rating: row?.written_rating ?? null,
      stars_recipe_version_id: starsVersionId,
      written_at: row?.written_at ?? null,
    };
  }
  tally.catalog_updated_stars += 1;
  return {
    image_key: imageKey,
    kind: 'stars',
    status: 'written',
    before_pick: null,
    before_rating: null,
    written_pick: null,
    written_rating: rating,
    stars_recipe_version_id: starsVersionId,
    written_at: nowIsoUtc(),
  };
}
