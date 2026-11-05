/**
 * Preview and apply a catalog change from Settings — path update vs switch, job
 * cancellation, and catalog sync enqueue.
 */
import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import {
  absoluteCatalogPath,
  CATALOG_KIND_META_KEY,
  CATALOG_PATH_META_KEY,
  findCatalogLibrariesForPath,
  inferCatalogKind,
  invalidateOpenLibraryCache,
  isLibraryDbPinned,
  pinnedLibraryCatalogPath,
  type CatalogKind,
  updatePinnedLibraryCatalogPath,
} from './catalog-library.js';
import { config, expandUserPath, loadLibraryConfig, updateConfigYamlCatalogPath } from './config.js';
import { openLibraryDb, type Db } from './db/connection.js';
import { createJob, getActiveJobs, initJobsDb } from './db/jobs/jobs.js';
import { setLibraryMeta } from './db/library/bootstrap.js';
import { getImageCount } from './db/library/statistics.js';
import { libraryWrite } from './db/library/write.js';
import { catalogRequiringJobTypes } from './jobs/registry.js';
import { transitionCancel } from './jobs/transitions.js';
import { signalCancel } from './jobs/processor.js';

export type CatalogChangeMode = 'update_path' | 'switch';

export interface CatalogSideSummary {
  catalog_path: string;
  resolved_path: string;
  catalog_kind: CatalogKind;
  display_name: string;
  exists: boolean;
  library_photo_count: number | null;
  has_library: boolean;
}

export interface CatalogChangeJobSummary {
  id: string;
  type: string;
  status: string;
}

export interface CatalogChangePreview {
  unchanged: boolean;
  current: CatalogSideSummary;
  next: CatalogSideSummary;
  ask_same_or_different: boolean;
  jobs_to_cancel: CatalogChangeJobSummary[];
}

export interface CatalogChangeResult {
  catalog_path: string;
  change: CatalogChangeMode;
  reopened_library: boolean;
  library_photo_count: number | null;
  catalog_sync_job_id: string | null;
  cancelled_job_ids: string[];
}

function catalogExists(resolved: string): boolean {
  if (!resolved) return false;
  if (resolved.toLowerCase().endsWith('.lrcat')) {
    try {
      return statSync(resolved).isFile();
    } catch {
      return false;
    }
  }
  try {
    return statSync(resolved).isDirectory();
  } catch {
    return false;
  }
}

function displayName(resolved: string): string {
  const base = basename(resolved.replace(/\/$/, ''));
  return base.toLowerCase().endsWith('.lrcat') ? base.slice(0, -'.lrcat'.length) : base;
}

