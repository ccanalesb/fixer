/**
 * Reconcile cull verdicts → Lightroom pick/rating/keywords with guards and per-photo state.
 */
import { config, loadLibraryConfig } from '../config.js';
import type { WritebackKind, WritebackReconcileCounts } from './writeback-types.js';
import { WRITE_CHUNK_SIZE } from './writeback-types.js';
import type { Db } from '../db/connection.js';
import { getCullRecipe } from '../db/library/cull-recipes.js';
import { getCullVerdict } from '../db/library/cull-verdicts.js';
import {
  countWritebackByStatus,
  getWritebackState,
  upsertWritebackState,
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
  backupCatalogIfNeeded,
  connectCatalog,
  isCatalogLocked,
  raiseIfCatalogLocked,
  readPickRating,
} from './writer.js';
import {
  desiredStarsRating,
  emptyRunTally,
  listVerdictImageKeys,
  type ReconcileRunTally,
  type ReconcileOptions,
  type WritebackTrigger,
} from './writeback-shared.js';
import { planRejectPhoto } from './writeback-plan-reject.js';
import { planStarsPhoto } from './writeback-plan-stars.js';

export type { WritebackTrigger, ReconcileOptions };
export { undoWritebackKind } from './writeback-undo.js';
export { buildWritebackPhotoDetail } from './writeback-detail.js';

function catalogPathFromConfig(): string | null {
  const cfg = loadLibraryConfig(config.LT_CONFIG_YAML);
  const path = (cfg.catalogPath ?? '').trim();
  return path || null;
}

function countsFromDb(db: Db, tally: ReconcileRunTally): Pick<WritebackReconcileCounts, 'stars' | 'reject'> {
  const by = countWritebackByStatus(db);
  return {
    stars: {
      pending: by.stars.pending,
      written: by.stars.written,
      skipped: by.stars.skipped,
      image_not_found: tally.image_not_found_stars,
    },
    reject: {
      pending: by.reject.pending,
      written: by.reject.written,
      skipped: by.reject.skipped,
      image_not_found: tally.image_not_found_reject,
    },
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
        if (!planRejectEligible(settings, verdict)) continue;
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

function planRejectEligible(settings: LrWritebackSettings, verdict: ReturnType<typeof getCullVerdict>): boolean {
  if (!settings.write_reject || !verdict) return false;
  if (verdict.sent_by_hand) return false;
  if (verdict.verdict !== 'cut') return false;
  return verdict.cut_by === 'culling_recipe';
}

export async function reconcileLrWriteback(db: Db, opts: ReconcileOptions): Promise<WritebackReconcileCounts> {
  const settings = getLrWritebackSettings(db);
  const tally = emptyRunTally();
  const base = countsFromDb(db, tally);
  const mutations = {
    catalog_updated_stars: 0,
    catalog_updated_reject: 0,
    catalog_cleared_reject: 0,
  };
  if (!settings.write_stars && !settings.write_reject) {
    return { ...base, ...mutations };
  }

  const catalogPath = opts.catalogPath ?? catalogPathFromConfig();
  if (!catalogPath) return { ...base, ...mutations };

  const lrStatus = describeLrCatalogWriteStatus();
  let canWrite = lrStatus.available && lrStatus.path === catalogPath;
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

  let lockStopped = false;

  try {
    for (let i = 0; i < keys.length; i += WRITE_CHUNK_SIZE) {
      if (await pollCancelAndYield(db, isCancelled, yieldState)) break;
      const chunk = keys.slice(i, i + WRITE_CHUNK_SIZE);
      for (const imageKey of chunk) {
        if (canWrite && isCatalogLocked(catalogPath)) lockStopped = true;
        const writeNow = canWrite && !lockStopped && conn !== null && opts.trigger !== 'switch_on';
        const live = conn ? readPickRating(conn, imageKey) : null;
        const verdict = getCullVerdict(db, imageKey);

        if (settings.write_reject) {
          const row = planRejectPhoto(
            db,
            settings,
            verdict,
            live,
            imageKey,
            opts.trigger,
            writeNow,
            conn,
            tally,
          );
          if (row) {
            libraryWrite(db, () => upsertWritebackState(db, row));
          }
        }
        if (settings.write_stars) {
          const row = planStarsPhoto(
            db,
            settings,
            starsSlug,
            starsRecipe?.versionId ?? null,
            live,
            imageKey,
            opts.trigger,
            writeNow,
            conn,
            tally,
          );
          if (row) {
            libraryWrite(db, () => upsertWritebackState(db, row));
          }
        }
      }
    }
  } finally {
    conn?.close();
  }

  mutations.catalog_updated_stars = tally.catalog_updated_stars;
  mutations.catalog_updated_reject = tally.catalog_updated_reject;
  mutations.catalog_cleared_reject = tally.catalog_cleared_reject;

  return { ...countsFromDb(db, tally), ...mutations };
}
