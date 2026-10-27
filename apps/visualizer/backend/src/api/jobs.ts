/**
 * Jobs API — list, create, inspect, cancel and retry background jobs.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { config } from '../config.js';
import type { Db } from '../db/connection.js';
import {
  countJobLogs,
  countJobs,
  createJob,
  getActiveJobs,
  getJob,
  getJobLogStatsBulk,
  initJobsDb,
  listJobs,
  type JobRow,
} from '../db/jobs/jobs.js';
import { describeLibraryDb } from '../jobs/library-db.js';
import { catalogRequiringJobTypes } from '../jobs/registry.js';
import { getProcessorHealthSnapshot, signalCancel } from '../jobs/processor.js';
import { transitionCancel, transitionRetry } from '../jobs/transitions.js';
import { emitJobEvent } from '../websocket/events.js';
import { paginatedBody } from '../utils/responses.js';
import { createOpenApiApp } from './openapi.js';
import { jsonBody, withValidationError } from './route-helpers.js';
import { ErrorBody } from './schemas/errors.js';
import {
  CatalogUnavailableError,
  compactJobPayload,
  DbBusyError,
  Job,
  JobCreateRequest,
  JobListResponse,
  JobsHealth,
  JobsListResponse,
  JobsProcessorHealth,
} from './schemas/jobs.js';

export const jobsRoutes = createOpenApiApp();

const DB_BUSY_MESSAGE =
  'Database is temporarily busy — another operation is holding a write lock. ' +
  'Try again in a moment; if it keeps happening, check for duplicate backend processes.';

/**
 * Staleness threshold for the processor heartbeat.
 *
 * The loop ticks about once a second, so anything older than 15s is very likely a
 * hang — loose enough that a slow query or a long socket emit is not a false alarm.
 */
const PROCESSOR_STALE_AFTER_SECONDS = 15;

/** SQLite lock contention, which is a transient 503 rather than a 500. */
function isDbBusy(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
  const message = String(e instanceof Error ? e.message : e).toLowerCase();
  return message.includes('locked') || message.includes('busy');
}

/**
 * Open `visualizer.db` for one operation, creating the schema if needed.
 *
 * `initJobsDb` rather than a read-only open even for GETs: this is the app's own
 * database, and a first run must not 404 the jobs page just because nothing has
 * enqueued a job yet.
 */
function withJobsDb<T>(fn: (db: Db) => T): T {
  const db = initJobsDb(config.VISUALIZER_DB);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Prepare a job row for a JSON response or a socket emit.
 *
 * Attaches the log summary counts from `job_logs` — the same numbers the list
 * endpoint reports, so a job looks identical however the client obtained it — then
 * compacts the checkpoint lists.
 */
function buildJobPayload(db: Db, job: JobRow, extra: Record<string, unknown> = {}): Job {
  const stats = getJobLogStatsBulk(db, [job.id]).get(job.id);
  const enriched = {
    ...job,
    logs_total: stats?.logs_total ?? job.logs_total ?? 0,
    warning_count: stats?.warning_count ?? job.warning_count ?? 0,
    error_count: stats?.error_count ?? job.error_count ?? 0,
    last_log_at: stats?.last_log_at ?? job.last_log_at ?? null,
    ...extra,
  };
  return compactJobPayload(enriched as unknown as Record<string, unknown>) as unknown as Job;
}

// --- list and create --------------------------------------------------------

const listRoute = createRoute({
  method: 'get',
  path: '/jobs/',
  tags: ['jobs'],
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(JobsListResponse) },
  }),
});

jobsRoutes.openapi(listRoute, (c) => {
  const status = c.req.query('status');
  // Unparseable query values fall back to the default.
  const toInt = (raw: string | undefined, fallback: number): number =>
    raw !== undefined && /^\s*[+-]?\d+\s*$/.test(raw) ? Number.parseInt(raw.trim(), 10) : fallback;
  const limit = Math.max(1, Math.min(toInt(c.req.query('limit'), 50), 500));
  const offset = Math.max(0, toInt(c.req.query('offset'), 0));

  return withJobsDb((db) => {
    const jobs = listJobs(db, { status: status ?? null, limit, offset }).map(
      (job) => compactJobPayload(job as unknown as Record<string, unknown>) as unknown as Job,
    );
    const total = countJobs(db, status ?? null);
    return c.json(paginatedBody(jobs, total, offset, limit), 200);
  });
});

