import type { Db } from '../db/connection.js';
import { getWritebackState, type LrWritebackStateRow } from '../db/library/lr-writeback-state.js';
import type { LrWritebackSettings } from '../db/library/lr-writeback-settings.js';
import {
  AUTO_STARS_KEYWORD,
  clearStarsFromCatalog,
  removeKeywordByKey,
  replaceRatingIfMatches,
  writeStarsToCatalog,
  type LivePickRating,
} from './writer.js';
import { nowIsoUtc } from '../utils/datetime.js';
import {
  adoptWrittenStarsState,
  catalogHasAppStars,
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
    if (live.rating !== null) return { ...row, status: 'skipped' };
    // Clearing the app's stars in Lightroom is an undo: not written again until the profile changes.
    if (conn && canWrite) removeKeywordByKey(conn, imageKey, AUTO_STARS_KEYWORD);
    return { ...row, status: 'undone', written_rating: null, written_at: null };
  }

  if (row?.status === 'undone' && starsVersionId !== null && row.stars_profile_version_id === starsVersionId) {
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

  if (live && conn && rating !== null) {
    const synced = syncWrittenFromLiveCatalog(
      conn,
      'stars',
      imageKey,
      rating,
      false,
      live,
      starsVersionId,
      null,
      row?.before_rating ?? null,
    );
    if (synced && row?.status !== 'written') return synced;
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
      stars_profile_version_id: row?.stars_profile_version_id ?? starsVersionId,
      written_at: row?.written_at ?? null,
    };
  }

  if (row?.status === 'written' && liveMatchesWritten('stars', live, row) && row.written_rating === rating) {
    return null;
  }

  // Only stars the app put on an unrated photo are its own to replace; the user's stays theirs under the keyword.
  if (
    conn &&
    canWrite &&
    row?.before_rating === null &&
    row.written_rating !== null &&
    row.written_rating !== rating &&
    catalogHasAppStars(conn, imageKey, row.written_rating)
  ) {
    const result = replaceRatingIfMatches(conn, imageKey, row.written_rating, rating);
    if (result === 'updated') {
      tally.catalog_updated_stars += 1;
      return {
        image_key: imageKey,
        kind: 'stars',
        status: 'written',
        before_pick: null,
        before_rating: null,
        written_pick: null,
        written_rating: rating,
        stars_profile_version_id: starsVersionId,
        written_at: nowIsoUtc(),
      };
    }
  }

  if (live.rating !== null) {
    if (conn && rating !== null && catalogHasAppStars(conn, imageKey, rating)) {
      return adoptWrittenStarsState(imageKey, rating, starsVersionId, row);
    }
    if (rating !== null && live.rating !== rating) {
      return {
        image_key: imageKey,
        kind: 'stars',
        status: 'skipped',
        before_pick: null,
        before_rating: row?.written_at ? row.before_rating : live.rating,
        written_pick: null,
        written_rating: row?.written_rating ?? null,
        stars_profile_version_id: row?.stars_profile_version_id ?? starsVersionId,
        written_at: row?.written_at ?? null,
      };
    }
  }

  if (!canWrite || !conn) {
    return {
      image_key: imageKey,
      kind: 'stars',
      status: 'pending',
      before_pick: null,
      before_rating: null,
      written_pick: null,
      written_rating: row?.written_rating ?? null,
      stars_profile_version_id: starsVersionId,
      written_at: row?.written_at ?? null,
    };
  }

  const beforeRating = live.rating;
  const result = writeStarsToCatalog(conn, imageKey, rating);
  if (result === 'image_not_found') return notFoundState(imageKey, 'stars', row, tally);
  if (result !== 'updated') {
    if (conn && catalogHasAppStars(conn, imageKey, rating)) {
      return adoptWrittenStarsState(imageKey, rating, starsVersionId, row);
    }
    return {
      image_key: imageKey,
      kind: 'stars',
      status: 'skipped',
      before_pick: null,
      before_rating: null,
      written_pick: null,
      written_rating: row?.written_rating ?? null,
      stars_profile_version_id: starsVersionId,
      written_at: row?.written_at ?? null,
    };
  }
  tally.catalog_updated_stars += 1;
  return {
    image_key: imageKey,
    kind: 'stars',
    status: 'written',
    before_pick: null,
    before_rating: beforeRating,
    written_pick: null,
    written_rating: rating,
    stars_profile_version_id: starsVersionId,
    written_at: nowIsoUtc(),
  };
}
