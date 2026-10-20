/**
 * Resolve the Lightroom catalog SQLite mirror path used by job handlers.
 *
 * Resolution order, first hit wins:
 *   1. the `LIBRARY_DB` environment variable
 *   2. `db_path` from `config.LT_CONFIG_YAML` (the repo-level `config.yaml` unless overridden)
 *   3. `library.db` relative to the working directory (legacy default)
 *
 * `describeLibraryDb()` never throws: it returns a structured status including *why*
 * resolution failed, because that reason is rendered as a banner in the UI. A job
 * type that cannot run without the catalog is refused at enqueue time rather than
 * accepted and failed later, so the reason has to be presentable.
 */
import { statSync } from 'node:fs';
import { config, loadLibraryConfig } from '../config.js';

export type LibraryDbSource = 'env' | 'config' | 'default' | 'none';

export interface LibraryDbStatus {
  path: string | null;
  source: LibraryDbSource;
  exists: boolean;
  /** Human-readable explanation when unavailable. */
  reason: string | null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolve the library DB path and report whether it exists. */
export function describeLibraryDb(): LibraryDbStatus {
  const envValue = process.env.LIBRARY_DB;
  if (envValue) {
    const exists = isFile(envValue);
    return {
      path: envValue,
      source: 'env',
      exists,
      reason: exists
        ? null
        : `LIBRARY_DB is set to '${envValue}' but that file does not exist.`,
    };
  }

  const configPath = config.LT_CONFIG_YAML;
  try {
    const cfg = loadLibraryConfig(configPath);
    if (cfg.dbPath) {
      const exists = isFile(cfg.dbPath);
      return {
        path: cfg.dbPath,
        source: 'config',
        exists,
        reason: exists
          ? null
          : `config.yaml db_path is '${cfg.dbPath}' but that file does not exist. ` +
            'Run the catalog import to create it, or set LIBRARY_DB to override.',
      };
    }
  } catch (e) {
    return {
      path: null,
      source: 'none',
      exists: false,
      reason: `Failed to load ${configPath}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const defaultPath = 'library.db';
  const exists = isFile(defaultPath);
  return {
    path: exists ? defaultPath : null,
    source: exists ? 'default' : 'none',
    exists,
    reason: exists
      ? null
      : 'No LIBRARY_DB env var, no db_path in config.yaml, and no library.db in the ' +
        'current working directory. Set LIBRARY_DB or configure db_path in config.yaml.',
  };
}

/** The resolved path when it exists, otherwise `null`. */
export function resolveLibraryDb(): string | null {
  const status = describeLibraryDb();
  return status.exists ? status.path : null;
}

/** The resolved path, or throw with the reason a health endpoint would show. */
export function requireLibraryDb(): string {
  const status = describeLibraryDb();
  if (status.exists && status.path) return status.path;
  throw new Error(status.reason ?? 'Library database is not configured.');
}
