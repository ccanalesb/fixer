/**
 * The background job processor.
 *
 * The loop is an async interval in one process with a module-level heartbeat.
 * `tick` never throws; a thrown error is recorded on the heartbeat as `last_error`
 * rather than killing the loop.
 */
import { config } from '../config.js';
import type { Db } from '../db/connection.js';
import {
  addJobLog,
  getActiveJobs,
  getJob,
  getPendingJobs,
  initJobsDb,
  updateJobStatus,
} from '../db/jobs/jobs.js';
import { emitJobEvent, emitJobsRecovered } from '../websocket/events.js';
import { compactJobPayload, type Job } from '../api/schemas/jobs.js';
import { getJobLogStatsBulk } from '../db/jobs/jobs.js';
import { JOB_TYPES_BY_NAME } from './registry.js';
import { ensureCatalogCache } from './handlers/catalog-cache.js';
import { JobRunner } from './runner.js';

/** Emit at most one progress broadcast per job per second. */
const PROGRESS_THROTTLE_MS = 1000;

/** How often the loop looks for pending work. */
const TICK_INTERVAL_MS = 1000;

export interface ProcessorHealth {
  running: boolean;
  started_at: number | null;
  last_iteration_at: number | null;
  iterations_total: number;
  current_job_id: string | null;
  current_job_started_at: number | null;
  last_error: string | null;
}

const health: ProcessorHealth = {
  running: false,
  started_at: null,
  last_iteration_at: null,
  iterations_total: 0,
  current_job_id: null,
  current_job_started_at: null,
  last_error: null,
};

/** A defensive copy of the heartbeat, for `/api/jobs/_processor_health`. */
export function getProcessorHealthSnapshot(): ProcessorHealth {
  return { ...health };
}

let runner: JobRunner | null = null;
let timer: NodeJS.Timeout | null = null;
let ticking = false;

/**
 * Job ids currently dispatched.
 *
 * Guards against double dispatch: a tick must not pick up a job whose handler
 * from an earlier tick is still running, since `await` inside a handler lets the
 * next interval fire.
 */
const runningJobIds = new Set<string>();

/** Set the cooperative cancel flag on the live runner, if there is one. */
export function signalCancel(jobId: string): void {
  runner?.signalCancel(jobId);
}

const nowSeconds = (): number => Date.now() / 1000;

/** Attach log stats and compact checkpoints, matching the REST payload exactly. */
function buildEmitPayload(db: Db, jobId: string): Job | null {
  const job = getJob(db, jobId);
  if (!job) return null;
  const stats = getJobLogStatsBulk(db, [jobId]).get(jobId);
  return compactJobPayload({
    ...job,
    logs_total: stats?.logs_total ?? 0,
    warning_count: stats?.warning_count ?? 0,
    error_count: stats?.error_count ?? 0,
    last_log_at: stats?.last_log_at ?? null,
  } as unknown as Record<string, unknown>) as unknown as Job;
}

/**
 * Re-queue running jobs that hold a v1 checkpoint; fail the rest.
 *
 * A job left `running` by a restart has no worker, so it would sit there for ever.
 * With a checkpoint it can resume where it stopped; without one, re-running it
 * from the start could duplicate side effects, so it is failed and the user
 * decides whether to retry.
 */
export function recoverOrphanedJobs(db: Db): string[] {
  const recovered: string[] = [];
  for (const job of getActiveJobs(db)) {
    if (job.status !== 'running') continue;
    const meta = job.metadata;
    const checkpoint =
      meta && typeof meta === 'object' ? (meta as Record<string, unknown>).checkpoint : null;
    const hasV1Checkpoint =
      checkpoint !== null &&
      typeof checkpoint === 'object' &&
      (checkpoint as Record<string, unknown>).checkpoint_version === 1;

    if (hasV1Checkpoint) {
      updateJobStatus(db, job.id, 'pending', {
        progress: job.progress || 0,
        currentStep: 'Recovered after restart',
      });
      addJobLog(db, job.id, 'info', 'Recovered after restart; job re-queued with checkpoint.');
      recovered.push(job.id);
    } else {
      updateJobStatus(db, job.id, 'failed');
      addJobLog(
        db,
        job.id,
        'error',
        'This job was still running when the server restarted. It was marked failed; ' +
          'use Retry if you want to run it again.',
      );
    }
  }
  if (recovered.length > 0) emitJobsRecovered(recovered);
  return recovered;
}