const createRouteDef = createRoute({
  method: 'post',
  path: '/jobs/',
  tags: ['jobs'],
  request: { body: { content: jsonBody(JobCreateRequest) } },
  responses: withValidationError({
    201: { description: 'Created', content: jsonBody(Job) },
    400: { description: 'Bad Request', content: jsonBody(ErrorBody) },
    422: { description: 'Catalog unavailable', content: jsonBody(CatalogUnavailableError) },
    503: { description: 'Database busy', content: jsonBody(DbBusyError) },
  }),
});

jobsRoutes.openapi(createRouteDef, (c) => {
  // The handler's own 'type is required' 400 is unreachable — a missing `type` is 422
  // before this runs. The 400 stays declared because the contract lists it.
  const { type: jobType, metadata } = c.req.valid('json');

  // Refused at enqueue time rather than accepted and failed later: a queued job
  // that can never run is worse than a clear rejection, because the user has to
  // go find it in the list to learn why nothing happened.
  if (catalogRequiringJobTypes().has(jobType)) {
    const status = describeLibraryDb();
    if (!status.exists) {
      return c.json(
        {
          error: (
            `Cannot enqueue '${jobType}': Lightroom Classic catalog database is unavailable. ` +
            `${status.reason ?? ''}`
          ).trim(),
          code: 'catalog_unavailable' as const,
          library_db: status,
        },
        422,
      );
    }
  }

  try {
    const payload = withJobsDb((db) => {
      const jobId = createJob(db, jobType, metadata);
      const job = getJob(db, jobId);
      if (!job) throw new Error('job vanished after insert');
      return buildJobPayload(db, job);
    });
    emitJobEvent('job_created', payload);
    return c.json(payload, 201);
  } catch (e) {
    if (isDbBusy(e)) return c.json({ error: DB_BUSY_MESSAGE, code: 'db_busy' as const }, 503);
    throw e;
  }
});

// --- active and health ------------------------------------------------------

const activeRoute = createRoute({
  method: 'get',
  path: '/jobs/active',
  tags: ['jobs'],
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(JobListResponse) },
  }),
});

jobsRoutes.openapi(activeRoute, (c) =>
  withJobsDb((db) =>
    c.json(
      getActiveJobs(db).map(
        (job) => compactJobPayload(job as unknown as Record<string, unknown>) as unknown as Job,
      ),
      200,
    ),
  ),
);

const healthRoute = createRoute({
  method: 'get',
  path: '/jobs/health',
  tags: ['jobs'],
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(JobsHealth) },
  }),
});

/**
 * Subsystem health, so the UI can warn before the user enqueues a broken job.
 *
 * Always 200: `library_db.exists === false` is itself the signal to render a
 * banner, and a non-200 would make the banner impossible to distinguish from the
 * endpoint being down.
 */
jobsRoutes.openapi(healthRoute, (c) => {
  const status = describeLibraryDb();
  return c.json(
    {
      library_db: status,
      jobs_requiring_catalog: [...catalogRequiringJobTypes()].sort(),
      catalog_available: status.exists,
    },
    200,
  );
});

const processorHealthRoute = createRoute({
  method: 'get',
  path: '/jobs/_processor_health',
  tags: ['jobs'],
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(JobsProcessorHealth) },
  }),
});

/**
 * Diagnose the background processor — was it started, is it ticking?
 *
 * Added after an incident where a `pending` job sat untouched with no way to tell
 * whether the processor was alive. `stale` encodes the threshold clients should read.
 */
jobsRoutes.openapi(processorHealthRoute, (c) => {
  const snapshot = getProcessorHealthSnapshot();
  const lastIter = snapshot.last_iteration_at;
  const age = lastIter === null ? null : Math.max(0, Date.now() / 1000 - lastIter);

  return withJobsDb((db) =>
    c.json(
      {
        running: snapshot.running,
        started_at: snapshot.started_at,
        last_iteration_at: lastIter,
        last_iteration_age_seconds: age,
        iterations_total: snapshot.iterations_total,
        current_job_id: snapshot.current_job_id,
        current_job_started_at: snapshot.current_job_started_at,
        pending_count: countJobs(db, 'pending'),
        running_count: countJobs(db, 'running'),
        stale: age !== null && age > PROCESSOR_STALE_AFTER_SECONDS,
        stale_threshold_seconds: PROCESSOR_STALE_AFTER_SECONDS,
        last_error: snapshot.last_error,
      },
      200,
    ),
  );
});

// --- one job ----------------------------------------------------------------
//
// Registered AFTER the static paths above. Hono matches in registration order, so
// `{job_id}` would otherwise swallow `active`, `health` and `_processor_health`.

const detailRoute = createRoute({
  method: 'get',
  path: '/jobs/{job_id}',
  tags: ['jobs'],
  request: { params: z.object({ job_id: z.string() }) },
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(Job) },
    404: { description: 'Not Found', content: jsonBody(ErrorBody) },
  }),
});

