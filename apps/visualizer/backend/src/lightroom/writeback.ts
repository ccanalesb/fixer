/**
 * Reconcile cull verdicts → Lightroom pick/rating/keywords with guards and per-photo state.
 */
import { config, loadLibraryConfig } from '../config.js';
import { countStrongDimensions, ratingFromStrongCount } from './writeback-stars.js';
import type { WritebackKind, WritebackReconcileCounts } from './writeback-types.js';
import { WRITE_CHUNK_SIZE } from './writeback-types.js';
import { resolveCurrentStages } from '../cull/stages.js';
import { getCurrentPipelineSetting } from '../db/library/cull-pipeline.js';
import { readStoredLayaModelIds } from '../db/library/cull-stages.js';
import type { Db } from '../db/connection.js';
import { getCullRecipe } from '../db/library/cull-recipes.js';
import { getCullVerdict, type CullVerdictRow } from '../db/library/cull-verdicts.js';
import { loadCurrentStageAnswers } from '../db/library/cull-stages.js';
import {
  countWritebackByStatus,
  getWritebackState,
  upsertWritebackState,
  type LrWritebackStateRow,
} from '../db/library/lr-writeback-state.js';
import {
  getLrWritebackSettings,
  resolveStarsRecipeSlug,
  type LrWritebackSettings,
} from '../db/library/lr-writeback-settings.js';
import { libraryWrite } from '../db/library/write.js';
import { createEventLoopYieldState, pollCancelAndYield } from '../utils/yield.js';
import { describeLrCatalogWriteStatus } from '../utils/lr-catalog-write.js';
import {
  AUTO_REJECT_KEYWORD,
  AUTO_STARS_KEYWORD,
  addKeywordByKey,
  backupCatalogIfNeeded,
  clearPickIfMatches,
  clearRatingIfMatches,
  connectCatalog,
  raiseIfCatalogLocked,
  readPickRating,
  removeKeywordByKey,
  updatePickIfUnflagged,
  updateRatingIfUnset,
  type LivePickRating,
} from './writer.js';
import { nowIsoUtc } from '../utils/datetime.js';

export type WritebackTrigger =
  | 'cull_job_complete'
  | 'redecide_complete'
  | 'sent_by_hand'
  | 'write_pending'
  | 'switch_on';

export interface ReconcileOptions {
  trigger: WritebackTrigger;
  imageKeys?: readonly string[];
  catalogPath?: string;
  isCancelled?: () => boolean | Promise<boolean>;
}

function catalogPathFromConfig(): string | null {
  const cfg = loadLibraryConfig(config.LT_CONFIG_YAML);
  const path = (cfg.catalogPath ?? '').trim();
  return path || null;
}

function listVerdictImageKeys(db: Db, keys?: readonly string[]): string[] {
  if (keys?.length) return [...keys];
  return (db.prepare(`SELECT image_key FROM cull_verdicts WHERE verdict IN ('cut', 'sent')`).all() as {
    image_key: string;
  }[]).map((r) => r.image_key);
}

function liveMatchesWritten(kind: WritebackKind, live: LivePickRating, row: LrWritebackStateRow): boolean {
  if (kind === 'reject') return live.pick === row.written_pick;
  return live.rating === row.written_rating;
}

function userChangedAfterWrite(kind: WritebackKind, live: LivePickRating, row: LrWritebackStateRow): boolean {
  if (row.status !== 'written') return false;
  return !liveMatchesWritten(kind, live, row);
}

function desiredReject(settings: LrWritebackSettings, verdict: CullVerdictRow | null): boolean {
  if (!settings.write_reject || !verdict) return false;
  if (verdict.sent_by_hand) return false;
  if (verdict.verdict !== 'cut') return false;
  return verdict.cut_by === 'culling_recipe';
}

function stagesForStarsRecipe(db: Db, starsSlug: string) {
  const modelIds = readStoredLayaModelIds(db);
  if (!modelIds) return [];
  const pipe = getCurrentPipelineSetting(db);
  return resolveCurrentStages(db, pipe.config, modelIds).filter(
    (s) => s.recipeSlug === starsSlug && s.kind === 'culling_recipe',
  );
}

