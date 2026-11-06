/**
 * Import and re-sync photos from a folder catalog into `library.db`.
 */
import { existsSync } from 'node:fs';
import type { Db } from '../db/connection.js';
import {
  setLibraryMeta,
  upgradeLibrarySchema,
} from '../db/library/bootstrap.js';
import {
  applyFolderMove,
  insertFolderRecords,
  listFolderLibraryRows,
  markFolderPhotosGone,
  updateFolderRecordInPlace,
  type FolderLibraryRow,
} from '../db/library/folder-sync.js';
import { libraryWrite } from '../db/library/write.js';
import type { CatalogSyncResult } from '../lightroom/catalog-sync.js';
import type { CatalogRecord } from '../lightroom/reader.js';
import { nowIsoUtc } from '../utils/datetime.js';
import { createEventLoopYieldState, pollCancelAndYield } from '../utils/yield.js';
import {
  buildFolderCatalogRecords,
  createFolderExifSession,
} from './exif-read.js';
import { lstatPathsParallel, type FileStatSnapshot } from './lstat-parallel.js';
import { markStaleIfPreviewPhashChanged } from './preview-stale.js';
import {
  batchResolvedPhotos,
  rememberFolderCatalogWalkSummary,
  walkFolderCatalog,
  type ResolvedFolderPhoto,
} from './walk.js';

export const FOLDER_CATALOG_SYNCED_META_KEY = 'folder_catalog_synced_at';
/** Matches the first-run import checklist label (no trailing ellipsis). */
export const FOLDER_CATALOG_READ_PROGRESS = 'Reading the folder';
const SYNC_BATCH_SIZE = 64;
const UNREADABLE_PATH_LOG_LIMIT = 5;
const UNREADABLE_DIR_LOG_LIMIT = 5;

export interface SyncFolderCatalogOptions {
  log?: (level: string, message: string) => void;
  progress?: (pct: number, message: string) => void;
  isCancelled?: () => boolean | Promise<boolean>;
}

export interface FolderSyncReport {
  added: number;
  stale: number;
  changed: number;
  moved: number;
  newly_gone: number;
  collisions: number;
  unreadable: number;
  walk_ms: number;
  stat_ms: number;
}

export type FolderCatalogSyncResult = CatalogSyncResult & FolderSyncReport;

export interface SyncFolderCatalogOutcome {
  result: FolderCatalogSyncResult;
  cancelled: boolean;
  unreadablePaths: string[];
  unreadableDirectories: string[];
}

interface DiskPhoto {
  photo: ResolvedFolderPhoto;
  stat: FileStatSnapshot;
}

interface SyncPlan {
  toRead: DiskPhoto[];
  goneRows: FolderLibraryRow[];
  newOnDisk: DiskPhoto[];
  unreadablePaths: string[];
}

function fileSignature(stat: FileStatSnapshot): string {
  return `${stat.size}:${stat.mtimeMs}`;
}

function rowSignature(row: FolderLibraryRow): string {
  return `${row.file_size}:${row.catalog_file_mtime ?? 0}`;
}

function buildSyncPlan(
  photos: readonly ResolvedFolderPhoto[],
  statsByPath: ReadonlyMap<string, FileStatSnapshot>,
  dbRows: readonly FolderLibraryRow[],
): SyncPlan {
  const diskByRel = new Map<string, DiskPhoto>();
  const unreadablePaths: string[] = [];
  for (const photo of photos) {
    const stat = statsByPath.get(photo.filepath);
    if (!stat?.readable) {
      unreadablePaths.push(photo.relPath);
      continue;
    }
    diskByRel.set(photo.relPath, { photo, stat });
  }

  const dbByRel = new Map<string, FolderLibraryRow>();
  for (const row of dbRows) {
    if (row.id) dbByRel.set(row.id, row);
  }

  const toRead: DiskPhoto[] = [];
  const newOnDisk: DiskPhoto[] = [];

  for (const [relPath, disk] of diskByRel) {
    const row = dbByRel.get(relPath);
    if (!row) {
      newOnDisk.push(disk);
      continue;
    }
    if (rowSignature(row) !== fileSignature(disk.stat)) {
      toRead.push(disk);
    }
  }

  const seenRel = new Set(diskByRel.keys());
  const goneRows = dbRows.filter((row) => row.id && !seenRel.has(row.id));

  return { toRead, goneRows, newOnDisk, unreadablePaths };
}

function recordForDisk(disk: DiskPhoto, tags: import('exiftool-vendored').Tags): CatalogRecord {
  const sizeByPath = new Map([[disk.photo.filepath, disk.stat.size]]);
  return buildFolderCatalogRecords([disk.photo], new Map([[disk.photo.filepath, tags]]), sizeByPath)[0]!;
}