jobsRoutes.openapi(detailRoute, (c) => {
  const jobId = c.req.valid('param').job_id;

  // Resolved before the job is loaded, so `getJob` only pulls the rows the client
  // actually needs. The modal asks for 200–1000 in steady state; anything larger
  // is a power-user override, capped at 10k.
  const raw = c.req.query('logs_limit');
  const parsed = raw !== undefined && /^\s*[+-]?\d+\s*$/.test(raw)
    ? Number.parseInt(raw.trim(), 10)
    : null;
  let logsLimit: number | null = null;
  let includeAllLogs = false;
  if (parsed === 0) {
    includeAllLogs = true;
  } else if (parsed !== null) {
    logsLimit = Math.max(1, Math.min(parsed, 10_000));
  }

  return withJobsDb((db) => {
    const job = getJob(db, jobId, { logsLimit, includeAllLogs });
    if (!job) return c.json({ error: 'Job not found' }, 404);
    // The full count, not the tail length, so the UI can say "showing N of M".
    job.logs_total = countJobLogs(db, jobId);
    return c.json(buildJobPayload(db, job, { logs_total: job.logs_total }), 200);
  });
});

const cancelRoute = createRoute({
  method: 'delete',
  path: '/jobs/{job_id}',
  tags: ['jobs'],
  request: { params: z.object({ job_id: z.string() }) },
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(Job) },
    400: { description: 'Bad Request', content: jsonBody(ErrorBody) },
    404: { description: 'Not Found', content: jsonBody(ErrorBody) },
    503: { description: 'Database busy', content: jsonBody(DbBusyError) },
  }),
});

jobsRoutes.openapi(cancelRoute, (c) => {
  const jobId = c.req.valid('param').job_id;
  try {
    const result = withJobsDb((db) => {
      const outcome = transitionCancel(db, jobId);
      if (outcome.edge === 'invalid' && outcome.job === null) {
        return { status: 404 as const, body: { error: 'Job not found' } };
      }
      if (outcome.edge === 'invalid') {
        return { status: 400 as const, body: { error: outcome.reason ?? 'Cannot cancel' } };
      }
      if (outcome.shouldSignalCancel) signalCancel(jobId);
      if (outcome.edge === 'noop') {
        return {
          status: 200 as const,
          emit: false,
          body: buildJobPayload(db, outcome.job!, {
            cancel_noop: true,
            cancel_noop_reason: outcome.reason,
          }),
        };
      }
      return { status: 200 as const, emit: true, body: buildJobPayload(db, outcome.job!) };
    });

    if (result.status === 404) return c.json(result.body as { error: string }, 404);
    if (result.status === 400) return c.json(result.body as { error: string }, 400);
    // A noop is not broadcast: nothing changed, and every connected client would
    // otherwise re-render the job for no reason.
    if (result.emit) emitJobEvent('job_updated', result.body as Job);
    return c.json(result.body as Job, 200);
  } catch (e) {
    if (isDbBusy(e)) return c.json({ error: DB_BUSY_MESSAGE, code: 'db_busy' as const }, 503);
    throw e;
  }
});

const retryRoute = createRoute({
  method: 'post',
  path: '/jobs/{job_id}/retry',
  tags: ['jobs'],
  request: { params: z.object({ job_id: z.string() }) },
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(Job) },
    400: { description: 'Bad Request', content: jsonBody(ErrorBody) },
    404: { description: 'Not Found', content: jsonBody(ErrorBody) },
    503: { description: 'Database busy', content: jsonBody(DbBusyError) },
  }),
});

jobsRoutes.openapi(retryRoute, (c) => {
  const jobId = c.req.valid('param').job_id;
  try {
    const result = withJobsDb((db) => {
      const outcome = transitionRetry(db, jobId);
      if (outcome.edge === 'invalid' && outcome.job === null) {
        return { status: 404 as const, body: { error: 'Job not found' } };
      }
      if (outcome.edge === 'invalid') {
        return { status: 400 as const, body: { error: outcome.reason ?? 'Cannot retry' } };
      }
      return { status: 200 as const, body: buildJobPayload(db, outcome.job!) };
    });
    if (result.status === 404) return c.json(result.body as { error: string }, 404);
    if (result.status === 400) return c.json(result.body as { error: string }, 400);
    return c.json(result.body as Job, 200);
  } catch (e) {
    if (isDbBusy(e)) return c.json({ error: DB_BUSY_MESSAGE, code: 'db_busy' as const }, 503);
    throw e;
  }
});
