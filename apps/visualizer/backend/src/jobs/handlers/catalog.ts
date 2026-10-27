/**
 * The `catalog_sync` job handler.
 *
 * The handler is thin because the work is in `lightroom/catalog-sync.ts`; what it
 * owns is the two ways the job can be unrunnable — no catalog configured, or the
 * configured one is not there — and both are the user's own configuration, so they
 * fail as `warning` rather than as a defect.
 *
 * As stage 0 of `catalog_cache_build` those same failures are not fatal at all:
 * the three stages after it read `library.db`, which is still there and still
 * worth indexing even when today's additions could not be fetched. So the pass
 * reports them as a stage result the chain logs and steps over.
 */
import { existsSync } from 'node:fs';
import { config, loadLibraryConfig } from '../../config.js';
import type { Db } from '../../db/connection.js';
import {
  CATALOG_LOCKED_MSG,
  CatalogSyncError,
  syncCatalog,
  type SyncCatalogOutcome,
} from '../../lightroom/catalog-sync.js';
import type { JobRunner } from '../runner.js';
import {
  asMetadata,
  failureSeverityFromError,
  jobLogLevel,
  mapPassProgress,
  OWN_JOB,
  resolveLibraryDbOrFail,
  withLibraryDb,
  type PassContext,
} from './common.js';

/**
 * What stage 0 of `catalog_cache_build` reports.
 *
 * `added` and `stale` are always present, at zero, so the chain's summary line
 * reads the same whether the sync ran or was stepped over.
 */
export interface CatalogSyncStageResult {
  added: number;
  stale: number;
  locking_mode?: string;
  catalog_total?: number;
  library_total?: number;
  missing_ids_count?: number;
  keywords_backfilled?: number;
  /** Set when no catalog is configured, or the configured one is not there. */
  skipped?: true;
  /** Set when the catalog exists but could not be read. */
  failed?: true;
  error?: string;
}

/** `catalog_path` from the job's metadata, else from `config.yaml`. */
function resolveCatalogPath(metadata: Record<string, unknown>): string | null {
  const fromMetadata = metadata['catalog_path'];
  if (fromMetadata) return String(fromMetadata);
  return loadLibraryConfig(config.LT_CONFIG_YAML).catalogPath;
}

/** Refresh `library.db` from the Lightroom Classic catalog, additions only. */
export async function handleCatalogSync(
  runner: JobRunner,
  jobId: string,
  rawMetadata: unknown,
): Promise<void> {
  const metadata = asMetadata(rawMetadata);
  const dbPath = resolveLibraryDbOrFail(runner, jobId);
  if (dbPath === null) return;

  await withLibraryDb(dbPath, async (libDb) => {
    await runCatalogSyncPass(runner, jobId, metadata, libDb, OWN_JOB);
  });
}

/**
 * Sync the catalog into `libDb`.
 *
 * Returns the stage result when running as a stage of `catalog_cache_build`, and
 * `null` whenever it has settled the job itself — the same contract the describe
 * and score passes follow. Unlike those two, a stage failure here is a returned
 * result rather than a settled job, because the chain goes on without it.
 */
export async function runCatalogSyncPass(
  runner: JobRunner,
  jobId: string,
  metadata: Record<string, unknown>,
  libDb: Db,
  ctx: PassContext,
): Promise<CatalogSyncStageResult | null> {
  const prefix = ctx.logPrefix;
  const unrunnable = (message: string): CatalogSyncStageResult | null => {
    if (ctx.settle === 'job') {
      runner.failJob(jobId, message, 'warning');
      return null;
    }
    runner.log(jobId, 'warning', `${prefix}status=skipped ${message}`);
    return { skipped: true, error: message, added: 0, stale: 0 };
  };

  const catalogPath = resolveCatalogPath(metadata);
  if (!catalogPath) {
    return unrunnable('No catalog path configured. Set catalog_path in config.yaml.');
  }
  if (!existsSync(catalogPath)) return unrunnable(`Catalog not found: ${catalogPath}`);

  const progress = (pct: number, message: string): void =>
    runner.updateProgress(jobId, mapPassProgress(ctx, pct), `${prefix}${message}`);
  progress(5, 'Connecting to Lightroom Classic catalog...');

  let outcome: SyncCatalogOutcome;
  try {
    outcome = await syncCatalog(catalogPath, libDb, {
      log: (level, message) => runner.log(jobId, jobLogLevel(level), `${prefix}${message}`),
      progress,
      isCancelled: () => runner.isCancelled(jobId),
      backfillKeywords: metadata['backfill_keywords'] === true,
    });
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // A `CatalogSyncError`'s message is the whole value of the type, so an empty
    // one is worth replacing with the reason it almost always has.
    const isSyncError = e instanceof CatalogSyncError;
    const message = isSyncError ? raw || CATALOG_LOCKED_MSG : raw;
    if (ctx.settle === 'stage') {
      runner.log(jobId, 'warning', `${prefix}status=failed error=${message}`);
      return { failed: true, error: message, added: 0, stale: 0 };
    }
    // A locked or unreadable catalog is the user's own setup, not a defect here.
    runner.failJob(jobId, message, isSyncError ? 'warning' : failureSeverityFromError(e));
    return null;
  }

  if (outcome.cancelled) {
    runner.finalizeCancelled(jobId);
    return null;
  }
  if (ctx.settle === 'stage') return outcome.result;
  runner.completeJob(jobId, outcome.result);
  return null;
}
