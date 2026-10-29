/**
 * Job rows and their logs, in `visualizer.db`.
 *
 * Logs live in append-only `job_logs` (indexed on `(job_id, id)`). The legacy
 * `jobs.logs` JSON column still exists and is decoded on read for rows written
 * before that table existed.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Db } from '../connection.js';
import { nowIsoLocal } from '../../utils/datetime.js';
import { migrateLegacyVisionColumn } from './provider-models.js';

/**
 * Default tail length when a caller does not ask for the full history.
 *
 * Large enough to cover a long-running job's active window, while keeping every
 * row read O(tail) rather than O(total history).
 */
export const DEFAULT_LOG_TAIL = 1000;

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type JobLogLevel = 'debug' | 'info' | 'warning' | 'error';

export interface JobLog {
  timestamp: string;
  level: JobLogLevel;
  message: string;
}

export interface JobRow {
  id: string;
  type: string;
  status: JobStatus;
  progress: number;
  current_step: string | null;
  logs: JobLog[];
  logs_total: number;
  warning_count: number;
  error_count: number;
  last_log_at: string | null;
  result: unknown;
  error: string | null;
  error_severity: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  metadata: Record<string, unknown>;
}

/** Fields `updateJobField` may write. Whitelisted because the column is interpolated. */
const ALLOWED_JOB_UPDATE_FIELDS = new Set(['error', 'result', 'metadata', 'current_step']);

