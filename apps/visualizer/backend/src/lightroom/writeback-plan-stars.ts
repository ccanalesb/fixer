import { getWritebackState, type LrWritebackStateRow } from '../db/library/lr-writeback-state.js';
import { nowIsoUtc } from '../utils/datetime.js';
import {
  adoptWrittenStarsState,
  catalogHasAppStars,
  liveMatchesWritten,
  notFoundState,
  stayPendingOnFileWriteFailure,
  syncWrittenFromLiveCatalog,
  userChangedAfterWrite,
  type WritebackPlanPhoto,
  type WritebackPlanRun,
} from './writeback-shared.js';

export async function planStarsPhoto(
  run: WritebackPlanRun,
  photo: WritebackPlanPhoto,
): Promise<Omit<LrWritebackStateRow, 'updated_at'> | null> {
  const { db, catalog, tally, starsVersionId } = run;
  const { imageKey, live, writeNow, decision } = photo;
  const row = getWritebackState(db, imageKey, 'stars');
  const rating = decision.stars.rating;

  if (catalog && live === null) {
    return notFoundState(imageKey, 'stars', row, tally);
  }

  if (live && row && userChangedAfterWrite('stars', live, row)) {
    if (live.rating !== null) return { ...row, status: 'skipped' };
    // Clearing the app's stars in Lightroom is an undo: not written again until the profile changes.
    if (catalog && writeNow) await Promise.resolve(catalog.removeAutoStarsKeyword(imageKey));
    return { ...row, status: 'undone', written_rating: null, written_at: null };
  }

  if (row?.status === 'undone' && starsVersionId !== null && row.stars_profile_version_id === starsVersionId) {
    return null;
  }

  if (rating === null) {
    if (row?.status === 'written' && live && liveMatchesWritten('stars', live, row) && catalog && writeNow) {
      await Promise.resolve(catalog.clearStars(imageKey, row.written_rating!));
      tally.catalog_cleared_stars += 1;
      return { ...row, status: 'pending', written_rating: null, written_at: null };
    }
    if (row?.status === 'written' && live && !liveMatchesWritten('stars', live, row)) {
      return { ...row, status: 'pending', written_rating: null, written_at: null };
    }
    return null;
  }

  if (live && catalog && rating !== null) {
    const synced = syncWrittenFromLiveCatalog(
      catalog,
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
    catalog &&
    writeNow &&
    row?.before_rating === null &&
    row.written_rating !== null &&
    row.written_rating !== rating &&
    catalogHasAppStars(catalog, imageKey, row.written_rating)
  ) {
    const result = await Promise.resolve(catalog.replaceStars(imageKey, row.written_rating, rating));
    if (result === 'mtime_conflict' || result === 'readonly_error') {
      return stayPendingOnFileWriteFailure(imageKey, 'stars', row, tally, result, starsVersionId);
    }
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
    if (catalog && rating !== null && catalogHasAppStars(catalog, imageKey, rating)) {
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

  if (!writeNow || !catalog) {
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
  const result = await Promise.resolve(catalog.writeStars(imageKey, rating));
  if (result === 'image_not_found') return notFoundState(imageKey, 'stars', row, tally);
  if (result === 'mtime_conflict' || result === 'readonly_error') {
    return stayPendingOnFileWriteFailure(imageKey, 'stars', row, tally, result, starsVersionId);
  }
  if (result !== 'updated') {
    if (catalogHasAppStars(catalog, imageKey, rating)) {
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