/**
 * One pass over the pending queue.
 *
 * Exported so a test can drive the processor deterministically rather than
 * waiting on the interval.
 */
export async function tick(db: Db, activeRunner: JobRunner): Promise<void> {
  health.last_iteration_at = nowSeconds();

  for (const job of getPendingJobs(db)) {
    const jobId = job.id;
    const jobType = job.type;

    // Re-read: the job may have been cancelled between the listing and now.
    const fresh = getJob(db, jobId, { logsLimit: 0 });
    if (!fresh || fresh.status !== 'pending') continue;

    if (!activeRunner.startJob(jobId, jobType)) {
      const payload = buildEmitPayload(db, jobId);
      if (payload) emitJobEvent('job_updated', payload);
      continue;
    }
    const startedPayload = buildEmitPayload(db, jobId);
    if (startedPayload) emitJobEvent('job_updated', startedPayload);

    if (runningJobIds.has(jobId)) continue;
    runningJobIds.add(jobId);

    const entry = JOB_TYPES_BY_NAME.get(jobType);
    health.current_job_id = jobId;
    health.current_job_started_at = nowSeconds();
    try {
      if (entry) {
        try {
          const cacheReady = entry.needsCatalogCache
            ? await ensureCatalogCache(activeRunner, jobId, jobType)
            : true;
          if (cacheReady) await entry.handler(activeRunner, jobId, job.metadata);
        } catch (e) {
          // Only fail a job the handler left running: a handler that already
          // reported failure or completion has said its piece.
          const after = getJob(db, jobId, { logsLimit: 0 });
          if (after?.status === 'running') {
            activeRunner.failJob(jobId, e instanceof Error ? e.message : String(e));
          }
        }
      } else {
        const after = getJob(db, jobId, { logsLimit: 0 });
        // A type no longer in the registry, most likely a row queued by an older
        // build. Reported rather than left running, so it is visible.
        if (after?.status === 'running') {
          activeRunner.failJob(jobId, `Unknown job type: ${jobType}`);
        }
      }
    } finally {
      runningJobIds.delete(jobId);
      health.current_job_id = null;
      health.current_job_started_at = null;
    }

    const donePayload = buildEmitPayload(db, jobId);
    if (donePayload) emitJobEvent('job_updated', donePayload);
  }

  // A completed pass counts as a healthy tick whether or not there was work, so
  // `/_processor_health` can tell "quietly waiting" from "stuck".
  health.iterations_total += 1;
}

/**
 * Start the processor and run the restart-recovery pass.
 *
 * Deliberately NOT called from `createApp()`: constructing the app must stay
 * side-effect free so the OpenAPI export and the tests do not start background
 * work. `server.ts` calls this.
 */
export function startJobProcessor(): void {
  if (timer !== null) return;

  const db = initJobsDb(config.VISUALIZER_DB);
  recoverOrphanedJobs(db);

  const lastEmit = new Map<string, number>();
  const emitProgress = (jobId: string): void => {
    // A handler can stay inside one job for minutes; refreshing the heartbeat
    // from the progress callback stops `/_processor_health` reporting `stale`
    // while work is actively advancing.
    health.last_iteration_at = nowSeconds();
    const now = Date.now();
    if (now - (lastEmit.get(jobId) ?? 0) < PROGRESS_THROTTLE_MS) return;
    lastEmit.set(jobId, now);
    const payload = buildEmitPayload(db, jobId);
    if (payload) emitJobEvent('job_updated', payload);
  };

  runner = new JobRunner(db, emitProgress);
  health.running = true;
  health.started_at = nowSeconds();
  health.last_iteration_at = nowSeconds();
  health.iterations_total = 0;
  health.last_error = null;

  timer = setInterval(() => {
    // Skip rather than overlap: a slow tick must not be re-entered.
    if (ticking) return;
    ticking = true;
    void tick(db, runner!)
      .catch((e: unknown) => {
        health.last_error = `${(e as Error)?.name ?? 'Error'}: ${
          e instanceof Error ? e.message : String(e)
        }`;
        process.stderr.write(`Job processor error: ${String(e)}\n`);
      })
      .finally(() => {
        ticking = false;
      });
  }, TICK_INTERVAL_MS);
  // Do not hold the event loop open on shutdown.
  timer.unref();
}

/** Stop the processor. Used by tests and by a clean shutdown. */
export function stopJobProcessor(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  runner = null;
  ticking = false;
  runningJobIds.clear();
  health.running = false;
  health.current_job_id = null;
  health.current_job_started_at = null;
}