function desiredStarsRating(
  db: Db,
  settings: LrWritebackSettings,
  imageKey: string,
  starsSlug: string | null,
): number | null {
  if (!settings.write_stars || !starsSlug) return null;
  const recipe = getCullRecipe(db, starsSlug);
  if (!recipe) return null;
  const stages = stagesForStarsRecipe(db, starsSlug);
  const answersByStage = loadCurrentStageAnswers(db, stages, [imageKey]).get(imageKey) ?? {};
  const count = countStrongDimensions(recipe.definition, recipe.rule, answersByStage, starsSlug);
  return ratingFromStrongCount(count);
}

function countsFromDb(db: Db): Pick<WritebackReconcileCounts, 'stars' | 'reject'> {
  const by = countWritebackByStatus(db);
  return {
    stars: { pending: by.stars.pending, written: by.stars.written, skipped: by.stars.skipped, image_not_found: 0 },
    reject: { pending: by.reject.pending, written: by.reject.written, skipped: by.reject.skipped, image_not_found: 0 },
  };
}

/** Mark every eligible photo pending when a switch turns on (#341 F18). */
export function markEligiblePending(db: Db, kind: WritebackKind): void {
  const settings = getLrWritebackSettings(db);
  const starsSlug = resolveStarsRecipeSlug(db, settings);
  const keys = listVerdictImageKeys(db);
  libraryWrite(db, () => {
    for (const imageKey of keys) {
      const verdict = getCullVerdict(db, imageKey);
      if (kind === 'reject') {
        if (!desiredReject(settings, verdict)) continue;
      } else if (!desiredStarsRating(db, settings, imageKey, starsSlug)) {
        continue;
      }
      const existing = getWritebackState(db, imageKey, kind);
      if (existing?.status === 'written' || existing?.status === 'undone') continue;
      upsertWritebackState(db, {
        image_key: imageKey,
        kind,
        status: 'pending',
        before_pick: existing?.before_pick ?? null,
        before_rating: existing?.before_rating ?? null,
        written_pick: existing?.written_pick ?? null,
        written_rating: existing?.written_rating ?? null,
        stars_recipe_version_id: existing?.stars_recipe_version_id ?? null,
        written_at: existing?.written_at ?? null,
      });
    }
  });
}

export async function reconcileLrWriteback(db: Db, opts: ReconcileOptions): Promise<WritebackReconcileCounts> {
  const settings = getLrWritebackSettings(db);
  const base = countsFromDb(db);
  const mutations = { catalog_updated_stars: 0, catalog_updated_reject: 0, catalog_cleared_reject: 0 };
  if (!settings.write_stars && !settings.write_reject) {
    return { ...base, ...mutations };
  }

  const catalogPath = opts.catalogPath ?? catalogPathFromConfig();
  if (!catalogPath) return { ...base, ...mutations };

  const lrStatus = describeLrCatalogWriteStatus();
  const canWrite = lrStatus.available && lrStatus.path === catalogPath;
  const keys = listVerdictImageKeys(db, opts.imageKeys);
  const starsSlug = resolveStarsRecipeSlug(db, settings);
  const starsRecipe = starsSlug ? getCullRecipe(db, starsSlug) : null;
  const yieldState = createEventLoopYieldState();
  const isCancelled = opts.isCancelled ?? (() => false);

  let conn: ReturnType<typeof connectCatalog> | null = null;
  if (canWrite && opts.trigger !== 'switch_on') {
    raiseIfCatalogLocked(catalogPath);
    backupCatalogIfNeeded(catalogPath);
    conn = connectCatalog(catalogPath);
  }

  try {
    for (let i = 0; i < keys.length; i += WRITE_CHUNK_SIZE) {
      if (await pollCancelAndYield(db, isCancelled, yieldState)) break;
      if (canWrite && conn) raiseIfCatalogLocked(catalogPath);
      const chunk = keys.slice(i, i + WRITE_CHUNK_SIZE);
      const pendingStates: Omit<LrWritebackStateRow, 'updated_at'>[] = [];
      for (const imageKey of chunk) {
        const live = conn ? readPickRating(conn, imageKey) : null;
        const verdict = getCullVerdict(db, imageKey);
        if (settings.write_reject) {
          const r = planReject(db, settings, verdict, live, imageKey, opts.trigger, canWrite, conn, mutations);
          if (r) pendingStates.push(r);
        }
        if (settings.write_stars) {
          const r = planStars(
            db,
            settings,
            starsSlug,
            starsRecipe?.versionId ?? null,
            verdict,
            live,
            imageKey,
            opts.trigger,
            canWrite,
            conn,
            mutations,
          );
          if (r) pendingStates.push(r);
        }
      }
      if (pendingStates.length > 0) {
        libraryWrite(db, () => {
          for (const row of pendingStates) upsertWritebackState(db, row);
        });
      }
    }
  } finally {
    conn?.close();
  }

  return { ...countsFromDb(db), ...mutations };
}

