/**
 * Where the running app finds the open library's `library.db` and its vision cache
 * folder — one resolution chain for the server, jobs, routes and CLI.
 */
import { config, loadLibraryConfig, resolveLibraryDbLocation, type LibraryConfig } from './config.js';

export interface OpenLibraryPaths {
  libraryDbPath: string;
  visionCacheDir: string;
}

/**
 * Server, API middleware, job handlers, and startup: `LIBRARY_DB`, then
 * `db_path`, then the data-folder default; vision cache from `vision_cache_dir`
 * or its default.
 */
export function resolveOpenLibraryPaths(): OpenLibraryPaths {
  return {
    libraryDbPath: resolveLibraryDbLocation().path,
    visionCacheDir: loadLibraryConfig(config.LT_CONFIG_YAML).visionCacheDir,
  };
}

/**
 * CLI commands that open the library: `--db` when given, else `db_path` from the
 * loaded config (no `LIBRARY_DB` env or data-folder default). Vision cache matches
 * that same config file.
 */
export function resolveOpenLibraryPathsForCli(
  libraryConfig: LibraryConfig,
  cliDbFlag: string | undefined,
): OpenLibraryPaths {
  return {
    libraryDbPath: cliDbFlag ?? libraryConfig.dbPath ?? '',
    visionCacheDir: libraryConfig.visionCacheDir,
  };
}
