import type { Db } from '../db/connection.js';
import { getWritebackState, type LrWritebackStateRow } from '../db/library/lr-writeback-state.js';
import type { CullVerdictRow } from '../db/library/cull-verdicts.js';
import type { LrWritebackSettings } from '../db/library/lr-writeback-settings.js';
import { clearRejectFromCatalog, writeRejectToCatalog, type LivePickRating } from './writer.js';
import { nowIsoUtc } from '../utils/datetime.js';
import {
  desiredReject,
  liveMatchesWritten,
  notFoundState,
  syncWrittenFromLiveCatalog,
  userChangedAfterWrite,
  type ReconcileRunTally,
  type WritebackTrigger,
} from './writeback-shared.js';

export function planRejectPhoto(
  db: Db,
  settings: LrWritebackSettings,
  verdict: CullVerdictRow | null,
  live: LivePickRating | null,
  imageKey: string,
  trigger: WritebackTrigger,
  canWrite: boolean,
  conn: Db | null,
  tally: ReconcileRunTally,
): Omit<LrWritebackStateRow, 'updated_at'> | null {
  const row = getWritebackState(db, imageKey, 'reject');
  const want = desiredReject(settings, verdict);

  if (conn && live === null) {
    return notFoundState(imageKey, 'reject', row, tally);
  }

  if (live && row && userChangedAfterWrite('reject', live, row)) {
    return { ...row, status: 'skipped' };
  }

  if (!want) {
    if (row?.status === 'written' && live && liveMatchesWritten('reject', live, row) && conn && canWrite) {
      clearRejectFromCatalog(conn, imageKey);
      tally.catalog_cleared_reject += 1;
      return { ...row, status: 'pending', written_pick: null, written_at: null };
    }
    if (row?.status === 'written' && live && !liveMatchesWritten('reject', live, row)) {
      return { ...row, status: 'pending', written_pick: null, written_at: null };
    }
    return null;
  }

  if (row?.status === 'undone') return null;

  if (live && conn) {
    const synced = syncWrittenFromLiveCatalog(conn, 'reject', imageKey, null, true, live);
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
      stars_recipe_version_id: null,
      written_at: row?.written_at ?? null,
    };
  }

  if (live.pick !== null && live.pick !== 0) {
    return {
      image_key: imageKey,
      kind: 'reject',
      status: 'skipped',
      before_pick: live.pick,
      before_rating: null,
      written_pick: row?.written_pick ?? null,
      written_rating: null,
      stars_recipe_version_id: null,
      written_at: row?.written_at ?? null,
    };
  }

  if (row?.status === 'written' && liveMatchesWritten('reject', live, row)) return null;

  if (!canWrite || !conn || trigger === 'switch_on') {
    return {
      image_key: imageKey,
      kind: 'reject',
      status: 'pending',
      before_pick: live.pick ?? 0,
      before_rating: null,
      written_pick: row?.written_pick ?? null,
      written_rating: null,
      stars_recipe_version_id: null,
      written_at: row?.written_at ?? null,
    };
  }

  const beforePick = live.pick ?? 0;
  const result = writeRejectToCatalog(conn, imageKey);
  if (result === 'image_not_found') return notFoundState(imageKey, 'reject', row, tally);
  if (result !== 'updated') {
    return {
      image_key: imageKey,
      kind: 'reject',
      status: 'skipped',
      before_pick: beforePick,
      before_rating: null,
      written_pick: row?.written_pick ?? null,
      written_rating: null,
      stars_recipe_version_id: null,
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
    stars_recipe_version_id: null,
    written_at: nowIsoUtc(),
  };
}