function planReject(
  db: Db,
  settings: LrWritebackSettings,
  verdict: CullVerdictRow | null,
  live: LivePickRating | null,
  imageKey: string,
  trigger: WritebackTrigger,
  canWrite: boolean,
  conn: ReturnType<typeof connectCatalog> | null,
  mutations: { catalog_updated_reject: number; catalog_cleared_reject: number },
): Omit<LrWritebackStateRow, 'updated_at'> | null {
  const row = getWritebackState(db, imageKey, 'reject');
  const want = desiredReject(settings, verdict);

  if (live && row && userChangedAfterWrite('reject', live, row)) {
    return { ...row, status: 'skipped' };
  }

  if (!want) {
    if (row?.status === 'written' && live && liveMatchesWritten('reject', live, row) && conn && canWrite) {
      clearPickIfMatches(conn, imageKey, -1);
      removeKeywordByKey(conn, imageKey, AUTO_REJECT_KEYWORD);
      mutations.catalog_cleared_reject += 1;
      return { ...row, status: 'pending', written_pick: null, written_at: null };
    }
    return null;
  }

  if (row?.status === 'undone') return null;

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
  const result = updatePickIfUnflagged(conn, imageKey, -1);
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
  addKeywordByKey(conn, imageKey, AUTO_REJECT_KEYWORD);
  mutations.catalog_updated_reject += 1;
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

function planStars(
  db: Db,
  settings: LrWritebackSettings,
  starsSlug: string | null,
  starsVersionId: number | null,
  _verdict: CullVerdictRow | null,
  live: LivePickRating | null,
  imageKey: string,
  trigger: WritebackTrigger,
  canWrite: boolean,
  conn: ReturnType<typeof connectCatalog> | null,
  mutations: { catalog_updated_stars: number },
): Omit<LrWritebackStateRow, 'updated_at'> | null {
  const row = getWritebackState(db, imageKey, 'stars');
  const rating = desiredStarsRating(db, settings, imageKey, starsSlug);

  if (live && row && userChangedAfterWrite('stars', live, row)) {
    return { ...row, status: 'skipped' };
  }

  if (row?.status === 'undone' && starsVersionId !== null && row.stars_recipe_version_id === starsVersionId) {
    return null;
  }

  if (rating === null) {
    if (row?.status === 'written' && live && liveMatchesWritten('stars', live, row) && conn && canWrite) {
      clearRatingIfMatches(conn, imageKey, row.written_rating!);
      removeKeywordByKey(conn, imageKey, AUTO_STARS_KEYWORD);
    }
    return null;
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

  const result = updateRatingIfUnset(conn, imageKey, rating);
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
  addKeywordByKey(conn, imageKey, AUTO_STARS_KEYWORD);
  mutations.catalog_updated_stars += 1;
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

/** Undo one kind when Lightroom still holds the app-written value. */
export function undoWritebackKind(
  db: Db,
  catalogPath: string,
  imageKey: string,
  kind: WritebackKind,
): { ok: boolean; reason?: string } {
  raiseIfCatalogLocked(catalogPath);
  backupCatalogIfNeeded(catalogPath);
  const row = getWritebackState(db, imageKey, kind);
  if (!row || row.status !== 'written') return { ok: false, reason: 'Nothing to undo.' };
  const conn = connectCatalog(catalogPath);
  try {
    const live = readPickRating(conn, imageKey);
    if (!live || !liveMatchesWritten(kind, live, row)) {
      return { ok: false, reason: 'Lightroom no longer holds what the app wrote.' };
    }
    if (kind === 'reject') {
      clearPickIfMatches(conn, imageKey, -1);
      removeKeywordByKey(conn, imageKey, AUTO_REJECT_KEYWORD);
    } else if (row.written_rating !== null) {
      clearRatingIfMatches(conn, imageKey, row.written_rating);
      removeKeywordByKey(conn, imageKey, AUTO_STARS_KEYWORD);
    }
    libraryWrite(db, () => {
      upsertWritebackState(db, {
        ...row,
        status: 'undone',
        written_pick: null,
        written_rating: null,
        written_at: null,
      });
    });
    return { ok: true };
  } finally {
    conn.close();
  }
}
