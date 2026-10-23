/**
 * Coordinate the job lifecycle between the processor loop and the handlers.
 *
 * One thread, one SQLite connection; handlers that need real parallelism use
 * `worker_threads` with their own connection. WAL plus `busy_timeout` is the
 * coordination point across processes.
 */
import type { Db } from '../db/connection.js';
import {
  addJobLog,
  getActiveJobs,
  getJob,
  jobLogHasMessage,
  updateJobField,
  updateJobStatus,
  type JobLogLevel,
  type JobRow,
} from '../db/jobs/jobs.js';
import { CHECKPOINT_VERSION } from './checkpoint.js';

export type EmitProgress = (jobId: string, progress: number, currentStep: string) => void;

export type ErrorSeverity = 'warning' | 'error' | 'critical';

const STOP_MESSAGE = 'Job stopped after cancel request';

export class JobRunner {
  private readonly db: Db;
  private readonly emitProgress: EmitProgress;

  /**
   * Cooperative cancel flags for in-flight jobs.
   *
   * A boolean box rather than an event: handlers poll `isCancelled` between
   * units of work, so there is nothing to wait on.
   */
  private readonly activeJobs = new Map<string, { cancelled: boolean }>();

  /**
   * Last `(progress, step)` logged per job.
   *
   * Progress callbacks fire far more often than the step changes, and without
   * this a batch job writes thousands of identical log lines.
   */
  private readonly lastProgressLog = new Map<string, string>();

  constructor(db: Db, emitProgress: EmitProgress = () => {}) {
    this.db = db;
    this.emitProgress = emitProgress;
  }

  /** Append a log entry. Kept as a method so handlers need no DB handle. */
  log(jobId: string, level: JobLogLevel, message: string): void {
    addJobLog(this.db, jobId, level, message);
  }

