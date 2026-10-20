/**
 * `lr_writeback` — reconcile and write eligible photos to the live catalog.
 */
import { compactJobPayload } from '../../api/schemas/jobs.js';
import { config } from '../../config.js';
import type { Db } from '../../db/connection.js';
import { createJob, getActiveJobs, getJob, getPendingJobs, initJobsDb, type JobRow } from '../../db/jobs/jobs.js';
import { getLrWritebackSettings } from '../../db/library/lr-writeback-settings.js';
import { emitJobEvent } from '../../websocket/events.js';
import { describeLrCatalogWriteStatus } from '../../utils/lr-catalog-write.js';
import { reconcileLrWriteback } from '../../lightroom/writeback.js';
import { signalCancel } from '../processor.js';
import type { JobRunner } from '../runner.js';
import { transitionCancel } from '../transitions.js';
import { asMetadata, failureSeverityFromError, resolveLibraryDbOrFail, withLibraryDb } from './common.js';

export const LR_WRITEBACK_JOB_TYPE = 'lr_writeback';

function jobImageKeys(metadata: unknown): readonly string[] | null {
  const meta = asMetadata(metadata);
  const keys = meta.image_keys;
  if (!Array.isArray(keys) || keys.length === 0) return null;
  return keys.filter((k): k is string => typeof k === 'string');
}

export function isFullLrWritebackJob(job: Pick<JobRow, 'metadata'>): boolean {
  return jobImageKeys(job.metadata) === null;
}

export function findActiveLrWritebackJob(jobsDb: Db): JobRow | undefined {
  return getActiveJobs(jobsDb).find((j) => j.type === LR_WRITEBACK_JOB_TYPE);
}

function pendingLrWritebackJobs(jobsDb: Db): JobRow[] {
  return getPendingJobs(jobsDb).filter((j) => j.type === LR_WRITEBACK_JOB_TYPE);
}

/** POST /write — return an active job or enqueue a full run. */
export function enqueueLrWritebackWrite(jobsDb: Db): string {
  const existing = findActiveLrWritebackJob(jobsDb);
  if (existing) return existing.id;
  return createJob(jobsDb, LR_WRITEBACK_JOB_TYPE, {});
}

/**
 * Auto-enqueue after cull / re-decide / send-by-hand when switches are on.
 * Pending full run blocks everything; pending keyed run still allows a new full run.
 */
export function maybeEnqueueLrWriteback(
  jobsDb: Db,
  opts?: { imageKeys?: readonly string[] },
): string | null {
  const pending = pendingLrWritebackJobs(jobsDb);
  const keyed = Boolean(opts?.imageKeys?.length);
  if (!keyed) {
    if (pending.some(isFullLrWritebackJob)) return null;
    return createJob(jobsDb, LR_WRITEBACK_JOB_TYPE, {});
  }
  if (pending.length > 0) return null;
  return createJob(jobsDb, LR_WRITEBACK_JOB_TYPE, { image_keys: [...opts!.imageKeys!] });
}

/** After cull / re-decide / send-by-hand: queue a write-back run when a switch is on, and announce it. */
export function enqueueLrWritebackIfEnabled(libraryDb: Db, opts?: { imageKeys?: readonly string[] }): void {
  const settings = getLrWritebackSettings(libraryDb);
  if (!settings.write_stars && !settings.write_reject) return;
  const jobsDb = initJobsDb(config.VISUALIZER_DB);
  try {
    const jobId = maybeEnqueueLrWriteback(jobsDb, opts);
    const job = jobId ? getJob(jobsDb, jobId) : null;
    if (job) emitJobEvent('job_created', compactJobPayload(job as unknown as Record<string, unknown>) as never);
  } finally {
    jobsDb.close();
  }
}

/** Cancel every pending/running write-back job. */
export function cancelActiveLrWritebackJobs(jobsDb: Db): void {
  for (const job of getActiveJobs(jobsDb).filter((j) => j.type === LR_WRITEBACK_JOB_TYPE)) {
    const outcome = transitionCancel(jobsDb, job.id);
    if (outcome.shouldSignalCancel) signalCancel(job.id);
  }
}

export async function handleLrWriteback(
  runner: JobRunner,
  jobId: string,
  rawMetadata: unknown,
): Promise<void> {
  const imageKeys = jobImageKeys(rawMetadata) ?? undefined;
  try {
    const dbPath = resolveLibraryDbOrFail(runner, jobId);
    if (dbPath === null) return;
    await withLibraryDb(dbPath, async (db) => {
      const catalogBefore = describeLrCatalogWriteStatus();
      const result = await reconcileLrWriteback(db, {
        trigger: 'job',
        imageKeys,
        isCancelled: () => runner.isCancelled(jobId),
        onProgress: (pct, message) => runner.updateProgress(jobId, pct, message),
      });
      if (await runner.isCancelled(jobId)) {
        runner.finalizeCancelled(jobId);
        return;
      }
      const catalogAfter = describeLrCatalogWriteStatus();
      const pendingTotal = result.stars.pending + result.reject.pending;
      let pendingNote = '';
      if (pendingTotal > 0 && !catalogAfter.available) {
        pendingNote = ` pending_reason="${catalogAfter.reason ?? 'catalog unavailable'}"`;
      }
      runner.log(
        jobId,
        'info',
        `[lr_writeback] status=complete stars_written=${result.stars.written} reject_written=${result.reject.written} ` +
          `stars_pending=${result.stars.pending} reject_pending=${result.reject.pending} ` +
          `stars_skipped=${result.stars.skipped} reject_skipped=${result.reject.skipped} ` +
          `catalog_stars=${result.catalog_updated_stars} catalog_reject=${result.catalog_updated_reject}` +
          pendingNote,
      );
      if (pendingTotal > 0 && catalogBefore.available && !catalogAfter.available) {
        runner.log(jobId, 'warning', '[lr_writeback] catalog became unavailable during run; remaining photos left pending');
      }
      runner.completeJob(jobId, result);
    });
  } catch (e) {
    runner.failJob(jobId, e instanceof Error ? e.message : String(e), failureSeverityFromError(e));
  }
}