/** Create the schema and apply the pragmas the jobs DB needs. */
export function initJobsDb(dbPath: string): Db {
  const parent = dirname(dbPath);
  if (parent) mkdirSync(parent, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // 30s, longer than the library DB's 10s: the workers, the coordinator and HTTP
  // polling all contend for the writer seat while a batch runs.
  db.pragma('busy_timeout = 30000');
  db.pragma('synchronous = NORMAL');
  ensureJobsSchema(db);
  return db;
}

export function ensureJobsSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      progress INTEGER DEFAULT 0,
      current_step TEXT,
      logs TEXT DEFAULT '[]',
      result TEXT,
      error TEXT,
      error_severity TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      metadata TEXT DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type);
    CREATE TABLE IF NOT EXISTS job_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_logs_job_id_id ON job_logs(job_id, id);
    CREATE TABLE IF NOT EXISTS provider_models (
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      vision INTEGER DEFAULT 1,
      origin TEXT NOT NULL DEFAULT 'config',
      image_refused_at TEXT,
      image_refused_reason TEXT,
      PRIMARY KEY (provider_id, model_id)
    );
  `);
  // `error_severity` was added after the first release; older files lack it.
  const columns = db.pragma('table_info(jobs)') as { name: string }[];
  if (!columns.some((c) => c.name === 'error_severity')) {
    db.exec('ALTER TABLE jobs ADD COLUMN error_severity TEXT');
  }

  migrateLegacyLogs(db);
  migrateLegacyVisionColumn(db);
}

/**
 * One-time backfill: fold any legacy `jobs.logs` JSON array into `job_logs` and
 * blank the old column. Returns the number of rows migrated.
 *
 * Without this, a job that predates the `job_logs` table loses its history the
 * moment anything reads it, because every read path now looks only at the table.
 * Idempotent — a row whose `logs` is already `[]` is skipped, which is what makes
 * it safe to run on every connection.
 */
export function migrateLegacyLogs(db: Db): number {
  const legacyRows = db
    .prepare(
      "SELECT id, logs FROM jobs WHERE logs IS NOT NULL AND logs != '' AND logs != '[]'",
    )
    .all() as { id: string; logs: string }[];
  if (legacyRows.length === 0) return 0;

  const insert = db.prepare(
    'INSERT INTO job_logs (job_id, ts, level, message) VALUES (?, ?, ?, ?)',
  );
  const blank = db.prepare("UPDATE jobs SET logs = '[]' WHERE id = ?");
  let migrated = 0;

  for (const row of legacyRows) {
    let entries: unknown[] = [];
    try {
      const parsed = row.logs ? JSON.parse(row.logs) : [];
      if (Array.isArray(parsed)) entries = parsed;
    } catch {
      // Unparseable blob: drop it rather than fail the whole migration.
    }
    const usable = entries.filter(
      (e): e is Record<string, unknown> => e !== null && typeof e === 'object',
    );
    if (usable.length > 0) {
      for (const entry of usable) {
        insert.run(
          row.id,
          String(entry.timestamp ?? '') || nowIsoLocal(),
          String(entry.level ?? '') || 'info',
          String(entry.message ?? ''),
        );
      }
      migrated += 1;
    }
    blank.run(row.id);
  }
  return migrated;
}

interface RawJobRow {
  id: string;
  type: string;
  status: JobStatus;
  progress: number | null;
  current_step: string | null;
  logs: string | null;
  result: string | null;
  error: string | null;
  error_severity: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  metadata: string | null;
}

/**
 * Normalize a raw `jobs` row.
 *
 * `logs` is taken from the caller's pre-loaded list when given; otherwise the
 * legacy JSON-blob column is decoded best-effort, so a row written before the
 * `job_logs` migration still reads correctly.
 */
function deserializeJob(row: RawJobRow, logs: JobLog[] | null): JobRow {
  const parse = (value: string | null, fallback: unknown): unknown => {
    if (typeof value !== 'string') return value ?? fallback;
    try {
      return JSON.parse(value);
    } catch {
      // Not JSON: return the raw string.
      return value;
    }
  };

  let resolvedLogs: JobLog[];
  if (logs !== null) {
    resolvedLogs = logs;
  } else if (typeof row.logs === 'string' && row.logs) {
    const decoded = parse(row.logs, []);
    resolvedLogs = Array.isArray(decoded) ? (decoded as JobLog[]) : [];
  } else {
    resolvedLogs = [];
  }

  return {
    id: row.id,
    type: row.type,
    status: row.status,
    progress: Math.trunc(row.progress ?? 0),
    current_step: row.current_step,
    logs: resolvedLogs,
    logs_total: 0,
    warning_count: 0,
    error_count: 0,
    last_log_at: null,
    result: row.result === null ? null : parse(row.result, null),
    error: row.error,
    error_severity: row.error_severity,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    metadata: (parse(row.metadata, {}) ?? {}) as Record<string, unknown>,
  };
}

/** Create a job and return its id. */
export function createJob(db: Db, jobType: string, metadata: unknown): string {
  const jobId = randomUUID();
  db.prepare(
    `
    INSERT INTO jobs (id, type, status, progress, current_step, logs, result,
        error, created_at, started_at, completed_at, metadata)
    VALUES (?, ?, 'pending', 0, NULL, '[]', NULL, NULL, ?, NULL, NULL, ?)
    `,
  ).run(jobId, jobType, nowIsoLocal(), JSON.stringify(metadata ?? {}));
  return jobId;
}

/**
 * The most recent log entries, in chronological order.
 *
 * `limit === null` returns every entry. Otherwise the tail is selected descending
 * and reversed, so the query stays index-backed regardless of total volume.
 */
function loadLogsTail(db: Db, jobId: string, limit: number | null): JobLog[] {
  let rows: { ts: string; level: JobLogLevel; message: string }[];
  if (limit === null) {
    rows = db
      .prepare('SELECT ts, level, message FROM job_logs WHERE job_id = ? ORDER BY id ASC')
      .all(jobId) as typeof rows;
  } else {
    if (limit <= 0) return [];
    rows = db
      .prepare(
        'SELECT ts, level, message FROM job_logs WHERE job_id = ? ORDER BY id DESC LIMIT ?',
      )
      .all(jobId, limit) as typeof rows;
    rows.reverse();
  }
  return rows.map((r) => ({ timestamp: r.ts, level: r.level, message: r.message }));
}

export function countJobLogs(db: Db, jobId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM job_logs WHERE job_id = ?').get(jobId) as
    | { c: number }
    | undefined;
  return row ? Math.trunc(row.c) : 0;
}

export interface JobLogStats {
  logs_total: number;
  warning_count: number;
  error_count: number;
  last_log_at: string | null;
}

/** Per-job log summary stats, without loading any log payloads. */
export function getJobLogStatsBulk(
  db: Db,
  jobIds: readonly string[],
): Map<string, JobLogStats> {
  if (jobIds.length === 0) return new Map();
  const rows = db
    .prepare(
      `
      SELECT
          job_id,
          COUNT(*) AS logs_total,
          SUM(CASE WHEN level = 'warning' THEN 1 ELSE 0 END) AS warning_count,
          SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) AS error_count,
          MAX(ts) AS last_log_at
      FROM job_logs
      WHERE job_id IN (${jobIds.map(() => '?').join(',')})
      GROUP BY job_id
      `,
    )
    .all(...jobIds) as {
    job_id: string;
    logs_total: number | null;
    warning_count: number | null;
    error_count: number | null;
    last_log_at: string | null;
  }[];
  return new Map(
    rows.map((row) => [
      row.job_id,
      {
        logs_total: Math.trunc(row.logs_total ?? 0),
        warning_count: Math.trunc(row.warning_count ?? 0),
        error_count: Math.trunc(row.error_count ?? 0),
        last_log_at: row.last_log_at,
      },
    ]),
  );
}

/**
 * One job with its log tail attached.
 *
 * `logsLimit` bounds the attached history; `includeAllLogs` overrides it, which is
 * what `logs_limit=0` on the API means.
 */
export function getJob(
  db: Db,
  jobId: string,
  opts: { logsLimit?: number | null; includeAllLogs?: boolean } = {},
): JobRow | null {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as
    | RawJobRow
    | undefined;
  if (!row) return null;
  const effectiveLimit = opts.includeAllLogs
    ? null
    : (opts.logsLimit ?? DEFAULT_LOG_TAIL);
  return deserializeJob(row, loadLogsTail(db, jobId, effectiveLimit));
}

/**
 * Update status, and optionally progress and step.
 *
 * Two details carry weight. `started_at` is set with `COALESCE`, so a retry does
 * not lose the original start. And a transition *to* running excludes rows already
 * cancelled — otherwise a worker that picked the job up before the cancel landed
 * would resurrect it.
 */
export function updateJobStatus(
  db: Db,
  jobId: string,
  status: JobStatus,
  opts: { progress?: number | null; currentStep?: string | null } = {},
): void {
  const sets = ['status = ?'];
  const params: (string | number | null)[] = [status];

  if (opts.progress !== null && opts.progress !== undefined) {
    sets.push('progress = ?');
    params.push(opts.progress);
  }
  if (opts.currentStep !== null && opts.currentStep !== undefined) {
    sets.push('current_step = ?');
    params.push(opts.currentStep);
  }
  if (status === 'running') {
    sets.push('started_at = COALESCE(started_at, ?)');
    params.push(nowIsoLocal());
  } else if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    sets.push('completed_at = ?');
    params.push(nowIsoLocal());
  }

  params.push(jobId);
  let where = 'id = ?';
  if (status === 'running') where += " AND status != 'cancelled'";
  db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE ${where}`).run(...params);
}

