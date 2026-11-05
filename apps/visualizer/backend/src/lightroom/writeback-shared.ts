import type { WritebackKind } from './writeback-types.js';
import { listDecidedCullImageKeys } from '../db/library/cull-verdicts.js';
import type { LrWritebackStateRow } from '../db/library/lr-writeback-state.js';
import type { Db } from '../db/connection.js';
import type { WritebackDecision } from './writeback-decision.js';
import type { LivePickRating, WritebackCatalogWriter } from './writeback-catalog-writer.js';
import { nowIsoUtc } from '../utils/datetime.js';

export type WritebackTrigger =
  | 'cull_job_complete'
  | 'redecide_complete'
  | 'sent_by_hand'
  | 'write_pending'
  | 'job';

export interface ReconcileOptions {
  trigger: WritebackTrigger;
  imageKeys?: readonly string[];
  catalogPath?: string;
  isCancelled?: () => boolean | Promise<boolean>;
  onProgress?: (pct: number, message: string) => void;
}

export interface ReconcileRunTally {
  catalog_updated_stars: number;
  catalog_updated_reject: number;
  catalog_cleared_reject: number;
  catalog_cleared_stars: number;
  image_not_found_stars: number;
  image_not_found_reject: number;
}

export function emptyRunTally(): ReconcileRunTally {
  return {
    catalog_updated_stars: 0,
    catalog_updated_reject: 0,
    catalog_cleared_reject: 0,
    catalog_cleared_stars: 0,
    image_not_found_stars: 0,
    image_not_found_reject: 0,
  };
}

export interface WritebackPlanRun {
  db: Db;
  catalog: WritebackCatalogWriter | null;
  tally: ReconcileRunTally;
  starsVersionId: number | null;
}

export interface WritebackPlanPhoto {
  imageKey: string;
  live: LivePickRating | null;
  writeNow: boolean;
  decision: WritebackDecision;
}

export function listVerdictImageKeys(db: Db, keys?: readonly string[]): string[] {
  if (keys?.length) return [...keys];
  return listDecidedCullImageKeys(db);
}

export function liveMatchesWritten(kind: WritebackKind, live: LivePickRating, row: LrWritebackStateRow): boolean {
  if (kind === 'reject') return live.pick === row.written_pick;
  return live.rating === row.written_rating;
}

export function userChangedAfterWrite(kind: WritebackKind, live: LivePickRating, row: LrWritebackStateRow): boolean {
  if (row.status !== 'written') return false;
  return !liveMatchesWritten(kind, live, row);
}

export function catalogHasAppReject(catalog: WritebackCatalogWriter, imageKey: string): boolean {
  return catalog.hasAppReject(imageKey);
}

export function catalogHasAppStars(catalog: WritebackCatalogWriter, imageKey: string, rating: number): boolean {
  return catalog.hasAppStars(imageKey, rating);
}

export function syncWrittenFromLiveCatalog(
  catalog: WritebackCatalogWriter,
  kind: WritebackKind,
  imageKey: string,
  desiredRating: number | null,
  wantReject: boolean,
  live: LivePickRating,
  starsProfileVersionId: number | null = null,
  beforePick: number | null = null,
  beforeRating: number | null = null,
): Omit<LrWritebackStateRow, 'updated_at'> | null {
  if (kind === 'stars' && desiredRating !== null && live.rating === desiredRating) {
    if (!catalog.hasAppStars(imageKey, desiredRating)) return null;
    return {
      image_key: imageKey,
      kind: 'stars',
      status: 'written',
      before_pick: null,
      before_rating: beforeRating,
      written_pick: null,
      written_rating: desiredRating,
      stars_profile_version_id: starsProfileVersionId,
      written_at: nowIsoUtc(),
    };
  }
  if (kind === 'reject' && wantReject && live.pick === -1) {
    if (!catalog.hasAppReject(imageKey)) return null;
    return {
      image_key: imageKey,
      kind: 'reject',
      status: 'written',
      before_pick: beforePick ?? 0,
      before_rating: null,
      written_pick: -1,
      written_rating: null,
      stars_profile_version_id: null,
      written_at: nowIsoUtc(),
    };
  }
  return null;
}

export function adoptWrittenRejectState(
  imageKey: string,
  row: LrWritebackStateRow | null,
  beforePick: number,
): Omit<LrWritebackStateRow, 'updated_at'> {
  return {
    image_key: imageKey,
    kind: 'reject',
    status: 'written',
    before_pick: row?.before_pick ?? beforePick,
    before_rating: null,
    written_pick: -1,
    written_rating: null,
    stars_profile_version_id: null,
    written_at: row?.written_at ?? nowIsoUtc(),
  };
}

export function adoptWrittenStarsState(
  imageKey: string,
  rating: number,
  starsProfileVersionId: number | null,
  row: LrWritebackStateRow | null,
): Omit<LrWritebackStateRow, 'updated_at'> {
  return {
    image_key: imageKey,
    kind: 'stars',
    status: 'written',
    before_pick: null,
    before_rating: row?.before_rating ?? null,
    written_pick: null,
    written_rating: rating,
    stars_profile_version_id: starsProfileVersionId,
    written_at: row?.written_at ?? nowIsoUtc(),
  };
}

export function notFoundState(
  imageKey: string,
  kind: WritebackKind,
  row: LrWritebackStateRow | null,
  tally: ReconcileRunTally,
): Omit<LrWritebackStateRow, 'updated_at'> {
  if (kind === 'stars') tally.image_not_found_stars += 1;
  else tally.image_not_found_reject += 1;
  return {
    image_key: imageKey,
    kind,
    status: 'skipped',
    before_pick: row?.before_pick ?? null,
    before_rating: row?.before_rating ?? null,
    written_pick: row?.written_pick ?? null,
    written_rating: row?.written_rating ?? null,
    stars_profile_version_id: row?.stars_profile_version_id ?? null,
    written_at: row?.written_at ?? null,
  };
}
