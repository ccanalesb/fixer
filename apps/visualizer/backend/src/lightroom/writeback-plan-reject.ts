import { getWritebackState, type LrWritebackStateRow } from '../db/library/lr-writeback-state.js';
import { nowIsoUtc } from '../utils/datetime.js';
import {
  adoptWrittenRejectState,
  catalogHasAppReject,
  liveMatchesWritten,
  notFoundState,
  syncWrittenFromLiveCatalog,
  userChangedAfterWrite,
  type WritebackPlanPhoto,
  type WritebackPlanRun,
} from './writeback-shared.js';

export async function planRejectPhoto(
  run: WritebackPlanRun,
  photo: WritebackPlanPhoto,
): Promise<Omit<LrWritebackStateRow, 'updated_at'> | null> {
  const { db, catalog, tally } = run;
  const { imageKey, live, writeNow, decision } = photo;
  const row = getWritebackState(db, imageKey, 'reject');
  const want = decision.reject.want;

  if (catalog && live === null) {
    return notFoundState(imageKey, 'reject', row, tally);
  }

  if (live && row && userChangedAfterWrite('reject', live, row)) {
    if ((live.pick ?? 0) !== 0) return { ...row, status: 'skipped' };
    // Unflagging the app's reject in Lightroom is an undo: never written again.
    if (catalog && writeNow) await Promise.resolve(catalog.removeAutoRejectKeyword(imageKey));
    return { ...row, status: 'undone', written_pick: null, written_at: null };
  }

  if (!want) {
    if (catalog && writeNow && catalogHasAppReject(catalog, imageKey)) {
      await Promise.resolve(catalog.clearReject(imageKey));
      tally.catalog_cleared_reject += 1;
      if (row) return { ...row, status: 'pending', written_pick: null, written_at: null };
      return null;
    }
    if (row?.status === 'written' && live && liveMatchesWritten('reject', live, row) && catalog && writeNow) {
      await Promise.resolve(catalog.clearReject(imageKey));
      tally.catalog_cleared_reject += 1;
      return { ...row, status: 'pending', written_pick: null, written_at: null };
    }
    if (row?.status === 'written' && live && !liveMatchesWritten('reject', live, row)) {
      return { ...row, status: 'pending', written_pick: null, written_at: null };
    }
    return null;
  }

  if (row?.status === 'undone') return null;

  if (live && catalog) {
    const synced = syncWrittenFromLiveCatalog(
      catalog,
      'reject',
      imageKey,
      null,
      true,
      live,
      null,
      row?.before_pick ?? live.pick ?? 0,
    );
    if (synced && row?.status !== 'written') return synced;
  }

  if (!live) {
    return {
      image_key: imageKey,
      kind: 'reject',
      status: 'pending',
      before_pick: row?.before_pick ?? null,
      before_rating: null,
      written_pick: row?.written_pick ?? null,
      written_rating: null,
      stars_profile_version_id: null,
      written_at: row?.written_at ?? null,
    };
  }

  if (live.pick !== null && live.pick !== 0) {
    if (live.pick === -1 && catalog && catalogHasAppReject(catalog, imageKey) && want) {
      return adoptWrittenRejectState(imageKey, row, row?.before_pick ?? 0);
    }
    return {
      image_key: imageKey,
      kind: 'reject',
      status: 'skipped',
      before_pick: live.pick,
      before_rating: null,
      written_pick: row?.written_pick ?? null,
      written_rating: null,
      stars_profile_version_id: null,
      written_at: row?.written_at ?? null,
    };
  }

  if (row?.status === 'written' && liveMatchesWritten('reject', live, row)) return null;

  if (!writeNow || !catalog) {
    return {
      image_key: imageKey,
      kind: 'reject',
      status: 'pending',
      before_pick: live.pick ?? 0,
      before_rating: null,
      written_pick: row?.written_pick ?? null,
      written_rating: null,
      stars_profile_version_id: null,
      written_at: row?.written_at ?? null,
    };
  }

  const beforePick = live.pick ?? 0;
  const result = await Promise.resolve(catalog.writeReject(imageKey));
  if (result === 'image_not_found') return notFoundState(imageKey, 'reject', row, tally);
  if (result !== 'updated') {
    if (catalogHasAppReject(catalog, imageKey)) {
      return adoptWrittenRejectState(imageKey, row, beforePick);
    }
    return {
      image_key: imageKey,
      kind: 'reject',
      status: 'skipped',
      before_pick: beforePick,
      before_rating: null,
      written_pick: row?.written_pick ?? null,
      written_rating: null,
      stars_profile_version_id: null,
      written_at: row?.written_at ?? null,
    };
  }
  tally.catalog_updated_reject += 1;
  return {
    image_key: imageKey,
    kind: 'reject',
    status: 'written',
    before_pick: beforePick,
    before_rating: null,
    written_pick: -1,
    written_rating: null,
    stars_profile_version_id: null,
    written_at: nowIsoUtc(),
  };
}
