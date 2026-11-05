/**
 * The two commands that read a `.lrcat` into `library.db`: `scan` and `sync`.
 *
 * `scan` reads the whole catalog and upserts every row; `sync` diffs catalog ids
 * against the ones already indexed and fetches only what is missing. Both run on
 * drivers the visualizer's `catalog_sync` job already uses.
 */
import { existsSync } from 'node:fs';
import { storeImagesBatch } from '../../db/library/catalog.js';
import { libraryWrite } from '../../db/library/write.js';
import { syncCatalog } from '../../lightroom/catalog-sync.js';
import {
  connectCatalogReadOnly,
  getImageCount,
  getImageRecords,
} from '../../lightroom/reader.js';
import { CliError, withLibraryDb, withLibraryDbAsync } from '../library-db.js';
import { boolFlag, intFlag, stringFlag } from '../parse.js';
import type { CommandContext } from '../registry.js';

/** `--catalog` if given, else the configured `.lrcat` from `config.yaml`, and it must exist. */
function resolveCliConfiguredCatalogPath(ctx: CommandContext): string {
  const catalogPath = stringFlag(ctx.args, 'catalog') ?? ctx.config.catalogPath;
  if (!catalogPath) {
    throw new CliError('No catalog path provided. Use --catalog or config.yaml');
  }
  if (!existsSync(catalogPath)) throw new CliError(`Catalog not found: ${catalogPath}`);
  return catalogPath;
}

export function cmdScan(ctx: CommandContext): number {
  const catalogPath = resolveCliConfiguredCatalogPath(ctx);
  ctx.out(`Scanning catalog: ${catalogPath}`);

  // Read-only, as `connect_catalog` is: a scan must not be able to mutate a file
  // Lightroom owns.
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

  return withLibraryDb(ctx, { mustExist: false }, (db, dbPath) => {
    // One transaction for the whole batch — an interrupted run leaves the library untouched.
    const count = libraryWrite(db, () => storeImagesBatch(db, records));
    ctx.out(`Indexed ${count} images to ${dbPath}`);
    return 0;
  });
}

export async function cmdSync(ctx: CommandContext): Promise<number> {
  const catalogPath = resolveCliConfiguredCatalogPath(ctx);

  return withLibraryDbAsync(ctx, { mustExist: false }, async (db) => {
    ctx.out(`Syncing catalog: ${catalogPath}`);
    // No progress or cancellation callbacks: this is a foreground command, and
    // the driver only reports through them when a job runner is listening.
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