function readLibraryPhotoCount(libraryDbPath: string): number | null {
  if (!existsSync(libraryDbPath)) return null;
  let db: Db | undefined;
  try {
    db = openLibraryDb(libraryDbPath, { readonly: true });
    return getImageCount(db);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function summarizePath(raw: string): CatalogSideSummary {
  const trimmed = raw.trim();
  const resolved = trimmed ? expandUserPath(trimmed) : '';
  const kind = resolved ? inferCatalogKind(resolved) : 'lightroom';
  const matches = resolved ? findCatalogLibrariesForPath(resolved) : [];
  const hasLibrary = matches.length === 1;
  const libraryPhotoCount = hasLibrary ? readLibraryPhotoCount(matches[0]!.libraryDbPath) : null;
  return {
    catalog_path: trimmed,
    resolved_path: resolved,
    catalog_kind: kind,
    display_name: resolved ? displayName(resolved) : '',
    exists: catalogExists(resolved),
    library_photo_count: libraryPhotoCount,
    has_library: hasLibrary,
  };
}

function validateCatalogPathRaw(raw: string): { ok: true; trimmed: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'catalog_path is required' };
  const resolved = expandUserPath(trimmed);
  if (!catalogExists(resolved)) {
    return inferCatalogKind(resolved) === 'lightroom'
      ? { ok: false, error: 'catalog_path must be an existing file' }
      : { ok: false, error: 'catalog_path must be an existing folder' };
  }
  return { ok: true, trimmed };
}

function refusePinnedDifferentCatalog(recorded: string, newRaw: string): boolean {
  if (!isLibraryDbPinned()) return false;
  const recordedAbs = absoluteCatalogPath(recorded);
  const newAbs = absoluteCatalogPath(newRaw);
  const recordedBase = recordedAbs.split('/').pop() ?? '';
  const newBase = newAbs.split('/').pop() ?? '';
  return recordedBase.toLowerCase() !== newBase.toLowerCase();
}

function withJobsDb<T>(fn: (db: Db) => T): T {
  const db = initJobsDb(config.VISUALIZER_DB);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function previewCatalogChange(
  newCatalogPathRaw: string,
  configPath = config.LT_CONFIG_YAML,
): CatalogChangePreview | { error: string } {
  const validated = validateCatalogPathRaw(newCatalogPathRaw);
  if (!validated.ok) return { error: validated.error };

  const cfg = loadLibraryConfig(configPath);
  const current = summarizePath(cfg.catalogPathRaw);
  const next = summarizePath(validated.trimmed);

  if (current.resolved_path && next.resolved_path && current.resolved_path === next.resolved_path) {
    return {
      unchanged: true,
      current,
      next,
      ask_same_or_different: false,
      jobs_to_cancel: [],
    };
  }

  const askSameOrDifferent =
    current.catalog_kind === 'lightroom' &&
    next.catalog_kind === 'lightroom' &&
    !next.has_library &&
    Boolean(current.resolved_path);

  const jobsToCancel = withJobsDb((jobsDb) => {
    const cancellable = catalogRequiringJobTypes();
    return getActiveJobs(jobsDb)
      .filter((job) => cancellable.has(job.type))
      .map((job) => ({ id: job.id, type: job.type, status: job.status }));
  });

  return {
    unchanged: false,
    current,
    next,
    ask_same_or_different: askSameOrDifferent,
    jobs_to_cancel: jobsToCancel,
  };
}

function cancelCatalogJobs(jobsDb: Db): string[] {
  const cancellable = catalogRequiringJobTypes();
  const cancelled: string[] = [];
  for (const job of getActiveJobs(jobsDb)) {
    if (!cancellable.has(job.type)) continue;
    const outcome = transitionCancel(jobsDb, job.id);
    if (outcome.shouldSignalCancel) signalCancel(job.id);
    if (outcome.edge === 'cancelled' || outcome.edge === 'noop') cancelled.push(job.id);
  }
  return cancelled;
}

function updateCurrentLibraryCatalogPath(
  libraryDbPath: string,
  catalogAbs: string,
  kind: CatalogKind,
): void {
  const db = openLibraryDb(libraryDbPath);
  try {
    libraryWrite(db, () => {
      setLibraryMeta(db, CATALOG_PATH_META_KEY, catalogAbs);
      setLibraryMeta(db, CATALOG_KIND_META_KEY, kind);
    });
  } finally {
    db.close();
  }
}

export function applyCatalogChange(
  newCatalogPathRaw: string,
  mode: CatalogChangeMode,
  configPath = config.LT_CONFIG_YAML,
): CatalogChangeResult | { error: string } {
  const validated = validateCatalogPathRaw(newCatalogPathRaw);
  if (!validated.ok) return { error: validated.error };

  const preview = previewCatalogChange(validated.trimmed, configPath);
  if ('error' in preview) return preview;
  if (preview.unchanged) return { error: 'catalog_path is unchanged' };

  const recorded = pinnedLibraryCatalogPath();
  if (recorded && refusePinnedDifferentCatalog(recorded, validated.trimmed)) {
    return { error: 'library pinned by LIBRARY_DB' };
  }

  if (mode === 'update_path') {
    if (!preview.ask_same_or_different) {
      return { error: 'This catalog change requires switching, not a path update' };
    }
    if (isLibraryDbPinned()) {
      if (recorded && absoluteCatalogPath(recorded) !== preview.next.resolved_path) {
        updatePinnedLibraryCatalogPath(preview.next.resolved_path);
      }
    } else {
      const currentMatches = preview.current.resolved_path
        ? findCatalogLibrariesForPath(preview.current.resolved_path)
        : [];
      if (currentMatches.length !== 1) {
        return { error: 'No open library to update for the current catalog' };
      }
      updateCurrentLibraryCatalogPath(
        currentMatches[0]!.libraryDbPath,
        preview.next.resolved_path,
        preview.next.catalog_kind,
      );
    }
    updateConfigYamlCatalogPath(configPath, validated.trimmed);
    invalidateOpenLibraryCache();

    return withJobsDb((jobsDb) => {
      const syncId = createJob(jobsDb, 'catalog_sync', {});
      return {
        catalog_path: validated.trimmed,
        change: mode,
        reopened_library: true,
        library_photo_count: preview.current.library_photo_count,
        catalog_sync_job_id: syncId,
        cancelled_job_ids: [],
      };
    });
  }

  return withJobsDb((jobsDb) => {
    const cancelled = cancelCatalogJobs(jobsDb);
    updateConfigYamlCatalogPath(configPath, validated.trimmed);
    invalidateOpenLibraryCache();
    const syncId = createJob(jobsDb, 'catalog_sync', {});
    return {
      catalog_path: validated.trimmed,
      change: mode,
      reopened_library: preview.next.has_library,
      library_photo_count: preview.next.library_photo_count,
      catalog_sync_job_id: syncId,
      cancelled_job_ids: cancelled,
    };
  });
}