  /** The job's metadata, including any `checkpoint` a previous run persisted. */
  readMetadata(jobId: string): Record<string, unknown> {
    const row = getJob(this.db, jobId, { logsLimit: 0 });
    const meta = row?.metadata;
    return meta && typeof meta === 'object' && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)
      : {};
  }

  /** Every job pending or running, this one included. */
  waitingOrRunningJobs(): JobRow[] {
    return getActiveJobs(this.db);
  }

  /** Whether the job has already settled, e.g. failed from inside a handler. */
  hasFailed(jobId: string): boolean {
    return getJob(this.db, jobId, { logsLimit: 0 })?.status === 'failed';
  }

  /**
   * Mark a job running. Returns false when the row is gone or already cancelled,
   * which is the check that stops a job cancelled while queued from starting.
   */
  startJob(jobId: string, jobType: string): boolean {
    const row = getJob(this.db, jobId, { logsLimit: 0 });
    if (!row || row.status === 'cancelled') return false;
    this.activeJobs.set(jobId, { cancelled: false });
    this.lastProgressLog.delete(jobId);
    updateJobStatus(this.db, jobId, 'running', { progress: 0, currentStep: 'Starting...' });
    addJobLog(this.db, jobId, 'info', `Job ${jobType} started`);
    return true;
  }

  /** Update progress. A no-op once the job is cancelled or already finished. */
  updateProgress(jobId: string, progress: number, currentStep: string): void {
    if (this.isCancelled(jobId)) return;
    const row = getJob(this.db, jobId, { logsLimit: 0 });
    if (row && (row.status === 'completed' || row.status === 'cancelled')) return;

    updateJobStatus(this.db, jobId, 'running', { progress, currentStep });
    const logKey = `${progress}\u0000${currentStep}`;
    if (this.lastProgressLog.get(jobId) !== logKey) {
      addJobLog(this.db, jobId, 'info', currentStep);
      this.lastProgressLog.set(jobId, logKey);
    }
    this.emitProgress(jobId, progress, currentStep);
  }

  /**
   * Name the stage a composite job is in, without touching its progress.
   *
   * `updateProgress` also writes `current_step`, but it is called once per unit of
   * work; this is called once per stage, so the label survives being overwritten
   * by the per-item messages only in the sense that the UI reads both.
   */
  setCurrentStep(jobId: string, currentStep: string): void {
    updateJobField(this.db, jobId, 'current_step', currentStep);
  }

  /**
   * Mark a job completed and store its result.
   *
   * A job cancelled while the handler was finishing stays cancelled: the user's
   * decision wins over a late success.
   */
  completeJob(jobId: string, result: unknown): void {
    const row = getJob(this.db, jobId, { logsLimit: 0 });
    if (row && row.status === 'cancelled') {
      this.clearCancelRegistration(jobId);
      return;
    }
    updateJobStatus(this.db, jobId, 'completed', { progress: 100 });
    addJobLog(this.db, jobId, 'info', 'Job completed successfully');
    updateJobField(this.db, jobId, 'result', result);
    this.db.prepare('UPDATE jobs SET error_severity = NULL WHERE id = ?').run(jobId);
    this.lastProgressLog.delete(jobId);
    this.clearCancelRegistration(jobId);
  }

  /** Mark a job failed, with a severity the UI colours by. */
  failJob(jobId: string, error: string, severity: ErrorSeverity = 'error'): void {
    const resolved: ErrorSeverity =
      severity === 'warning' || severity === 'error' || severity === 'critical'
        ? severity
        : 'error';
    const row = getJob(this.db, jobId, { logsLimit: 0 });
    if (row && row.status === 'cancelled') {
      this.clearCancelRegistration(jobId);
      return;
    }
    updateJobStatus(this.db, jobId, 'failed');
    addJobLog(this.db, jobId, 'error', error);
    this.db
      .prepare('UPDATE jobs SET error = ?, error_severity = ? WHERE id = ?')
      .run(error, resolved, jobId);
    this.lastProgressLog.delete(jobId);
    this.clearCancelRegistration(jobId);
  }

  /**
   * Whether the job has been cancelled.
   *
   * Checks the in-memory flag first, then the database — the flag is set by
   * `signalCancel` in the same process, but a cancel can also arrive as a plain
   * status write, and a long-running handler has to notice either.
   */
  isCancelled(jobId: string): boolean {
    const flag = this.activeJobs.get(jobId);
    if (flag?.cancelled) return true;
    const row = getJob(this.db, jobId, { logsLimit: 0 });
    if (row && row.status === 'cancelled') {
      if (flag) flag.cancelled = true;
      return true;
    }
    return false;
  }

  clearCancelRegistration(jobId: string): void {
    this.activeJobs.delete(jobId);
    this.lastProgressLog.delete(jobId);
  }

  /** Set the cooperative cancel flag. Deliberately writes nothing to the DB. */
  signalCancel(jobId: string): void {
    const flag = this.activeJobs.get(jobId);
    if (flag) flag.cancelled = true;
  }

  /**
   * Merge versioned checkpoint data into `jobs.metadata`.
   *
   * The version is stamped here rather than by the caller, because
   * `recoverOrphanedJobs` re-queues on it — a handler that forgot it would have
   * its job failed on restart instead of resumed.
   */
  persistCheckpoint(jobId: string, checkpointBody: Record<string, unknown>): void {
    const row = getJob(this.db, jobId, { logsLimit: 0 });
    if (!row) return;
    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    updateJobField(this.db, jobId, 'metadata', {
      ...meta,
      checkpoint: { checkpoint_version: CHECKPOINT_VERSION, ...checkpointBody },
    });
  }

  /** Drop the resume checkpoint, e.g. after a clean completion. */
  clearCheckpoint(jobId: string): void {
    const row = getJob(this.db, jobId, { logsLimit: 0 });
    if (!row) return;
    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    updateJobField(this.db, jobId, 'metadata', { ...meta, checkpoint: null });
  }

  /**
   * Settle a cooperatively-cancelled job.
   *
   * `logsLimit: 0` and the indexed marker lookup keep this cheap even for a job
   * that accumulated 20,000 log rows — loading the history just to check for one
   * message is what this avoids.
   */
  finalizeCancelled(jobId: string): void {
    this.clearCancelRegistration(jobId);
    const row = getJob(this.db, jobId, { logsLimit: 0 });
    if (!row) return;

    const hasStopMessage = jobLogHasMessage(this.db, jobId, STOP_MESSAGE);
    if (row.status === 'running') {
      updateJobStatus(this.db, jobId, 'cancelled');
      if (!hasStopMessage) addJobLog(this.db, jobId, 'info', STOP_MESSAGE);
    } else if (row.status === 'cancelled' && !hasStopMessage) {
      addJobLog(this.db, jobId, 'info', STOP_MESSAGE);
    }
  }
}
