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
  updateFolderMetadataOnly,
  updateFolderRecordInPlace,
  type FolderLibraryRow,
} from '../db/library/folder-sync.js';
import { libraryWrite } from '../db/library/write.js';
import { noteRankingStaleAfterFolderSync } from '../db/library/ranking-stale.js';
import type { CatalogSyncResult } from '../lightroom/catalog-sync.js';
import type { CatalogRecord } from '../lightroom/reader.js';
import { nowIsoUtc } from '../utils/datetime.js';
import { createEventLoopYieldState, pollCancelAndYield } from '../utils/yield.js';
import {
  buildFolderCatalogRecords,
  createFolderExifSession,
  folderPhotoToCatalogRecord,
} from './exif-read.js';
import { lstatPathsParallel, type FileStatSnapshot } from './lstat-parallel.js';
import { markStaleIfPreviewPhashChanged } from './preview-stale.js';
import {
  allSidecarPathsToStat,
  findAmbiguousStemSidecarDirs,
  sidecarPathsForPhoto,
  sidecarSignature,
} from './xmp-sidecars.js';
import { readFolderPhotoXmpMetadata } from './xmp-metadata.js';
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
  metadata_changed: number;
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
  metadataOnly: DiskPhoto[];
  goneRows: FolderLibraryRow[];
  newOnDisk: DiskPhoto[];
  unreadablePaths: string[];
}

function sidecarSigForPhoto(
  photo: ResolvedFolderPhoto,
  ambiguousStemSidecarDirs: ReadonlySet<string>,
  statsByPath: ReadonlyMap<string, FileStatSnapshot>,
): string {
  return sidecarSignature(
    sidecarPathsForPhoto(photo, ambiguousStemSidecarDirs),
    statsByPath,
  );
}

function buildSyncPlan(
  photos: readonly ResolvedFolderPhoto[],
  statsByPath: ReadonlyMap<string, FileStatSnapshot>,
  dbRows: readonly FolderLibraryRow[],
  ambiguousStemSidecarDirs: ReadonlySet<string>,
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
  const metadataOnly: DiskPhoto[] = [];
  const newOnDisk: DiskPhoto[] = [];

  for (const [relPath, disk] of diskByRel) {
    const row = dbByRel.get(relPath);
    if (!row) {
      newOnDisk.push(disk);
      continue;
    }
    const photoChanged = rowSignature(row) !== fileSignature(disk.stat);
    const sideSig = sidecarSigForPhoto(disk.photo, ambiguousStemSidecarDirs, statsByPath);
    const sidecarChanged = (row.catalog_sidecar_sig ?? '') !== sideSig;
    if (photoChanged) {
      toRead.push(disk);
    } else if (sidecarChanged) {
      metadataOnly.push(disk);
    }
  }

  const seenRel = new Set(diskByRel.keys());
  const goneRows = dbRows.filter((row) => row.id && !seenRel.has(row.id));

  return { toRead, metadataOnly, goneRows, newOnDisk, unreadablePaths };
}

function sizeAndDate(size: number, dateTaken: string | null | undefined): string {
  return `${size}\0${dateTaken ?? ''}`;
}

function fileSignature(stat: FileStatSnapshot): string {
  return `${stat.size}:${stat.mtimeMs}`;
}

