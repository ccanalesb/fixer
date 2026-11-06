/**
 * Resolve which `library.db` and catalog path the CLI opens — the server's lookup
 * (`catalog-library.ts`), with stricter rules for `--catalog` and library creation.
 */
import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import {
  absoluteCatalogPath,
  catalogPathFromConfig,
  CATALOG_PATH_META_KEY,
  createCatalogLibrary,
  findCatalogLibrary,
  legacyUpgradeLines,
  libraryPathsAt,
  recordCatalog,
  runLegacyUpgradeOnce,
  type CatalogLibraryPaths,
} from '../catalog-library.js';
import { config } from '../config.js';
import type { Db } from '../db/connection.js';
import { getLibraryMeta } from '../db/library/bootstrap.js';
import type { CommandContext } from './registry.js';
import { stringFlag } from './parse.js';
import { CliError } from './library-db.js';

export const NO_LIBRARY_FOR_CATALOG_MSG = (catalogPath: string) =>
  `No library for ${catalogPath}. Choose it in the app (Settings → Catalog) or set catalog_path in config.yaml`;

const NO_CATALOG_MSG = 'No catalog path provided. Use --catalog or config.yaml';

const SYNCED_CATALOG_PATH_META_KEY = 'synced_catalog_path';

function legacySyncedCatalogPath(db: Db): string | null {
  const raw = getLibraryMeta(db, SYNCED_CATALOG_PATH_META_KEY);
  if (!raw) return null;
  const abs = absoluteCatalogPath(raw);
  if (!abs || !existsSync(abs)) return null;
  return abs;
}

function looksLikeMovedLightroomCatalog(recorded: string, requested: string): boolean {
  const rec = absoluteCatalogPath(recorded);
  const req = absoluteCatalogPath(requested);
  if (!rec || !req) return false;
  if (!rec.toLowerCase().endsWith('.lrcat') || !req.toLowerCase().endsWith('.lrcat')) return false;
  return basename(rec) === basename(req) && dirname(rec) !== dirname(req);
}

function libraryBelongsToError(dbPath: string, recorded: string, requested?: string): string {
  let msg = `library.db at ${dbPath} belongs to ${recorded}`;
  if (requested && looksLikeMovedLightroomCatalog(recorded, requested)) {
    msg += '. The catalog can be re-pointed in the app (Settings → Catalog)';
  }
  return msg;
}

/** `--catalog`, absolute, refusing one that is not there. */
function existingCatalogFlag(ctx: CommandContext): string | null {
  const catalogFlag = stringFlag(ctx.args, 'catalog');
  if (!catalogFlag) return null;
  const catalogAbs = absoluteCatalogPath(catalogFlag);
  if (!catalogAbs || !existsSync(catalogAbs)) {
    throw new CliError(`Catalog not found: ${catalogFlag}`);
  }
  return catalogAbs;
}

/** Run the one-time legacy layout upgrade when the CLI is not pinned with `--db`. */
export function runCliLegacyUpgrade(ctx: CommandContext): void {
  if (stringFlag(ctx.args, 'db')) return;
  const result = runLegacyUpgradeOnce(config.LT_CONFIG_YAML);
  if (result) {
    for (const line of legacyUpgradeLines(result)) ctx.out(line);
  }
}

function libraryForCatalog(catalogAbs: string, mayCreate: boolean): CatalogLibraryPaths {
  const found = findCatalogLibrary(catalogAbs);
  if (found) return found;
  if (mayCreate) return createCatalogLibrary(catalogAbs);
  throw new CliError(NO_LIBRARY_FOR_CATALOG_MSG(catalogAbs));
}

export interface ResolvedCliLibrary {
  paths: CatalogLibraryPaths;
  /** Absolute catalog path this command should sync or scan; `null` under `--db` without `--catalog`. */
  catalogPath: string | null;
}

/**
 * Where to open `library.db` and which catalog path scan/sync should use.
 *
 * @param allowCreateLibrary - only `scan` / `sync` without `--catalog` may create a library for `config.yaml`'s catalog.
 */
export function resolveCliLibrary(ctx: CommandContext, allowCreateLibrary: boolean): ResolvedCliLibrary {
  runCliLegacyUpgrade(ctx);

  const dbFlag = stringFlag(ctx.args, 'db');
  const requested = existingCatalogFlag(ctx);
  if (dbFlag) return { paths: libraryPathsAt(dbFlag), catalogPath: requested };
  if (requested) return { paths: libraryForCatalog(requested, false), catalogPath: requested };

  const configCatalog = catalogPathFromConfig(ctx.config);
  if (!configCatalog) throw new CliError(NO_CATALOG_MSG);
  return { paths: libraryForCatalog(configCatalog, allowCreateLibrary), catalogPath: configCatalog };
}

/**
 * Catalog path for `scan` / `sync` with an explicit `--db`: the one the library
 * records, else `--catalog`, its legacy `synced_catalog_path` or `config.yaml`'s,
 * which is then recorded. Another catalog than the recorded one is refused.
 */
export function resolvePinnedScanSyncCatalog(
  db: Db,
  dbPath: string,
  ctx: CommandContext,
): string {
  const recorded = getLibraryMeta(db, CATALOG_PATH_META_KEY);
  const requested = existingCatalogFlag(ctx);

  if (recorded) {
    if (requested && absoluteCatalogPath(recorded) !== requested) {
      throw new CliError(libraryBelongsToError(dbPath, recorded, requested));
    }
    return requested ?? recorded;
  }

  const chosen = requested ?? legacySyncedCatalogPath(db) ?? catalogPathFromConfig(ctx.config);
  if (!chosen) throw new CliError(NO_CATALOG_MSG);
  recordCatalog(db, chosen);
  return chosen;
}
