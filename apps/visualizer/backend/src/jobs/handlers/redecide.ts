/**
 * `batch_redecide_cull_verdicts_from_stored_answers` — threshold/recipe rule changes, no Laya.
 */
import { redecideAllPhotos, RedecideCancelled } from '../../cull/redecide.js';
import type { Db } from '../../db/connection.js';
import { createJob, getPendingJobs } from '../../db/jobs/jobs.js';
import type { JobRunner } from '../runner.js';
import { asMetadata, failureSeverityFromError, resolveLibraryDbOrFail, withLibraryDb } from './common.js';

export const BATCH_REDECIDE_JOB_TYPE = 'batch_redecide_cull_verdicts_from_stored_answers';

export async function handleBatchRedecideCullVerdicts(
  runner: JobRunner,
  jobId: string,
  rawMetadata: unknown,
): Promise<void> {
  asMetadata(rawMetadata);
  try {
    const dbPath = resolveLibraryDbOrFail(runner, jobId);
    if (dbPath === null) return;
    await withLibraryDb(dbPath, async (db) => {
      try {
        const result = await redecideAllPhotos(db, {
          isCancelled: () => runner.isCancelled(jobId),
          onProgress: (pct, message) => runner.updateProgress(jobId, pct, message),
        });
        runner.log(
          jobId,
          'info',
          `[redecide] status=complete total=${result.total} changed=${result.changed} ` +
            `cut_recipe=${result.cut_by_culling_recipe} cut_score_forecast=${result.cut_by_score_forecast} ` +
            `pending=${result.pending} sent=${result.sent} sent_by_hand_passed=${result.sent_by_hand_passed} ` +
            `duration_s=${result.durations_s.redecide}`,
        );
        try {
          const { reconcileLrWriteback } = await import('../../lightroom/writeback.js');
          await reconcileLrWriteback(db, { trigger: 'redecide_complete' });
        } catch (e) {
          runner.log(
            jobId,
            'warning',
            `lightroom write-back after re-decide: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        runner.completeJob(jobId, result);
      } catch (e) {
        if (e instanceof RedecideCancelled) {
          runner.finalizeCancelled(jobId);
          return;
        }
        throw e;
      }
    });
  } catch (e) {
    runner.failJob(jobId, e instanceof Error ? e.message : String(e), failureSeverityFromError(e));
  }
}

/** Queue a re-decide run unless one is already pending. */
export function enqueueRedecideCullVerdicts(jobsDb: Db, reason: string): string | null {
  const pending = getPendingJobs(jobsDb).filter((j) => j.type === BATCH_REDECIDE_JOB_TYPE);
  if (pending.length > 0) return null;
  return createJob(jobsDb, BATCH_REDECIDE_JOB_TYPE, { reason });
}
