/**
 * Where the running app finds the open library's `library.db` and its vision cache
 * folder — one resolution chain for the server, jobs and routes. The CLI applies its
 * own `--db` / `--catalog` rules over the same lookup (`cli/library-resolution.ts`).
 */
import { existsSync } from 'node:fs';
import { config } from './config.js';
import { resolveCatalogLibraryPaths } from './catalog-library.js';
import { initLibraryDb } from './db/library/bootstrap.js';

export interface OpenLibraryPaths {
  libraryDbPath: string;
  visionCacheDir: string;
}

/**
 * Server, API middleware, job handlers, and startup: `LIBRARY_DB` when set, else
 * the library under `catalogs/` whose `library_meta` matches `catalog_path`.
 */
export function resolveOpenLibraryPaths(): OpenLibraryPaths {
  const { libraryDbPath, visionCacheDir } = resolveCatalogLibraryPaths(config.LT_CONFIG_YAML);
  return { libraryDbPath, visionCacheDir };
}

/**
 * The library the server opens at startup. A data folder (`LT_DATA_DIR`) with no
 * catalog set yet gets an empty `library.db`: the desktop app waits for `/api/health`
 * before it shows anything, including the screen that sets the catalog.
 */
export function prepareStartupLibrary(): string {
  const { libraryDbPath, catalogFolder } = resolveCatalogLibraryPaths(config.LT_CONFIG_YAML);
  if (!catalogFolder && process.env.LT_DATA_DIR && !existsSync(libraryDbPath)) {
    initLibraryDb(libraryDbPath).close();
  }
  return libraryDbPath;
}