export async function syncFolderCatalog(
  catalogRoot: string,
  libDb: Db,
  opts: SyncFolderCatalogOptions = {},
): Promise<SyncFolderCatalogOutcome> {
  const log = opts.log ?? (() => {});
  upgradeLibrarySchema(libDb);

  if (!existsSync(catalogRoot)) {
    throw new Error(`Catalog not found: ${catalogRoot}`);
  }

  const yieldState = createEventLoopYieldState();
  const isCancelled = opts.isCancelled ?? (() => false);

  const walkStart = Date.now();
  const { photos, stats, unreadableDirectories } = walkFolderCatalog(catalogRoot);
  rememberFolderCatalogWalkSummary(catalogRoot, { stats, unreadableDirectories });
  const walkMs = Date.now() - walkStart;

  if (await pollCancelAndYield(libDb, isCancelled, yieldState)) {
    return cancelledOutcome(stats.photoCount, walkMs, 0, unreadableDirectories, [], libDb);
  }

  log(
    'info',
    `[cache] [sync] walk_ms=${walkMs} photos=${stats.photoCount} folders=${stats.folderCount}`,
  );

  const statStart = Date.now();
  const statsByPath = await lstatPathsParallel(
    photos.map((p) => p.filepath),
    32,
  );
  const statMs = Date.now() - statStart;

  const dbRows = listFolderLibraryRows(libDb);
  const plan = buildSyncPlan(photos, statsByPath, dbRows);
  const keysInDb = new Set(dbRows.map((r) => r.key));

  const counters = {
    added: 0,
    changed: 0,
    moved: 0,
    collisions: 0,
    unreadable: plan.unreadablePaths.length,
  };

  const exif = createFolderExifSession();
  try {
    const newTags = await exif.readParallel(plan.newOnDisk.map((d) => d.photo.filepath));
    const movePairs: { row: FolderLibraryRow; disk: DiskPhoto; record: CatalogRecord }[] = [];
    const stillNew: DiskPhoto[] = [];

    for (const disk of plan.newOnDisk) {
      const tags = newTags.get(disk.photo.filepath) ?? {};
      const record = recordForDisk(disk, tags);
      const goneMatches = plan.goneRows.filter(
        (g) =>
          g.file_size === disk.stat.size &&
          g.date_taken === record.date_taken &&
          !movePairs.some((m) => m.row.key === g.key),
      );
      if (goneMatches.length === 1) {
        movePairs.push({
          row: goneMatches[0]!,
          disk,
          record: { ...record, key: goneMatches[0]!.key },
        });
      } else {
        stillNew.push(disk);
      }
    }

    if (await pollCancelAndYield(libDb, isCancelled, yieldState)) {
      return cancelledOutcome(
        stats.photoCount,
        walkMs,
        statMs,
        unreadableDirectories,
        plan.unreadablePaths,
        libDb,
      );
    }

    libraryWrite(libDb, () => {
      for (const { row, disk, record } of movePairs) {
        applyFolderMove(libDb, row.key, record, disk.stat.mtimeMs);
        counters.moved += 1;
      }
    });
    for (const { row, disk } of movePairs) {
      await markStaleIfPreviewPhashChanged(libDb, row.key, disk.photo.filepath);
    }

    // Edits keep the key the row first got; only genuinely new files mint one.
    const existingKeyByRel = new Map<string, string>();
    for (const disk of plan.toRead) {
      const row = dbRows.find((r) => r.id === disk.photo.relPath);
      if (row) existingKeyByRel.set(disk.photo.relPath, row.key);
    }

    const readQueue = [...plan.toRead, ...stillNew];
    const batches = [...batchResolvedPhotos(readQueue.map((d) => d.photo), SYNC_BATCH_SIZE)];

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const photoBatch = batches[batchIndex]!;
      const diskBatch = photoBatch.map(
        (p) => readQueue.find((d) => d.photo.relPath === p.relPath)!,
      );
      const tagsByPath = await exif.readParallel(diskBatch.map((d) => d.photo.filepath));
      const sizeByPath = new Map(diskBatch.map((d) => [d.photo.filepath, d.stat.size]));
      const records = buildFolderCatalogRecords(
        diskBatch.map((d) => d.photo),
        tagsByPath,
        sizeByPath,
      );

      if (await pollCancelAndYield(libDb, isCancelled, yieldState)) {
        return cancelledOutcome(
          stats.photoCount,
          walkMs,
          statMs,
          unreadableDirectories,
          plan.unreadablePaths,
          libDb,
          counters,
        );
      }

      const mtimeByKey = new Map<string, number>();
      for (const disk of diskBatch) {
        const rec = recordForDisk(disk, tagsByPath.get(disk.photo.filepath) ?? {});
        mtimeByKey.set(rec.key, disk.stat.mtimeMs);
      }

      const changedRelPaths = new Set<string>();
      libraryWrite(libDb, () => {
        const inserts: CatalogRecord[] = [];
        for (const record of records) {
          const rel = String(record.id);
          const disk = diskBatch.find((d) => d.photo.relPath === rel);
          if (!disk) continue;
          // Identity is the path. An edited row keeps the key it was first given;
          // a new path either takes an in-DB key's slot (a collision) or inserts.
          const existingKey = existingKeyByRel.get(rel);
          if (existingKey !== undefined) {
            updateFolderRecordInPlace(libDb, existingKey, record, disk.stat.mtimeMs, true);
            counters.changed += 1;
            changedRelPaths.add(rel);
            continue;
          }
          if (!keysInDb.has(record.key)) {
            inserts.push(record);
            keysInDb.add(record.key);
            continue;
          }
          const existing = dbRows.find((r) => r.key === record.key);
          if (existing && existing.id !== rel) counters.collisions += 1;
          updateFolderRecordInPlace(libDb, record.key, record, disk.stat.mtimeMs, true);
          counters.changed += 1;
          changedRelPaths.add(rel);
        }
        counters.added += insertFolderRecords(libDb, inserts, mtimeByKey);
      });

      for (const record of records) {
        const rel = String(record.id);
        const disk = diskBatch.find((d) => d.photo.relPath === rel);
        if (!disk) continue;
        if (changedRelPaths.has(rel)) {
          const key = existingKeyByRel.get(rel) ?? record.key;
          await markStaleIfPreviewPhashChanged(libDb, key, disk.photo.filepath);
        }
      }

      const pct = 10 + Math.trunc((80 * (batchIndex + 1)) / Math.max(batches.length, 1));
      opts.progress?.(pct, FOLDER_CATALOG_READ_PROGRESS);
    }

    const movedGoneKeys = new Set(movePairs.map((m) => m.row.key));
    const goneKeys = plan.goneRows.filter((g) => !movedGoneKeys.has(g.key)).map((g) => g.key);
    const sinceIso = nowIsoUtc();
    let newlyGone = 0;
    libraryWrite(libDb, () => {
      newlyGone = markFolderPhotosGone(libDb, goneKeys, sinceIso);
    });

    const staleRow = libDb.prepare(
      'SELECT COUNT(*) AS c FROM images WHERE catalog_missing_since IS NOT NULL',
    ).get() as { c: number };
    const stale = Math.trunc(staleRow.c);

    libraryWrite(libDb, () => setLibraryMeta(libDb, FOLDER_CATALOG_SYNCED_META_KEY, sinceIso));

    logUnreadable(log, plan.unreadablePaths, unreadableDirectories);

    log(
      'info',
      `[cache] [sync] added=${counters.added} stale=${stale} changed=${counters.changed} ` +
        `moved=${counters.moved} newly_gone=${newlyGone} collisions=${counters.collisions} ` +
        `unreadable=${counters.unreadable} walk_ms=${walkMs} stat_ms=${statMs}`,
    );
    opts.progress?.(100, 'Folder read complete');

    const libraryTotal = libDb.prepare('SELECT COUNT(*) AS c FROM images').get() as { c: number };

    return {
      result: {
        added: counters.added,
        stale,
        changed: counters.changed,
        moved: counters.moved,
        newly_gone: newlyGone,
        collisions: counters.collisions,
        unreadable: counters.unreadable,
        walk_ms: walkMs,
        stat_ms: statMs,
        locking_mode: 'folder',
        catalog_total: stats.photoCount,
        library_total: Math.trunc(libraryTotal.c),
        missing_ids_count: 0,
        keywords_backfilled: 0,
        orientations_updated: 0,
        orientation_stale: 0,
      },
      cancelled: false,
      unreadablePaths: plan.unreadablePaths,
      unreadableDirectories,
    };
  } finally {
    await exif.end();
  }
}

