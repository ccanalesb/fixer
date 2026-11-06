/**
 * The two commands that read a catalog into `library.db`: `scan` and `sync`.
 */
import { existsSync } from 'node:fs';
import { storeImagesBatch } from '../../db/library/catalog.js';
import { libraryWrite } from '../../db/library/write.js';
import { syncFolderCatalog } from '../../folder/sync.js';
import { syncCatalog } from '../../lightroom/catalog-sync.js';
import {
  connectCatalogReadOnly,
  getImageCount,
  getImageRecords,
} from '../../lightroom/reader.js';
import { inferCatalogKind } from '../../catalog-library.js';
import type { Db } from '../../db/connection.js';
import { resolvePinnedScanSyncCatalog } from '../library-resolution.js';
import { CliError, cliLibraryPinned, withLibraryDbAsync } from '../library-db.js';
import { boolFlag, intFlag } from '../parse.js';
import type { CommandContext } from '../registry.js';

const UNREADABLE_LOG_LIMIT = 5;

function resolveScanSyncCatalogPath(
  ctx: CommandContext,
  db: Db,
  dbPath: string,
  catalogFromLookup: string | null,
): string {
  if (cliLibraryPinned(ctx)) return resolvePinnedScanSyncCatalog(db, dbPath, ctx);
  if (!catalogFromLookup) throw new CliError('No catalog path provided. Use --catalog or config.yaml');
  return catalogFromLookup;
}

function refuseFolderOnlyFlags(ctx: CommandContext, catalogPath: string): void {
  if (inferCatalogKind(catalogPath) !== 'folder') return;
  if (intFlag(ctx.args, 'limit') != null) {
    throw new CliError('scan --limit is not supported for a folder catalog');
  }
  if (boolFlag(ctx.args, 'backfill-keywords')) {
    throw new CliError('sync --backfill-keywords is not supported for a folder catalog');
  }
}

async function runFolderSyncCli(
  ctx: CommandContext,
  catalogPath: string,
  db: Db,
): Promise<number> {
  ctx.out(`Syncing folder: ${catalogPath}`);
  const logLines: string[] = [];
  const { result, unreadablePaths } = await syncFolderCatalog(catalogPath, db, {
    log: (_level, message) => {
      logLines.push(message);
    },
  });
  for (const line of logLines) {
    if (line.startsWith('[cache] [sync]')) ctx.out(line.slice('[cache] [sync]'.length).trimStart());
  }
  if (unreadablePaths.length) {
    const sample = unreadablePaths.slice(0, UNREADABLE_LOG_LIMIT).join(', ');
    ctx.out(`Unreadable (${unreadablePaths.length}): ${sample}`);
  }
  return 0;
}

export async function cmdScan(ctx: CommandContext): Promise<number> {
  return withLibraryDbAsync(ctx, { mustExist: false, allowCreateLibrary: true }, async (db, dbPath, catalogFromLookup) => {
    const catalogPath = resolveScanSyncCatalogPath(ctx, db, dbPath, catalogFromLookup);
    refuseFolderOnlyFlags(ctx, catalogPath);

    if (inferCatalogKind(catalogPath) === 'folder') {
      return runFolderSyncCli(ctx, catalogPath, db);
    }

    if (!existsSync(catalogPath)) throw new CliError(`Catalog not found: ${catalogPath}`);
    ctx.out(`Scanning catalog: ${catalogPath}`);

    const catalog = connectCatalogReadOnly(catalogPath);
    let records;
    try {
      const total = getImageCount(catalog);
      if (boolFlag(ctx.args, 'verbose')) ctx.out(`Total images in catalog: ${total}`);
      records = getImageRecords(catalog, intFlag(ctx.args, 'limit'));
    } finally {
      catalog.close();
    }

    ctx.out(`Retrieved ${records.length} image records`);
    const count = libraryWrite(db, () => storeImagesBatch(db, records));
    ctx.out(`Indexed ${count} images to ${dbPath}`);
    return 0;
  });
}

export async function cmdSync(ctx: CommandContext): Promise<number> {
  return withLibraryDbAsync(ctx, { mustExist: false, allowCreateLibrary: true }, async (db, dbPath, catalogFromLookup) => {
    const catalogPath = resolveScanSyncCatalogPath(ctx, db, dbPath, catalogFromLookup);
    refuseFolderOnlyFlags(ctx, catalogPath);

    if (inferCatalogKind(catalogPath) === 'folder') {
      return runFolderSyncCli(ctx, catalogPath, db);
    }

    if (!existsSync(catalogPath)) throw new CliError(`Catalog not found: ${catalogPath}`);
    ctx.out(`Syncing catalog: ${catalogPath}`);
    const { result } = await syncCatalog(catalogPath, db, {
      backfillKeywords: boolFlag(ctx.args, 'backfill-keywords'),
    });
    ctx.out(
      `Added ${result.added} images; ${result.stale} stale in library; ` +
        `${result.keywords_backfilled} keywords backfilled ` +
        `(locking_mode=${result.locking_mode})`,
    );
    return 0;
  });
}
