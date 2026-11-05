/**
 * Import photos from a folder catalog into `library.db`.
 */
import { existsSync } from 'node:fs';
import type { Db } from '../db/connection.js';
import { storeImagesBatch } from '../db/library/catalog.js';
import { libraryWrite } from '../db/library/write.js';
import type { CatalogSyncResult } from '../lightroom/catalog-sync.js';
import { createEventLoopYieldState, pollCancelAndYield } from '../utils/yield.js';
import {
  buildFolderCatalogRecords,
  readExifTagsParallel,
} from './exif-read.js';
import { walkFolderCatalog } from './walk.js';

export interface SyncFolderCatalogOptions {
  log?: (level: string, message: string) => void;
  progress?: (pct: number, message: string) => void;
  isCancelled?: () => boolean | Promise<boolean>;
}

export interface SyncFolderCatalogOutcome {
  result: CatalogSyncResult;
  cancelled: boolean;
}

export async function syncFolderCatalog(
  catalogRoot: string,
  libDb: Db,
  opts: SyncFolderCatalogOptions = {},
): Promise<SyncFolderCatalogOutcome> {
  const log = opts.log ?? (() => {});
  if (!existsSync(catalogRoot)) {
    throw new Error(`Catalog not found: ${catalogRoot}`);
  }

  const walkStart = Date.now();
  const { photos, stats } = walkFolderCatalog(catalogRoot);
  const walkMs = Date.now() - walkStart;
  log('info', `[cache] [sync] walk_ms=${walkMs} photos=${stats.photoCount} folders=${stats.folderCount}`);

  opts.progress?.(10, 'Reading the folder...');

  const yieldState = createEventLoopYieldState();
  const isCancelled = opts.isCancelled ?? (() => false);

  const existing = new Set(
    (libDb.prepare('SELECT key FROM images').all() as { key: string }[]).map((r) => r.key),
  );

  const paths = photos.map((p) => p.filepath);
  const statStart = Date.now();
  const tagsByPath = await readExifTagsParallel(paths);
  const statMs = Date.now() - statStart;

  if (await pollCancelAndYield(libDb, isCancelled, yieldState)) {
    return {
      result: {
        added: 0,
        stale: 0,
        locking_mode: 'folder',
        catalog_total: stats.photoCount,
        library_total: existing.size,
        missing_ids_count: 0,
        keywords_backfilled: 0,
        orientations_updated: 0,
        orientation_stale: 0,
      },
      cancelled: true,
    };
  }

  const records = buildFolderCatalogRecords(photos, tagsByPath).filter((r) => !existing.has(r.key));
  let added = 0;
  if (records.length > 0) {
    libraryWrite(libDb, () => {
      added = storeImagesBatch(libDb, records);
    });
  }

  log(
    'info',
    `[cache] [sync] added=${added} stale=0 changed=0 walk_ms=${walkMs} stat_ms=${statMs} ` +
      `photos=${stats.photoCount} folders=${stats.folderCount}`,
  );
  opts.progress?.(100, 'Folder read complete');

  return {
    result: {
      added,
      stale: 0,
      locking_mode: 'folder',
      catalog_total: stats.photoCount,
      library_total: existing.size + added,
      missing_ids_count: 0,
      keywords_backfilled: 0,
      orientations_updated: 0,
      orientation_stale: 0,
    },
    cancelled: false,
  };
}
