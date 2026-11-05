/**
 * Where the running app finds the open library's `library.db` and its vision cache
 * folder — one resolution chain for the server, jobs, routes and CLI.
 */
import { dirname, join } from 'node:path';
import { config, type LibraryConfig } from './config.js';
import {
  resolveCatalogLibraryPaths,
  runLegacyUpgradeOnce,
  type CatalogLibraryPaths,
} from './catalog-library.js';

export interface OpenLibraryPaths {
  libraryDbPath: string;
  visionCacheDir: string;
}

function toOpenLibrary(paths: CatalogLibraryPaths): OpenLibraryPaths {
  return { libraryDbPath: paths.libraryDbPath, visionCacheDir: paths.visionCacheDir };
}

/**
 * Server, API middleware, job handlers, and startup: `LIBRARY_DB` when set, else
 * the library under `catalogs/` whose `library_meta` matches `catalog_path`.
 */
export function resolveOpenLibraryPaths(): OpenLibraryPaths {
  return toOpenLibrary(resolveCatalogLibraryPaths(config.LT_CONFIG_YAML));
}

/**
 * CLI commands that open the library: `--db` when given, else the same catalog
 * lookup the server uses (including legacy upgrade on first open).
 */
export function resolveOpenLibraryPathsForCli(
  _libraryConfig: LibraryConfig,
  cliDbFlag: string | undefined,
  configPath = config.LT_CONFIG_YAML,
): OpenLibraryPaths {
  if (cliDbFlag) {
    return {
      libraryDbPath: cliDbFlag,
      visionCacheDir: join(dirname(cliDbFlag), 'vision-cache'),
    };
  }
  runLegacyUpgradeOnce(configPath);
  return toOpenLibrary(resolveCatalogLibraryPaths(configPath));
}