function logUnreadable(
  log: (level: string, message: string) => void,
  paths: readonly string[],
  dirs: readonly string[],
): void {
  if (dirs.length) {
    const sample = dirs.slice(0, UNREADABLE_DIR_LOG_LIMIT).join(', ');
    log('warning', `[cache] [sync] unreadable_directories=${dirs.length} sample=${sample}`);
  }
  if (paths.length) {
    const sample = paths.slice(0, UNREADABLE_PATH_LOG_LIMIT).join(', ');
    log('warning', `[cache] [sync] unreadable=${paths.length} sample=${sample}`);
  }
}

function cancelledOutcome(
  catalogTotal: number,
  walkMs: number,
  statMs: number,
  unreadableDirectories: string[],
  unreadablePaths: string[],
  libDb: Db,
  partial?: { added: number; changed: number; moved: number; collisions: number; unreadable: number },
): SyncFolderCatalogOutcome {
  const libraryTotal = libDb.prepare('SELECT COUNT(*) AS c FROM images').get() as { c: number };
  return {
    result: {
      added: partial?.added ?? 0,
      stale: 0,
      changed: partial?.changed ?? 0,
      moved: partial?.moved ?? 0,
      newly_gone: 0,
      collisions: partial?.collisions ?? 0,
      unreadable: partial?.unreadable ?? unreadablePaths.length,
      walk_ms: walkMs,
      stat_ms: statMs,
      locking_mode: 'folder',
      catalog_total: catalogTotal,
      library_total: Math.trunc(libraryTotal.c),
      missing_ids_count: 0,
      keywords_backfilled: 0,
      orientations_updated: 0,
      orientation_stale: 0,
    },
    cancelled: true,
    unreadablePaths,
    unreadableDirectories,
  };
}
