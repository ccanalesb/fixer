/**
 * Resolve which `library.db` and catalog path the CLI opens — same lookup as the
 * server, with stricter rules for `--catalog` and library creation.
 */
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  absoluteCatalogPath,
  CatalogLibraryConflictError,
  CATALOG_KIND_META_KEY,
  CATALOG_PATH_META_KEY,
  createCatalogLibrary,
  findCatalogLibrariesForPath,
  inferCatalogKind,
  runLegacyUpgradeOnce,
  type CatalogLibraryPaths,
  type LegacyUpgradeResult,
} from '../catalog-library.js';
import { config } from '../config.js';
import { openLibraryDb, type Db } from '../db/connection.js';
import { getLibraryMeta, setLibraryMeta } from '../db/library/bootstrap.js';
import { libraryWrite } from '../db/library/write.js';
import type { CommandContext } from './registry.js';
import { stringFlag } from './parse.js';
import { CliError } from './library-db.js';

export const NO_LIBRARY_FOR_CATALOG_MSG = (catalogPath: string) =>
  `No library for ${catalogPath}. Choose it in the app (Settings → Catalog) or set catalog_path in config.yaml`;

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

function configuredCatalogAbsolute(ctx: CommandContext): string | null {
  const raw = ctx.config.catalogPathRaw.trim();
  if (!raw) return ctx.config.catalogPath || null;
  const abs = absoluteCatalogPath(raw);
  return abs || null;
}

function pathsFromEntry(entry: { libraryDbPath: string; visionCacheDir: string; catalogFolder: string }): CatalogLibraryPaths {
  return {
    libraryDbPath: entry.libraryDbPath,
    visionCacheDir: entry.visionCacheDir,
    catalogFolder: entry.catalogFolder,
  };
}

function assertNoConflict(matches: ReturnType<typeof findCatalogLibrariesForPath>): void {
  if (matches.length <= 1) return;
  const names = matches.map((e) => e.catalogFolder);
  throw new CatalogLibraryConflictError(
    `Two libraries claim the same catalog path (${matches[0]!.catalogPath}): ${names.join(' and ')}.`,
  );
}

export function printLegacyUpgradeLines(result: LegacyUpgradeResult): string[] {
  return [
    `Moved library.db from ${result.fromLibraryPath} to ${result.libraryDbPath}`,
    `Moved vision cache from ${result.fromVisionCacheDir} to ${result.visionCacheDir}`,
  ];
}

/** Run the one-time legacy layout upgrade when the CLI is not pinned with `--db`. */
export function runCliLegacyUpgrade(ctx: CommandContext): void {
  if (stringFlag(ctx.args, 'db')) return;
  const result = runLegacyUpgradeOnce(config.LT_CONFIG_YAML);
  if (result) {
    for (const line of printLegacyUpgradeLines(result)) ctx.out(line);
  }
}

function resolveLibraryForCatalogPath(
  catalogAbs: string,
  opts: { allowCreate: boolean; configCatalogAbs: string | null },
): CatalogLibraryPaths {
  const matches = findCatalogLibrariesForPath(catalogAbs);
  assertNoConflict(matches);
  if (matches.length === 1) {
    return pathsFromEntry(matches[0]!);
  }
  if (opts.allowCreate && opts.configCatalogAbs && absoluteCatalogPath(catalogAbs) === opts.configCatalogAbs) {
    return createCatalogLibrary(catalogAbs);
  }
  throw new CliError(NO_LIBRARY_FOR_CATALOG_MSG(catalogAbs));
}

export interface ResolvedCliLibrary {
  paths: CatalogLibraryPaths;
  /** Absolute catalog path this command should sync or scan. */
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
  const catalogFlag = stringFlag(ctx.args, 'catalog');
  const configCatalog = configuredCatalogAbsolute(ctx);

  if (dbFlag) {
    const paths: CatalogLibraryPaths = {
      libraryDbPath: dbFlag,
      visionCacheDir: join(dirname(dbFlag), 'vision-cache'),
      catalogFolder: null,
    };
    if (catalogFlag) {
      const catalogAbs = absoluteCatalogPath(catalogFlag);
      if (!catalogAbs || !existsSync(catalogAbs)) {
        throw new CliError(`Catalog not found: ${catalogFlag}`);
      }
      return { paths, catalogPath: catalogAbs };
    }
    return { paths, catalogPath: null };
  }

  if (catalogFlag) {
    const catalogAbs = absoluteCatalogPath(catalogFlag);
    if (!catalogAbs || !existsSync(catalogAbs)) {
      throw new CliError(`Catalog not found: ${catalogFlag}`);
    }
    const paths = resolveLibraryForCatalogPath(catalogAbs, {
      allowCreate: false,
      configCatalogAbs: configCatalog,
    });
    return { paths, catalogPath: catalogAbs };
  }

  if (!configCatalog) {
    throw new CliError('No catalog path provided. Use --catalog or config.yaml');
  }

  const paths = resolveLibraryForCatalogPath(configCatalog, {
    allowCreate: allowCreateLibrary,
    configCatalogAbs: configCatalog,
  });
  return { paths, catalogPath: configCatalog };
}

/**
 * Catalog path for `scan` / `sync` with an explicit `--db`, recording `config.yaml`'s
 * catalog in the library when the pinned file has none yet.
 */
export function resolvePinnedScanSyncCatalog(
  db: Db,
  dbPath: string,
  ctx: CommandContext,
): string {
  const catalogFlag = stringFlag(ctx.args, 'catalog');
  const configCatalog = configuredCatalogAbsolute(ctx);
  const recorded = getLibraryMeta(db, CATALOG_PATH_META_KEY);

  if (catalogFlag) {
    const requested = absoluteCatalogPath(catalogFlag);
    if (!requested || !existsSync(requested)) {
      throw new CliError(`Catalog not found: ${catalogFlag}`);
    }
    if (recorded && absoluteCatalogPath(recorded) !== requested) {
      throw new CliError(libraryBelongsToError(dbPath, recorded, requested));
    }
    return requested;
  }

  if (recorded) return recorded;

  const legacySynced = legacySyncedCatalogPath(db);
  if (legacySynced) return legacySynced;

  if (!configCatalog) {
    throw new CliError('No catalog path provided. Use --catalog or config.yaml');
  }

  libraryWrite(db, () => {
    setLibraryMeta(db, CATALOG_PATH_META_KEY, configCatalog);
    setLibraryMeta(db, CATALOG_KIND_META_KEY, inferCatalogKind(configCatalog));
  });
  return configCatalog;
}

/** Open the pinned library read-only enough to read `library_meta`. */
export function readPinnedLibraryCatalogPath(dbPath: string): string | null {
  if (!existsSync(dbPath)) return null;
  const db = openLibraryDb(dbPath, { readonly: true });
  try {
    return getLibraryMeta(db, CATALOG_PATH_META_KEY);
  } finally {
    db.close();
  }
}

export function catalogKindAtPath(catalogPath: string): 'lightroom' | 'folder' {
  return inferCatalogKind(catalogPath);
}

export { CatalogLibraryConflictError };
