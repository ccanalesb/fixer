/**
 * Reconcile cull verdicts → Lightroom pick/rating/keywords with guards and per-photo state.
 */
import { config, loadLibraryConfig } from '../config.js';
import type { WritebackReconcileCounts } from './writeback-types.js';
import { WRITE_CHUNK_SIZE } from './writeback-types.js';
import type { Db } from '../db/connection.js';
import { getCullProfile } from '../db/library/cull-profiles.js';
import { getCullVerdict } from '../db/library/cull-verdicts.js';
import { countWritebackByStatus, getWritebackState, upsertWritebackState } from '../db/library/lr-writeback-state.js';
import {
  getLrWritebackSettings,
  resolveStarsProfileSlug,
  type LrWritebackSettings,
} from '../db/library/lr-writeback-settings.js';
import { libraryWrite } from '../db/library/write.js';
import { createEventLoopYieldState, EVENT_LOOP_YIELD_BUDGET_MS, pollCancelAndYield } from '../utils/yield.js';
import { describeLrCatalogWriteStatus } from '../utils/lr-catalog-write.js';
import {
  backupCatalogIfNeeded,
  connectCatalog,
  getImageLocalId,
  isCatalogLocked,
  raiseIfCatalogLocked,
  readPickRating,
} from './writer.js';
import {
  closeCloudDocstore,
  openCloudDocstore,
  pushPhotoToCloud,
  type CloudDocstore,
} from './cloud-sync/docstore.js';
import {
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

/**
 * Carry the photo's catalog stars/flag to the cloud, for each kind the app manages on it.
 * Runs on every photo with a write-back row, so photos written before cloud sync existed
 * catch up; a document that already matches is left alone.
 */
function carryToCloud(
  db: Db,
  cloud: CloudDocstore,
  conn: Db,
  imageKey: string,
  settings: LrWritebackSettings,
  counts: WritebackReconcileCounts['cloud'],
): void {
  const fields = {
    rating: settings.write_stars && getWritebackState(db, imageKey, 'stars') !== null,
    flag: settings.write_reject && getWritebackState(db, imageKey, 'reject') !== null,
  };
  if (!fields.rating && !fields.flag) return;
  const imageId = getImageLocalId(conn, imageKey);
  if (imageId === null) return;
  const result = pushPhotoToCloud(cloud, conn, imageId, fields);
  if (result !== 'unchanged') counts[result] += 1;
}

export async function reconcileLrWriteback(db: Db, opts: ReconcileOptions): Promise<WritebackReconcileCounts> {
  const settings = getLrWritebackSettings(db);
  const tally = emptyRunTally();
  const base = countsFromDb(db, tally);
  const mutations = {
    catalog_updated_stars: 0,
    catalog_updated_reject: 0,
    catalog_cleared_reject: 0,
    cloud: { pushed: 0, not_synced: 0, unreadable: 0 },
  };
  if (!settings.write_stars && !settings.write_reject) {
    return { ...base, ...mutations };
  }

  const catalogPath = opts.catalogPath ?? catalogPathFromConfig();
  if (!catalogPath) return { ...base, ...mutations };

  const lrStatus = describeLrCatalogWriteStatus();
  let canWrite = lrStatus.available && lrStatus.path === catalogPath;
  const keys = listVerdictImageKeys(db, opts.imageKeys);
  const starsSlug = resolveStarsProfileSlug(db, settings);
  const starsProfile = starsSlug ? getCullProfile(db, starsSlug) : null;
  const yieldState = createEventLoopYieldState();
  const isCancelled = opts.isCancelled ?? (() => false);

  let conn: ReturnType<typeof connectCatalog> | null = null;
  let cloud: CloudDocstore | null = null;
  if (canWrite) {
    raiseIfCatalogLocked(catalogPath);
    backupCatalogIfNeeded(catalogPath);
    conn = connectCatalog(catalogPath, db);
    cloud = openCloudDocstore(conn, catalogPath);
  }

  let lockStopped = false;

  try {
    outer: for (let i = 0; i < keys.length; i += WRITE_CHUNK_SIZE) {
      if (await pollCancelAndYield(db, isCancelled, yieldState)) break;
      const chunk = keys.slice(i, i + WRITE_CHUNK_SIZE);
      const done = Math.min(i + chunk.length, keys.length);
      opts.onProgress?.(
        keys.length ? Math.round((done / keys.length) * 100) : 100,
        `Lightroom Classic write-back (${done}/${keys.length})`,
      );
      for (const imageKey of chunk) {
        if (
          Date.now() - yieldState.lastYieldAt >= EVENT_LOOP_YIELD_BUDGET_MS &&
          (await pollCancelAndYield(db, isCancelled, yieldState))
        ) {
          break outer;
        }
        if (canWrite && isCatalogLocked(catalogPath)) lockStopped = true;
        const writeNow = canWrite && !lockStopped && conn !== null;
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
            starsProfile?.versionId ?? null,
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
        if (writeNow && cloud && conn) carryToCloud(db, cloud, conn, imageKey, settings, mutations.cloud);
      }
    }
  } finally {
    closeCloudDocstore(cloud);
    conn?.close();
  }

  mutations.catalog_updated_stars = tally.catalog_updated_stars;
  mutations.catalog_updated_reject = tally.catalog_updated_reject;
  mutations.catalog_cleared_reject = tally.catalog_cleared_reject;

  return { ...countsFromDb(db, tally), ...mutations };
}
