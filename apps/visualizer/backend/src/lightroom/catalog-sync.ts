/**
 * Incremental catalog sync — additions-only refresh from a `.lrcat` into
 * `library.db`.
 *
 * The whole design is one set difference. Reading full metadata for 43,000 images
 * takes minutes; reading their ids takes one query, so the expensive join runs only
 * for the ids `library.db` has never seen. Rows are never deleted: an image missing
 * from the catalog is reported as `stale` and left alone, because the user may have
 * moved it to a different catalog and every score and description hangs off its key.
 */
import type { Db } from '../db/connection.js';
import {
  getLibraryMeta,
  KEYWORDS_BACKFILL_META_KEY,
  setLibraryMeta,
  SYNCED_CATALOG_META_KEY,
  upgradeLibrarySchema,
} from '../db/library/bootstrap.js';
import { storeImagesBatch, updateImageKeywordsBatch } from '../db/library/catalog.js';
import { libraryWrite } from '../db/library/write.js';
import { createEventLoopYieldState, pollCancelAndYield } from '../utils/yield.js';
import {
  catalogReadonlyUriEnabled,
  connectCatalogReadOnly,
  getImageById,
  getKeywordsForFileId,
  listCatalogFileIds,
  listCatalogOrientations,
  resolveCatalogLockingMode,
  type CatalogRecord,
} from './reader.js';
import {
  refreshImageOrientations,
  type OrientationRefreshResult,
} from '../vision/orientation-refresh.js';

export const CATALOG_LOCKED_MSG =
  'Cannot read Lightroom Classic catalog: another process holds the catalog open. ' +
  'Close Lightroom Classic and retry.';

/** The catalog could not be opened or read — typically Lightroom Classic is holding it. */
export class CatalogSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogSyncError';
  }
}

export interface CatalogSyncResult {
  added: number;
  stale: number;
  locking_mode: string;
  catalog_total: number;
  library_total: number;
  missing_ids_count: number;
  /** Rows whose `images.keywords` were rewritten from the catalog. */
  keywords_backfilled: number;
  /** Rows whose `images.orientation` changed. */
  orientations_updated: number;
  /** Of those, images whose outputs were marked stale and whose cache JPEG must be rebuilt. */
  orientation_stale: number;
}

function isCatalogLockedError(e: unknown): boolean {
  return String(e instanceof Error ? e.message : e)
    .toLowerCase()
    .includes('database is locked');
}

/**
 * Turn a driver-level failure into something the UI can act on.
 *
 * Exported for its own test: reaching the locked branch through a real lock means
 * waiting out the connection's 30-second busy timeout, and these three strings are
 * the whole point of the function.
 */
export function catalogSyncErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const msg = raw.toLowerCase();
  if (msg.includes('database is locked')) return CATALOG_LOCKED_MSG;
  if (msg.includes('unable to open database file')) {
    return (
      'Cannot open Lightroom Classic catalog file. On network storage, ensure the ' +
      'catalog is reachable. For legacy read-write opens, try ' +
      'LIGHTROOM_CATALOG_LOCKING_MODE=EXCLUSIVE. Close Lightroom Classic ' +
      'if the catalog is in use.'
    );
  }
  return `Cannot read Lightroom Classic catalog: ${raw}`;
}

/**
 * The numeric catalog ids already indexed in `images.id`.
 *
 * That column is TEXT, so it can hold anything an older import wrote. Empty and
 * non-numeric values are skipped rather than raising — and the comparison has to be
 * numeric, because as text `'38887'` sorts after `'99999'` and a lexicographic diff
 * would re-fetch images that are already there.
 */
export function listLibraryCatalogIds(db: Db): Set<number> {
  const rows = db.prepare('SELECT id FROM images').all() as { id: unknown }[];
  const ids = new Set<number>();
  for (const row of rows) {
    if (row.id === null || row.id === undefined) continue;
    const text = String(row.id).trim();
    // Skip empty and non-numeric ids. Numeric comparison matters: as text,
    // `'38887'` sorts after `'99999'`.
    if (!/^[+-]?\d+$/.test(text)) continue;
    ids.add(Number(text));
  }
  return ids;
}

export interface SyncCatalogOptions {
  log?: (level: string, message: string) => void;
  progress?: (pct: number, message: string) => void;
  /** Checked between metadata fetches; the run stops and reports what it added. */
  isCancelled?: () => boolean | Promise<boolean>;
  /**
   * Re-read keywords for every indexed catalog id. When omitted, a one-time
   * backfill runs automatically until `library_meta.keywords_backfilled_v1` is set.
   */
  backfillKeywords?: boolean;
}

/** True when the run stopped early because the caller cancelled it. */
export interface SyncCatalogOutcome {
  result: CatalogSyncResult;
  cancelled: boolean;
}

/**
 * Diff catalog ids against `library.db`, fetch metadata for the missing ones, upsert.
 *
 * Throws `CatalogSyncError` when the catalog cannot be opened or listed. Once the
 * id list is in hand nothing else is fatal: a per-image fetch that returns nothing
 * just contributes no record.
 */