/**
 * Append one log entry.
 *
 * Silently no-ops when the job row is gone, so a worker thread racing a deletion
 * does not crash mid-batch.
 */
export function addJobLog(db: Db, jobId: string, level: JobLogLevel, message: string): void {
  const exists = db.prepare('SELECT 1 FROM jobs WHERE id = ? LIMIT 1').get(jobId);
  if (!exists) return;
  db.prepare('INSERT INTO job_logs (job_id, ts, level, message) VALUES (?, ?, ?, ?)').run(
    jobId,
    nowIsoLocal(),
    level,
    message,
  );
}

/** Exact-match marker lookup, so cancel and recovery paths need not load the history. */
export function jobLogHasMessage(db: Db, jobId: string, message: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM job_logs WHERE job_id = ? AND message = ? LIMIT 1')
    .get(jobId, message);
  return row !== undefined;
}

export function deleteJobLogs(db: Db, jobId: string): number {
  return db.prepare('DELETE FROM job_logs WHERE job_id = ?').run(jobId).changes;
}

export function clearJobFailureDetails(db: Db, jobId: string): void {
  db.prepare('UPDATE jobs SET error = NULL, error_severity = NULL WHERE id = ?').run(jobId);
}

/**
 * Update one JSON-serializable field. The column name is whitelisted.
 *
 * A string is stored verbatim; anything else is JSON-encoded. `null`/`undefined`
 * are written as SQL NULL (not the four-character string `"null"`), because
 * `error` is not a JSON-decoded column and the API types it as `str | None`.
 */
