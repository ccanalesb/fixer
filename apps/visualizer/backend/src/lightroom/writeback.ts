/**
 * Reconcile cull verdicts → Lightroom pick/rating/keywords with guards and per-photo state.
 */
import { config, resolveConfiguredCatalogPath } from '../config.js';
import type { WritebackReconcileCounts } from './writeback-types.js';
import { WRITE_CHUNK_SIZE } from './writeback-types.js';
import type { Db } from '../db/connection.js';
import { getCullProfile } from '../db/library/cull-profiles.js';
import { countWritebackByStatus, getWritebackState, upsertWritebackState } from '../db/library/lr-writeback-state.js';
import {
  getLrWritebackSettings,
  resolveStarsProfileSlug,
  type LrWritebackSettings,
} from '../db/library/lr-writeback-settings.js';
import { libraryWrite } from '../db/library/write.js';
import { createEventLoopYieldState, EVENT_LOOP_YIELD_BUDGET_MS, pollCancelAndYield } from '../utils/yield.js';
import { describeCatalogWriteStatus } from '../utils/catalog-write-status.js';
import {
  backupCatalogIfNeeded,
  isCatalogLocked,
  raiseIfCatalogLocked,
} from './writer.js';
import {
  openFolderWritebackWriterSession,
} from '../folder/xmp-writeback-writer.js';
import { CATALOG_KIND_META_KEY, inferCatalogKind } from '../catalog-library.js';
import { getLibraryMeta } from '../db/library/bootstrap.js';
import { openWritebackCatalogWriter, type WritebackCatalogWriter, type WritebackCatalogWriterSession } from './writeback-catalog-writer.js';
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
  type WritebackPlanRun,
} from './writeback-shared.js';
import { decideWriteback } from './writeback-decision.js';
import { planRejectPhoto } from './writeback-plan-reject.js';
import { planStarsPhoto } from './writeback-plan-stars.js';

export type { WritebackTrigger, ReconcileOptions };
export { undoWritebackKind } from './writeback-undo.js';
export { buildWritebackPhotoDetail } from './writeback-detail.js';

function catalogPathFromConfig(): string | null {
  const path = (resolveConfiguredCatalogPath(config.LT_CONFIG_YAML) ?? '').trim();
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
      file_error: tally.file_error_stars,
    },
    reject: {
      pending: by.reject.pending,
      written: by.reject.written,
      skipped: by.reject.skipped,
      image_not_found: tally.image_not_found_reject,
      file_error: tally.file_error_reject,
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
  catalogConn: Db,
  writer: WritebackCatalogWriter,
  imageKey: string,
  settings: LrWritebackSettings,
  counts: WritebackReconcileCounts['cloud'],
): void {
  const fields = {
    rating: settings.write_stars && getWritebackState(db, imageKey, 'stars') !== null,
    flag: settings.write_reject && getWritebackState(db, imageKey, 'reject') !== null,
  };
  if (!fields.rating && !fields.flag) return;
  const imageId = writer.imageLocalId(imageKey);
  if (imageId === null) return;
  const result = pushPhotoToCloud(cloud, catalogConn, imageId, fields);
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

  const writeStatus = describeCatalogWriteStatus(db);
  const catalogKind =
    getLibraryMeta(db, CATALOG_KIND_META_KEY) ?? inferCatalogKind(catalogPath);
  const isFolder = catalogKind === 'folder';

  let canWrite = writeStatus.available && writeStatus.path === catalogPath;
  const keys = listVerdictImageKeys(db, opts.imageKeys);
  const starsSlug = resolveStarsProfileSlug(db, settings);
  const starsProfile = starsSlug ? getCullProfile(db, starsSlug) : null;
  const starsVersionId = starsProfile?.versionId ?? null;
  const yieldState = createEventLoopYieldState();
  const isCancelled = opts.isCancelled ?? (() => false);

  let lrcatSession: WritebackCatalogWriterSession | null = null;
  let folderSession: Awaited<ReturnType<typeof openFolderWritebackWriterSession>> | null = null;
  let cloud: CloudDocstore | null = null;
  if (canWrite) {
    if (isFolder) {
      folderSession = await openFolderWritebackWriterSession(catalogPath, db);
    } else {
      raiseIfCatalogLocked(catalogPath);
      backupCatalogIfNeeded(catalogPath);
      lrcatSession = openWritebackCatalogWriter(catalogPath, db);
      cloud = openCloudDocstore(lrcatSession.catalogConn, catalogPath);
    }
  }
  const catalogWriter: WritebackCatalogWriter | null = lrcatSession?.writer ?? folderSession?.writer ?? null;

  let lockStopped = false;
  const folderWriter = folderSession?.writer ?? null;
  const progressLabel = isFolder ? 'Photo file write-back' : 'Lightroom Classic write-back';

  const run: WritebackPlanRun = {
    db,
    catalog: catalogWriter,
    tally,
    starsVersionId,
  };

  try {
    outer: for (let i = 0; i < keys.length; i += WRITE_CHUNK_SIZE) {
      if (await pollCancelAndYield(db, isCancelled, yieldState)) break;
      const chunk = keys.slice(i, i + WRITE_CHUNK_SIZE);
      const done = Math.min(i + chunk.length, keys.length);
      opts.onProgress?.(
        keys.length ? Math.round((done / keys.length) * 100) : 100,
        `${progressLabel} (${done}/${keys.length})`,
      );
      if (folderWriter) {
        await folderWriter.prefetch(chunk);
      }
      for (const imageKey of chunk) {
        if (
          Date.now() - yieldState.lastYieldAt >= EVENT_LOOP_YIELD_BUDGET_MS &&
          (await pollCancelAndYield(db, isCancelled, yieldState))
        ) {
          break outer;
        }
        if (!isFolder && canWrite && isCatalogLocked(catalogPath)) lockStopped = true;
        const writeNow = canWrite && !lockStopped && catalogWriter !== null;
        let live = catalogWriter?.readPickRating(imageKey) ?? null;
        if (folderWriter && writeNow) {
          live = await folderWriter.refreshLiveFromDisk(imageKey);
        }
        const decision = decideWriteback(db, settings, imageKey, starsSlug);
        const photo = { imageKey, live, writeNow, decision };

        if (settings.write_reject) {
          const row = await planRejectPhoto(run, photo);
          if (row) {
            libraryWrite(db, () => upsertWritebackState(db, row));
          }
        }
        if (settings.write_stars) {
          const row = await planStarsPhoto(run, photo);
          if (row) {
            libraryWrite(db, () => upsertWritebackState(db, row));
          }
        }
        if (writeNow && cloud && lrcatSession) {
          carryToCloud(db, cloud, lrcatSession.catalogConn, lrcatSession.writer, imageKey, settings, mutations.cloud);
        }
      }
    }
  } finally {
    closeCloudDocstore(cloud);
    lrcatSession?.close();
    await folderSession?.close();
  }

  mutations.catalog_updated_stars = tally.catalog_updated_stars;
  mutations.catalog_updated_reject = tally.catalog_updated_reject;
  mutations.catalog_cleared_reject = tally.catalog_cleared_reject;

  return { ...countsFromDb(db, tally), ...mutations };
}