async function backfillCatalogKeywords(
  catalogConn: Db,
  libDb: Db,
  fileIds: readonly number[],
  opts: SyncCatalogOptions,
  yieldState: ReturnType<typeof createEventLoopYieldState>,
  isCancelled: () => boolean | Promise<boolean>,
): Promise<{ updated: number; cancelled: boolean }> {
  const total = fileIds.length;
  const updates: { catalogId: number; keywords: string[] }[] = [];
  for (const [index, fileId] of fileIds.entries()) {
    if (await pollCancelAndYield(libDb, isCancelled, yieldState)) {
      return { updated: 0, cancelled: true };
    }
    updates.push({ catalogId: fileId, keywords: getKeywordsForFileId(catalogConn, fileId) });
    if (total) {
      const pct = 95 + Math.trunc((4 * (index + 1)) / total);
      opts.progress?.(pct, `Backfilling keywords ${index + 1}/${total}`);
    }
  }
  const updated = updates.length
    ? libraryWrite(libDb, () => updateImageKeywordsBatch(libDb, updates))
    : 0;
  return { updated, cancelled: false };
}

export async function syncCatalog(
  catalogPath: string,
  libDb: Db,
  opts: SyncCatalogOptions = {},
): Promise<SyncCatalogOutcome> {
  const log = (level: string, message: string): void => opts.log?.(level, message);
  upgradeLibrarySchema(libDb);

  let catalogConn: Db;
  try {
    catalogConn = connectCatalogReadOnly(catalogPath);
  } catch (e) {
    throw new CatalogSyncError(catalogSyncErrorMessage(e));
  }

  const lockingMode = resolveCatalogLockingMode(catalogReadonlyUriEnabled());

  try {
    let catalogIds: Set<number>;
    try {
      catalogIds = new Set(listCatalogFileIds(catalogConn));
    } catch (e) {
      throw isCatalogLockedError(e) ? new CatalogSyncError(CATALOG_LOCKED_MSG) : e;
    }

    const libraryIds = listLibraryCatalogIds(libDb);
    const missingIds = [...catalogIds].filter((id) => !libraryIds.has(id)).sort((a, b) => a - b);
    const staleCount = [...libraryIds].filter((id) => !catalogIds.has(id)).length;

    log(
      'info',
      `[catalog-sync] mode=set_difference locking_mode=${lockingMode} ` +
        `catalog_total=${catalogIds.size} library_total=${libraryIds.size} ` +
        `missing=${missingIds.length} stale=${staleCount}`,
    );

    const records: CatalogRecord[] = [];
    const totalMissing = missingIds.length;
    let cancelled = false;
    const yieldState = createEventLoopYieldState();
    const isCancelled = (): boolean | Promise<boolean> => opts.isCancelled?.() ?? false;
    for (const [index, imageId] of missingIds.entries()) {
      if (await pollCancelAndYield(libDb, isCancelled, yieldState)) {
        cancelled = true;
        break;
      }
      const record = getImageById(catalogConn, imageId);
      if (record) records.push(record);
      if (totalMissing) {
        const pct = 5 + Math.trunc((90 * (index + 1)) / totalMissing);
        opts.progress?.(pct, `Fetching catalog metadata ${index + 1}/${totalMissing}`);
      }
    }

    const added = records.length ? libraryWrite(libDb, () => storeImagesBatch(libDb, records)) : 0;

    // Every run rather than only for new ids: a photo turned in Lightroom Classic after it
    // was synced has a stale cache JPEG and outputs made from it.
    let orientation: OrientationRefreshResult = { updated: 0, stale: 0 };
    if (!cancelled) {
      orientation = await refreshImageOrientations(libDb, listCatalogOrientations(catalogConn));
      log(
        'info',
        `[catalog-sync] orientation updated=${orientation.updated} stale=${orientation.stale}`,
      );
    }

    let keywordsBackfilled = 0;
    const forceKeywordBackfill = opts.backfillKeywords === true;
    const autoKeywordBackfill =
      !forceKeywordBackfill && getLibraryMeta(libDb, KEYWORDS_BACKFILL_META_KEY) !== '1';
    if (!cancelled && (forceKeywordBackfill || autoKeywordBackfill)) {
      const indexedIds = [...listLibraryCatalogIds(libDb)]
        .filter((id) => catalogIds.has(id))
        .sort((a, b) => a - b);
      log(
        'info',
        `[catalog-sync] keyword_backfill mode=${forceKeywordBackfill ? 'forced' : 'auto'} ` +
          `rows=${indexedIds.length}`,
      );
      const backfill = await backfillCatalogKeywords(
        catalogConn,
        libDb,
        indexedIds,
        opts,
        yieldState,
        isCancelled,
      );
      if (backfill.cancelled) {
        cancelled = true;
      } else {
        keywordsBackfilled = backfill.updated;
        libraryWrite(libDb, () =>
          setLibraryMeta(libDb, KEYWORDS_BACKFILL_META_KEY, '1'),
        );
      }
    }

    // Only a run that reached the end can claim the library mirrors this catalog.
    // A cancelled one leaves the previous claim standing, which is the truth.
    if (!cancelled) {
      libraryWrite(libDb, () => setLibraryMeta(libDb, SYNCED_CATALOG_META_KEY, catalogPath));
    }

    opts.progress?.(100, 'Catalog sync complete');
    log(
      'info',
      `[catalog-sync] complete added=${added} stale=${staleCount} ` +
        `keywords_backfilled=${keywordsBackfilled} locking_mode=${lockingMode}`,
    );

    return {
      result: {
        added,
        stale: staleCount,
        locking_mode: lockingMode,
        catalog_total: catalogIds.size,
        library_total: libraryIds.size,
        missing_ids_count: totalMissing,
        keywords_backfilled: keywordsBackfilled,
        orientations_updated: orientation.updated,
        orientation_stale: orientation.stale,
      },
      cancelled,
    };
  } finally {
    catalogConn.close();
  }
}