export function updateJobField(db: Db, jobId: string, field: string, value: unknown): void {
  if (!ALLOWED_JOB_UPDATE_FIELDS.has(field)) {
    throw new RangeError(`Unsupported job field: '${field}'`);
  }
  const serialized =
    value === null || value === undefined
      ? null
      : typeof value === 'string'
        ? value
        : JSON.stringify(value);
  db.prepare(`UPDATE jobs SET ${field} = ? WHERE id = ?`).run(serialized, jobId);
}

/** Attach the bulk log stats to a set of rows. */
function withLogStats(db: Db, rows: RawJobRow[], includeLogs: boolean): JobRow[] {
  const stats = getJobLogStatsBulk(db, rows.map((r) => r.id));
  return rows.map((raw) => {
    const logs = includeLogs ? loadLogsTail(db, raw.id, DEFAULT_LOG_TAIL) : [];
    const job = deserializeJob(raw, logs);
    const s = stats.get(raw.id);
    job.logs_total = s?.logs_total ?? 0;
    job.warning_count = s?.warning_count ?? 0;
    job.error_count = s?.error_count ?? 0;
    job.last_log_at = s?.last_log_at ?? null;
    return job;
  });
}

/**
 * Jobs newest first, optionally filtered by status.
 *
 * Logs are NOT attached by default: a listing of 50 running jobs used to pull tens
 * of megabytes of history off the rows.
 */
export function listJobs(
  db: Db,
  opts: { status?: string | null; limit?: number; offset?: number; includeLogs?: boolean } = {},
): JobRow[] {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const rows = opts.status
    ? (db
        .prepare(
          'SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
        )
        .all(opts.status, limit, offset) as RawJobRow[])
    : (db
        .prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ? OFFSET ?')
        .all(limit, offset) as RawJobRow[]);
  return withLogStats(db, rows, opts.includeLogs ?? false);
}

export function countJobs(db: Db, status?: string | null): number {
  const row = status
    ? (db.prepare('SELECT COUNT(*) AS c FROM jobs WHERE status = ?').get(status) as
        | { c: number }
        | undefined)
    : (db.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number } | undefined);
  return row ? Math.trunc(row.c) : 0;
}

/** Pending or running jobs, without log history. */
export function getActiveJobs(db: Db): JobRow[] {
  const rows = db
    .prepare("SELECT * FROM jobs WHERE status IN ('running', 'pending')")
    .all() as RawJobRow[];
  return withLogStats(db, rows, false);
}

export function getPendingJobs(db: Db): JobRow[] {
  const rows = db.prepare("SELECT * FROM jobs WHERE status = 'pending'").all() as RawJobRow[];
  return rows.map((raw) => deserializeJob(raw, []));
}
