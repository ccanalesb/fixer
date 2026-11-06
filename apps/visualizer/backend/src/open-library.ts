/**
 * Where the running app finds the open library's `library.db` and its vision cache
 * folder — one resolution chain for the server, jobs and routes. The CLI applies its
 * own `--db` / `--catalog` rules over the same lookup (`cli/library-resolution.ts`).
 */
import { config } from './config.js';
import { resolveCatalogLibraryPaths } from './catalog-library.js';

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