function rowSignature(row: FolderLibraryRow): string {
  return `${row.file_size}:${row.catalog_file_mtime ?? 0}`;
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
  const walked = await walkFolderCatalog(catalogRoot, {
    shouldStop: () => pollCancelAndYield(libDb, isCancelled, yieldState),
  });
  const walkMs = Date.now() - walkStart;
  if (!walked) return cancelledOutcome(0, walkMs, 0, [], [], libDb);
  const { photos, stats, unreadableDirectories } = walked;
  rememberFolderCatalogWalkSummary(catalogRoot, { stats, unreadableDirectories });

  if (await pollCancelAndYield(libDb, isCancelled, yieldState)) {
    return cancelledOutcome(stats.photoCount, walkMs, 0, unreadableDirectories, [], libDb);
  }

  log(
    'info',
    `[cache] [sync] walk_ms=${walkMs} photos=${stats.photoCount} folders=${stats.folderCount}`,
  );

  const ambiguousStemSidecarDirs = findAmbiguousStemSidecarDirs(photos);
  for (const dir of ambiguousStemSidecarDirs) {
    log('warning', `[cache] [sync] ambiguous_stem_sidecar dir=${dir}`);
  }

  const statStart = Date.now();
  const pathsToStat = [
    ...photos.map((p) => p.filepath),
    ...allSidecarPathsToStat(photos, ambiguousStemSidecarDirs),
  ];
  const statsByPath = await lstatPathsParallel(pathsToStat, 32);
  const statMs = Date.now() - statStart;

  const dbRows = listFolderLibraryRows(libDb);
  const plan = buildSyncPlan(photos, statsByPath, dbRows, ambiguousStemSidecarDirs);
  const dbByKey = new Map(dbRows.map((r) => [r.key, r]));

  const counters = {
    added: 0,
    changed: 0,
    metadata_changed: 0,
    moved: 0,
    collisions: 0,
    unreadable: plan.unreadablePaths.length,
  };

  const dbByRel = new Map<string, FolderLibraryRow>();
  for (const row of dbRows) {
    if (row.id) dbByRel.set(row.id, row);
  }

  const matchedGoneKeys = new Set<string>();
  const goneBySizeAndDate = new Map<string, FolderLibraryRow[]>();
  for (const g of plan.goneRows) {
    const k = sizeAndDate(g.file_size, g.date_taken);
    const group = goneBySizeAndDate.get(k) ?? [];
    group.push(g);
    goneBySizeAndDate.set(k, group);
  }
  const existingKeyByRel = new Map<string, string>();
  for (const disk of plan.toRead) {
    const row = dbByRel.get(disk.photo.relPath);
    if (row) existingKeyByRel.set(disk.photo.relPath, row.key);
  }

  const readQueue = [...plan.toRead, ...plan.newOnDisk];
  const readQueueByRel = new Map(readQueue.map((d) => [d.photo.relPath, d]));
  const batches = [...batchResolvedPhotos(readQueue.map((d) => d.photo), SYNC_BATCH_SIZE)];

  const exif = createFolderExifSession();
  try {
    const needsExif =
      plan.toRead.length + plan.newOnDisk.length + plan.metadataOnly.length > 0;
    if (needsExif) {
      const exifStartError = await exif.ensureReady();
      if (exifStartError) log('error', `[cache] [sync] ${exifStartError}`);
    }

    const movedKeysThisRun = new Set<string>();
    const insertedKeys = new Set<string>();

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const photoBatch = batches[batchIndex]!;
      const diskBatch = photoBatch.map((p) => readQueueByRel.get(p.relPath)!);
      const tagsByPath = await exif.readParallel(diskBatch.map((d) => d.photo.filepath));
      const sizeByPath = new Map(diskBatch.map((d) => [d.photo.filepath, d.stat.size]));
      const xmpByRel = new Map<string, Awaited<ReturnType<typeof readFolderPhotoXmpMetadata>>>();
      for (const disk of diskBatch) {
        xmpByRel.set(
          disk.photo.relPath,
          await readFolderPhotoXmpMetadata(exif, disk.photo, ambiguousStemSidecarDirs, statsByPath),
        );
      }
      const records = buildFolderCatalogRecords(
        diskBatch.map((d) => d.photo),
        tagsByPath,
        sizeByPath,
        xmpByRel,
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
      const sidecarSigByKey = new Map<string, string>();
      const changedRelPaths = new Set<string>();
      const previewStaleKeys: { key: string; filepath: string }[] = [];

      libraryWrite(libDb, () => {
        const inserts: CatalogRecord[] = [];
        for (const record of records) {
          const rel = String(record.id);
          const disk = readQueueByRel.get(rel);
          if (!disk) continue;
          const sideSig = sidecarSigForPhoto(disk.photo, ambiguousStemSidecarDirs, statsByPath);

          const existingKey = existingKeyByRel.get(rel);
          if (existingKey !== undefined) {
            updateFolderRecordInPlace(
              libDb,
              existingKey,
              record,
              disk.stat.mtimeMs,
              true,
              sideSig,
            );
            counters.changed += 1;
            changedRelPaths.add(rel);
            mtimeByKey.set(existingKey, disk.stat.mtimeMs);
            sidecarSigByKey.set(existingKey, sideSig);
            continue;
          }

          const goneMatches = (
            goneBySizeAndDate.get(sizeAndDate(disk.stat.size, record.date_taken)) ?? []
          ).filter((g) => !matchedGoneKeys.has(g.key));
          if (goneMatches.length === 1) {
            const gone = goneMatches[0]!;
            matchedGoneKeys.add(gone.key);
            movedKeysThisRun.add(gone.key);
            applyFolderMove(
              libDb,
              gone.key,
              { ...record, key: gone.key },
              disk.stat.mtimeMs,
              sideSig,
            );
            counters.moved += 1;
            previewStaleKeys.push({ key: gone.key, filepath: disk.photo.filepath });
            continue;
          }

          const existing = dbByKey.get(record.key);
          if (!existing && !insertedKeys.has(record.key)) {
            inserts.push(record);
            insertedKeys.add(record.key);
            mtimeByKey.set(record.key, disk.stat.mtimeMs);
            sidecarSigByKey.set(record.key, sideSig);
            continue;
          }
          if (existing && existing.id !== rel) counters.collisions += 1;
          updateFolderRecordInPlace(libDb, record.key, record, disk.stat.mtimeMs, true, sideSig);
          counters.changed += 1;
          changedRelPaths.add(rel);
          mtimeByKey.set(record.key, disk.stat.mtimeMs);
          sidecarSigByKey.set(record.key, sideSig);
        }
        counters.added += insertFolderRecords(libDb, inserts, mtimeByKey, sidecarSigByKey);
      });

      for (const { key, filepath } of previewStaleKeys) {
        await markStaleIfPreviewPhashChanged(libDb, key, filepath);
      }
      for (const record of records) {
        const rel = String(record.id);
        const disk = readQueueByRel.get(rel);
        if (!disk || !changedRelPaths.has(rel)) continue;
        const key = existingKeyByRel.get(rel) ?? record.key;
        await markStaleIfPreviewPhashChanged(libDb, key, disk.photo.filepath);
      }

      const pct = 10 + Math.trunc((80 * (batchIndex + 1)) / Math.max(batches.length, 1));
      opts.progress?.(pct, FOLDER_CATALOG_READ_PROGRESS);
    }

    for (const disk of plan.metadataOnly) {
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
      const row = dbByRel.get(disk.photo.relPath);
      if (!row) continue;
      const tags = await exif.read(disk.photo.filepath);
      const xmp = await readFolderPhotoXmpMetadata(exif, disk.photo, ambiguousStemSidecarDirs, statsByPath);
      const record = folderPhotoToCatalogRecord(disk.photo, tags, disk.stat.size, xmp);
      const sideSig = sidecarSigForPhoto(disk.photo, ambiguousStemSidecarDirs, statsByPath);
      libraryWrite(libDb, () => {
        updateFolderMetadataOnly(libDb, row.key, record, sideSig);
        counters.metadata_changed += 1;
      });
    }

    const movedGoneKeys = movedKeysThisRun;
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

    noteRankingStaleAfterFolderSync(libDb, {
      added: counters.added,
      changed: counters.changed,
      metadata_changed: counters.metadata_changed,
      moved: counters.moved,
      newly_gone: newlyGone,
    });

    logUnreadable(log, plan.unreadablePaths, unreadableDirectories);

    log(
      'info',
      `[cache] [sync] added=${counters.added} stale=${stale} changed=${counters.changed} ` +
        `metadata_changed=${counters.metadata_changed} moved=${counters.moved} newly_gone=${newlyGone} ` +
        `collisions=${counters.collisions} unreadable=${counters.unreadable} ` +
        `walk_ms=${walkMs} stat_ms=${statMs}`,
    );
    opts.progress?.(100, 'Folder read complete');

    const libraryTotal = libDb.prepare('SELECT COUNT(*) AS c FROM images').get() as { c: number };

    return {
      result: {
        added: counters.added,
        stale,
        changed: counters.changed,
        metadata_changed: counters.metadata_changed,
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
  partial?: {
    added: number;
    changed: number;
    metadata_changed: number;
    moved: number;
    collisions: number;
    unreadable: number;
  },
): SyncFolderCatalogOutcome {
  const libraryTotal = libDb.prepare('SELECT COUNT(*) AS c FROM images').get() as { c: number };
  return {
    result: {
      added: partial?.added ?? 0,
      stale: 0,
      changed: partial?.changed ?? 0,
      metadata_changed: partial?.metadata_changed ?? 0,
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
