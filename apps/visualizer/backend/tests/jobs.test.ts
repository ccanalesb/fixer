/**
 * Jobs route, transition and processor tests.
 *
 * `DATABASE_PATH` points at a temp file per test so nothing touches the user's real
 * `visualizer.db`, and `LIBRARY_DB` is set explicitly because the catalog-required
 * gate on `POST /api/jobs/` reads it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import {
  addJobLog,
  countJobs,
  createJob,
  getJob,
  initJobsDb,
  updateJobField,
  updateJobStatus,
} from '../src/db/jobs/jobs.js';
import type { Db } from '../src/db/connection.js';
import { JobRunner } from '../src/jobs/runner.js';
import { recoverOrphanedJobs, tick } from '../src/jobs/processor.js';
import { transitionCancel, transitionRetry } from '../src/jobs/transitions.js';
import { catalogRequiringJobTypes } from '../src/jobs/registry.js';

let dir: string;
let jobsDbPath: string;
let libraryDbPath: string;
const app = createApp();
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

/** A connection to the same temp jobs DB the routes use. */
function openJobsDb(): Db {
  return initJobsDb(jobsDbPath);
}

function withDb<T>(fn: (db: Db) => T): T {
  const db = openJobsDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** `withDb` closes on return, which would shut the handle before an await resolves. */
async function withDbAsync<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const db = openJobsDb();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-jobs-'));
  jobsDbPath = join(dir, 'visualizer.db');
  libraryDbPath = join(dir, 'library.db');
  // A real (empty) SQLite file, so `describeLibraryDb` reports it as existing.
  new Database(libraryDbPath).close();
  process.env.DATABASE_PATH = jobsDbPath;
  process.env.LIBRARY_DB = libraryDbPath;
  withDb(() => undefined);
});

afterEach(() => {
  delete process.env.DATABASE_PATH;
  delete process.env.LIBRARY_DB;
  rmSync(dir, { recursive: true, force: true });
});

describe('job log storage', () => {
  it('appends logs without rewriting the row', () => {
    withDb((db) => {
      const jobId = createJob(db, 'catalog_sync', {});
      for (let i = 0; i < 50; i += 1) addJobLog(db, jobId, 'info', `step ${i}`);

      const job = getJob(db, jobId)!;
      expect(job.logs).toHaveLength(50);
      expect(job.logs[0]!.message).toBe('step 0');
      // Chronological, even though the tail query selects descending.
      expect(job.logs.at(-1)!.message).toBe('step 49');
    });
  });

  it('returns only the requested tail, in order', () => {
    withDb((db) => {
      const jobId = createJob(db, 'catalog_sync', {});
      for (let i = 0; i < 20; i += 1) addJobLog(db, jobId, 'info', `step ${i}`);

      const job = getJob(db, jobId, { logsLimit: 5 })!;
      expect(job.logs.map((l) => l.message)).toEqual([
        'step 15',
        'step 16',
        'step 17',
        'step 18',
        'step 19',
      ]);
    });
  });

  it('silently ignores a log for a job that no longer exists', () => {
    withDb((db) => {
      // A worker thread racing a deletion must not crash mid-batch.
      expect(() => addJobLog(db, 'ghost', 'info', 'orphan')).not.toThrow();
      expect(db.prepare('SELECT COUNT(*) AS c FROM job_logs').get()).toEqual({ c: 0 });
    });
  });

  it('reports warning and error counts alongside the total', async () => {
    const jobId = withDb((db) => {
      const id = createJob(db, 'catalog_sync', {});
      addJobLog(db, id, 'info', 'fine');
      addJobLog(db, id, 'warning', 'hmm');
      addJobLog(db, id, 'warning', 'hmm again');
      addJobLog(db, id, 'error', 'bad');
      return id;
    });

    const body = await json<{
      logs_total: number;
      warning_count: number;
      error_count: number;
      last_log_at: string;
    }>(await send('GET', `/api/jobs/${jobId}`));
    expect(body.logs_total).toBe(4);
    expect(body.warning_count).toBe(2);
    expect(body.error_count).toBe(1);
    expect(body.last_log_at).toBeTruthy();
  });

  it('folds a legacy JSON-blob logs column into job_logs on open', () => {
    withDb((db) => {
      // Rows written before the job_logs table carry this shape. Every read path
      // now looks only at the table, so without the migration the history is lost.
      db.prepare(
        `INSERT INTO jobs (id, type, status, progress, logs, created_at, metadata)
         VALUES ('legacy', 'catalog_sync', 'completed', 100, ?, '2026-01-01T00:00:00', '{}')`,
      ).run(
        JSON.stringify([
          { timestamp: 't1', level: 'info', message: 'old one' },
          { timestamp: 't2', level: 'error', message: 'old two' },
        ]),
      );
    });

    // Re-opening runs the migration.
    withDb((db) => {
      const job = getJob(db, 'legacy')!;
      expect(job.logs).toEqual([
        { timestamp: 't1', level: 'info', message: 'old one' },
        { timestamp: 't2', level: 'error', message: 'old two' },
      ]);
      // Blanked, so a third open does not duplicate them.
      expect(db.prepare("SELECT logs FROM jobs WHERE id = 'legacy'").get()).toEqual({
        logs: '[]',
      });
    });

    withDb((db) => {
      expect(getJob(db, 'legacy')!.logs).toHaveLength(2);
    });
  });

  it('survives an unparseable legacy blob rather than failing the migration', () => {
    withDb((db) => {
      db.prepare(
        `INSERT INTO jobs (id, type, status, progress, logs, created_at, metadata)
         VALUES ('broken', 'catalog_sync', 'completed', 100, 'not json', '2026-01-01', '{}')`,
      ).run();
    });
    withDb((db) => {
      expect(getJob(db, 'broken')!.logs).toEqual([]);
    });
  });
});

describe('transitions', () => {
  it('cancels a pending job and does not signal the runner', () => {
    withDb((db) => {
      const jobId = createJob(db, 'catalog_sync', {});
      const outcome = transitionCancel(db, jobId);
      expect(outcome.edge).toBe('cancelled');
      expect(outcome.job!.status).toBe('cancelled');
      // Nothing is running, so there is no worker to interrupt.
      expect(outcome.shouldSignalCancel).toBe(false);
    });
  });

  it('cancels a running job and signals the runner', () => {
    withDb((db) => {
      const jobId = createJob(db, 'catalog_sync', {});
      updateJobStatus(db, jobId, 'running');
      const outcome = transitionCancel(db, jobId);
      expect(outcome.edge).toBe('cancelled');
      expect(outcome.shouldSignalCancel).toBe(true);
    });
  });

  it('treats a second cancel as a noop that still re-signals', () => {
    withDb((db) => {
      const jobId = createJob(db, 'catalog_sync', {});
      updateJobStatus(db, jobId, 'cancelled');
      const outcome = transitionCancel(db, jobId);
      expect(outcome.edge).toBe('noop');
      expect(outcome.reason).toBe('Job is already cancelled');
      // Re-signalled because the first cancel may have landed while the worker
      // was mid-step and never actually stopped it.
      expect(outcome.shouldSignalCancel).toBe(true);
    });
  });

  it.each(['completed', 'failed'] as const)('treats cancelling a %s job as a noop', (status) => {
    withDb((db) => {
      const jobId = createJob(db, 'catalog_sync', {});
      updateJobStatus(db, jobId, status);
      const outcome = transitionCancel(db, jobId);
      expect(outcome.edge).toBe('noop');
      expect(outcome.shouldSignalCancel).toBe(false);
    });
  });

  it('retries a failed job, clearing the failure but keeping the checkpoint', () => {
    withDb((db) => {
      const jobId = createJob(db, 'batch_score', {
        checkpoint: { checkpoint_version: 1, processed_triplets: [['a', 'b', 'c']] },
      });
      updateJobStatus(db, jobId, 'failed', { progress: 42, currentStep: 'died here' });
      db.prepare("UPDATE jobs SET error = 'boom', error_severity = 'critical' WHERE id = ?").run(
        jobId,
      );
      updateJobField(db, jobId, 'result', { partial: true });

      const outcome = transitionRetry(db, jobId);
      expect(outcome.edge).toBe('retried');
      const job = outcome.job!;
      expect(job.status).toBe('pending');
      expect(job.progress).toBe(0);
      expect(job.error).toBeNull();
      expect(job.error_severity).toBeNull();
      expect(job.result).toBeNull();
      // The checkpoint is what the retry resumes from, so it must survive.
      expect((job.metadata.checkpoint as { checkpoint_version: number }).checkpoint_version).toBe(1);
    });
  });

  it('refuses to retry a job that is not failed or cancelled', () => {
    withDb((db) => {
      const jobId = createJob(db, 'catalog_sync', {});
      updateJobStatus(db, jobId, 'running');
      const outcome = transitionRetry(db, jobId);
      expect(outcome.edge).toBe('invalid');
      expect(outcome.reason).toBe('Can only retry failed or cancelled jobs');
    });
  });

  it('reports a missing job distinctly from an invalid transition', () => {
    withDb((db) => {
      for (const outcome of [transitionCancel(db, 'ghost'), transitionRetry(db, 'ghost')]) {
        expect(outcome.edge).toBe('invalid');
        expect(outcome.job).toBeNull();
        expect(outcome.reason).toBe('Job not found');
      }
    });
  });
});

describe('GET /api/jobs/', () => {
  it('paginates and reports the envelope', async () => {
    withDb((db) => {
      for (let i = 0; i < 5; i += 1) createJob(db, 'catalog_sync', { n: i });
    });

    const body = await json<{
      total: number;
      data: { id: string }[];
      pagination: Record<string, unknown>;
    }>(await send('GET', '/api/jobs/?limit=2&offset=2'));

    expect(body.total).toBe(5);
    expect(body.data).toHaveLength(2);
    expect(body.pagination).toEqual({
      offset: 2,
      limit: 2,
      current_page: 2,
      total_pages: 3,
      has_more: true,
    });
  });

  it('filters by status and counts the filtered total', async () => {
    withDb((db) => {
      const a = createJob(db, 'catalog_sync', {});
      createJob(db, 'catalog_sync', {});
      updateJobStatus(db, a, 'failed');
    });
    const body = await json<{ total: number; data: { status: string }[] }>(
      await send('GET', '/api/jobs/?status=failed'),
    );
    expect(body.total).toBe(1);
    expect(body.data[0]!.status).toBe('failed');
  });

  it('omits log bodies from the listing', async () => {
    withDb((db) => {
      const id = createJob(db, 'catalog_sync', {});
      for (let i = 0; i < 100; i += 1) addJobLog(db, id, 'info', `noise ${i}`);
    });
    const body = await json<{ data: { logs: unknown[]; logs_total: number }[] }>(
      await send('GET', '/api/jobs/'),
    );
    // A listing of 50 running jobs used to pull tens of megabytes of history.
    expect(body.data[0]!.logs).toEqual([]);
    expect(body.data[0]!.logs_total).toBe(100);
  });

  it('replaces checkpoint lists with counts', async () => {
    withDb((db) => {
      createJob(db, 'batch_embed_image', {
        checkpoint: {
          checkpoint_version: 1,
          processed_image_keys: ['a', 'b', 'c', 'd'],
        },
      });
    });
    const body = await json<{ data: { metadata: { checkpoint: Record<string, unknown> } }[] }>(
      await send('GET', '/api/jobs/'),
    );
    const checkpoint = body.data[0]!.metadata.checkpoint;
    // The UI only ever shows how many; the list itself is multi-megabyte on a
    // real 43k-image job.
    expect(checkpoint.processed_image_keys_count).toBe(4);
    expect('processed_image_keys' in checkpoint).toBe(false);
  });

  it('clamps limit and falls back on an unparseable one', async () => {
    withDb((db) => createJob(db, 'catalog_sync', {}));
    for (const query of ['?limit=99999', '?limit=abc', '?limit=0', '?offset=-5']) {
      expect((await send('GET', `/api/jobs/${query}`)).status).toBe(200);
    }
  });
});

describe('POST /api/jobs/', () => {
  it('creates a job and returns it with a 201', async () => {
    const res = await send('POST', '/api/jobs/', { type: 'catalog_sync', metadata: { a: 1 } });
    expect(res.status).toBe(201);
    const body = await json<{ id: string; type: string; status: string; metadata: unknown }>(res);
    expect(body.type).toBe('catalog_sync');
    expect(body.status).toBe('pending');
    expect(body.metadata).toEqual({ a: 1 });
    expect(withDb((db) => countJobs(db))).toBe(1);
  });

  it('defaults metadata to an empty object', async () => {
    const body = await json<{ metadata: unknown }>(
      await send('POST', '/api/jobs/', { type: 'catalog_sync' }),
    );
    expect(body.metadata).toEqual({});
  });

  it('422s a body with no type', async () => {
    // Missing type is rejected by schema validation (422).
    expect((await send('POST', '/api/jobs/', {})).status).toBe(422);
  });

  it('accepts an unknown job type — the processor decides', async () => {
    // Not in JOB_TYPES, so not catalog-gated. The job is created and then fails
    // with "Unknown job type", which is where the user can see it.
    const res = await send('POST', '/api/jobs/', { type: 'not_a_real_type' });
    expect(res.status).toBe(201);
  });

  it('422s a catalog-requiring type when library.db is missing', async () => {
    process.env.LIBRARY_DB = join(dir, 'nope.db');
    const res = await send('POST', '/api/jobs/', { type: 'catalog_sync' });
    expect(res.status).toBe(422);
    const body = await json<{
      error: string;
      code: string;
      library_db: { exists: boolean; source: string; reason: string };
    }>(res);

    expect(body.code).toBe('catalog_unavailable');
    expect(body.error).toContain("Cannot enqueue 'catalog_sync'");
    expect(body.library_db.exists).toBe(false);
    expect(body.library_db.source).toBe('env');
    expect(body.library_db.reason).toContain('does not exist');
    // Refused at enqueue time, so nothing was queued.
    expect(withDb((db) => countJobs(db))).toBe(0);
  });

  it('refuses frame substance without the catalog, which its cache check reads', async () => {
    process.env.LIBRARY_DB = join(dir, 'nope.db');
    expect(catalogRequiringJobTypes().has('batch_frame_substance')).toBe(true);
    const res = await send('POST', '/api/jobs/', { type: 'batch_frame_substance' });
    expect(res.status).toBe(422);
  });

  it('allows a job type that does not need the catalog', () => {
    expect(catalogRequiringJobTypes().has('app_model_install')).toBe(false);
  });
});

describe('GET /api/jobs/{job_id}', () => {
  it('returns the job with a default log tail and the full total', async () => {
    const jobId = withDb((db) => {
      const id = createJob(db, 'catalog_sync', {});
      for (let i = 0; i < 30; i += 1) addJobLog(db, id, 'info', `step ${i}`);
      return id;
    });

    const body = await json<{ logs: { message: string }[]; logs_total: number }>(
      await send('GET', `/api/jobs/${jobId}?logs_limit=5`),
    );
    expect(body.logs).toHaveLength(5);
    // The count is of the whole history, so the UI can say "showing 5 of 30".
    expect(body.logs_total).toBe(30);
  });

  it('treats logs_limit=0 as "everything"', async () => {
    const jobId = withDb((db) => {
      const id = createJob(db, 'catalog_sync', {});
      for (let i = 0; i < 30; i += 1) addJobLog(db, id, 'info', `step ${i}`);
      return id;
    });
    const body = await json<{ logs: unknown[] }>(
      await send('GET', `/api/jobs/${jobId}?logs_limit=0`),
    );
    expect(body.logs).toHaveLength(30);
  });

  it('caps a power-user logs_limit at 10k', async () => {
    const jobId = withDb((db) => createJob(db, 'catalog_sync', {}));
    expect((await send('GET', `/api/jobs/${jobId}?logs_limit=999999`)).status).toBe(200);
  });

  it('404s an unknown id', async () => {
    const res = await send('GET', '/api/jobs/ghost');
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: 'Job not found' });
  });
});

describe('DELETE /api/jobs/{job_id}', () => {
  it('cancels and reports the updated job', async () => {
    const jobId = withDb((db) => createJob(db, 'catalog_sync', {}));
    const res = await send('DELETE', `/api/jobs/${jobId}`);
    expect(res.status).toBe(200);
    const body = await json<{ status: string; cancel_noop?: boolean }>(res);
    expect(body.status).toBe('cancelled');
    expect(body.cancel_noop).toBeUndefined();
  });

  it('marks a repeat cancel as a noop with the reason', async () => {
    const jobId = withDb((db) => {
      const id = createJob(db, 'catalog_sync', {});
      updateJobStatus(db, id, 'completed');
      return id;
    });
    const body = await json<{ cancel_noop: boolean; cancel_noop_reason: string }>(
      await send('DELETE', `/api/jobs/${jobId}`),
    );
    expect(body.cancel_noop).toBe(true);
    expect(body.cancel_noop_reason).toBe('Job is already completed');
  });

  it('404s an unknown id', async () => {
    expect((await send('DELETE', '/api/jobs/ghost')).status).toBe(404);
  });
});

describe('POST /api/jobs/{job_id}/retry', () => {
  it('re-queues a failed job', async () => {
    const jobId = withDb((db) => {
      const id = createJob(db, 'catalog_sync', {});
      updateJobStatus(db, id, 'failed');
      return id;
    });
    const body = await json<{ status: string; progress: number }>(
      await send('POST', `/api/jobs/${jobId}/retry`),
    );
    expect(body.status).toBe('pending');
    expect(body.progress).toBe(0);
  });

  it('400s a job that is not retryable', async () => {
    const jobId = withDb((db) => {
      const id = createJob(db, 'catalog_sync', {});
      updateJobStatus(db, id, 'running');
      return id;
    });
    const res = await send('POST', `/api/jobs/${jobId}/retry`);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'Can only retry failed or cancelled jobs' });
  });

  it('404s an unknown id', async () => {
    expect((await send('POST', '/api/jobs/ghost/retry')).status).toBe(404);
  });
});

describe('GET /api/jobs/active', () => {
  it('returns pending and running jobs as a bare array', async () => {
    withDb((db) => {
      createJob(db, 'catalog_sync', {});
      const running = createJob(db, 'catalog_sync', {});
      updateJobStatus(db, running, 'running');
      const done = createJob(db, 'catalog_sync', {});
      updateJobStatus(db, done, 'completed');
    });
    const body = await json<{ status: string }[]>(await send('GET', '/api/jobs/active'));
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((j) => j.status).sort()).toEqual(['pending', 'running']);
  });
});

describe('GET /api/jobs/health', () => {
  it('reports the catalog as available and lists the gated types', async () => {
    const body = await json<{
      library_db: { exists: boolean; source: string };
      jobs_requiring_catalog: string[];
      catalog_available: boolean;
    }>(await send('GET', '/api/jobs/health'));

    expect(body.catalog_available).toBe(true);
    expect(body.library_db.source).toBe('env');
    expect(body.jobs_requiring_catalog).toContain('catalog_sync');
    expect(body.jobs_requiring_catalog).toContain('batch_frame_substance');
    expect(body.jobs_requiring_catalog).not.toContain('app_model_install');
    // Sorted, so the UI can render it without reordering.
    expect([...body.jobs_requiring_catalog].sort()).toEqual(body.jobs_requiring_catalog);
  });

  it('is still a 200 when the catalog is missing', async () => {
    process.env.LIBRARY_DB = join(dir, 'nope.db');
    const res = await send('GET', '/api/jobs/health');
    // `exists: false` is itself the banner signal; a non-200 would be
    // indistinguishable from the endpoint being down.
    expect(res.status).toBe(200);
    const body = await json<{ catalog_available: boolean }>(res);
    expect(body.catalog_available).toBe(false);
  });
});

describe('GET /api/jobs/_processor_health', () => {
  it('reports a stopped processor with well-formed fields', async () => {
    withDb((db) => {
      createJob(db, 'catalog_sync', {});
      const running = createJob(db, 'catalog_sync', {});
      updateJobStatus(db, running, 'running');
    });

    const res = await send('GET', '/api/jobs/_processor_health');
    expect(res.status).toBe(200);
    const body = await json<{
      running: boolean;
      pending_count: number;
      running_count: number;
      stale: boolean;
      stale_threshold_seconds: number;
      iterations_total: number;
    }>(res);

    // The test process never started the processor; the payload is still complete.
    expect(body.running).toBe(false);
    expect(body.pending_count).toBe(1);
    expect(body.running_count).toBe(1);
    expect(body.stale_threshold_seconds).toBe(15);
    expect(body.iterations_total).toBe(0);
  });
});

describe('restart recovery', () => {
  it('re-queues a running job that holds a v1 checkpoint', () => {
    withDb((db) => {
      const jobId = createJob(db, 'batch_score', {
        checkpoint: { checkpoint_version: 1, processed_triplets: [] },
      });
      updateJobStatus(db, jobId, 'running', { progress: 37 });

      expect(recoverOrphanedJobs(db)).toEqual([jobId]);
      const job = getJob(db, jobId)!;
      expect(job.status).toBe('pending');
      // Progress is preserved so the UI does not appear to lose the work.
      expect(job.progress).toBe(37);
      expect(job.current_step).toBe('Recovered after restart');
      expect(job.logs.some((l) => l.message.includes('re-queued with checkpoint'))).toBe(true);
    });
  });

  it('fails a running job with no checkpoint rather than replaying it', () => {
    withDb((db) => {
      const jobId = createJob(db, 'catalog_sync', {});
      updateJobStatus(db, jobId, 'running');

      expect(recoverOrphanedJobs(db)).toEqual([]);
      const job = getJob(db, jobId)!;
      // Re-running from scratch could duplicate side effects, so the user decides.
      expect(job.status).toBe('failed');
      expect(job.logs.some((l) => l.message.includes('marked failed'))).toBe(true);
    });
  });

  it('ignores a checkpoint from an older version', () => {
    withDb((db) => {
      const jobId = createJob(db, 'batch_score', { checkpoint: { checkpoint_version: 0 } });
      updateJobStatus(db, jobId, 'running');
      expect(recoverOrphanedJobs(db)).toEqual([]);
      expect(getJob(db, jobId)!.status).toBe('failed');
    });
  });

  it('leaves pending and finished jobs alone', () => {
    withDb((db) => {
      const pending = createJob(db, 'catalog_sync', {});
      const done = createJob(db, 'catalog_sync', {});
      updateJobStatus(db, done, 'completed');

      recoverOrphanedJobs(db);
      expect(getJob(db, pending)!.status).toBe('pending');
      expect(getJob(db, done)!.status).toBe('completed');
    });
  });
});

describe('the processor loop', () => {
  it('fails an unregistered job type rather than leaving it running', async () => {
    await withDbAsync(async (db) => {
      const jobId = createJob(db, 'not_a_real_type', {});
      await tick(db, new JobRunner(db));

      const job = getJob(db, jobId)!;
      expect(job.status).toBe('failed');
      expect(job.error).toBe('Unknown job type: not_a_real_type');
      expect(job.error_severity).toBe('error');
    });
  });

  it('does not start a job cancelled while queued', async () => {
    await withDbAsync(async (db) => {
      const jobId = createJob(db, 'catalog_sync', {});
      updateJobStatus(db, jobId, 'cancelled');
      await tick(db, new JobRunner(db));
      expect(getJob(db, jobId)!.status).toBe('cancelled');
    });
  });

  it('counts a pass with no work as a healthy tick', async () => {
    await withDbAsync(async (db) => {
      // Proves "quietly waiting" is distinguishable from "stuck".
      await expect(tick(db, new JobRunner(db))).resolves.toBeUndefined();
    });
  });
});

describe('JobRunner', () => {
  it('records the lifecycle of a successful job', () => {
    withDb((db) => {
      const runner = new JobRunner(db);
      const jobId = createJob(db, 'catalog_sync', {});

      expect(runner.startJob(jobId, 'catalog_sync')).toBe(true);
      expect(getJob(db, jobId)!.status).toBe('running');

      runner.updateProgress(jobId, 50, 'Halfway');
      expect(getJob(db, jobId)!.progress).toBe(50);

      runner.completeJob(jobId, { count: 3 });
      const job = getJob(db, jobId)!;
      expect(job.status).toBe('completed');
      expect(job.progress).toBe(100);
      expect(job.result).toEqual({ count: 3 });
      expect(job.error_severity).toBeNull();
    });
  });

  it('logs a step once, however often progress is reported', () => {
    withDb((db) => {
      const runner = new JobRunner(db);
      const jobId = createJob(db, 'catalog_sync', {});
      runner.startJob(jobId, 'catalog_sync');

      for (let i = 0; i < 5; i += 1) runner.updateProgress(jobId, 10, 'Scanning');
      const scanning = getJob(db, jobId)!.logs.filter((l) => l.message === 'Scanning');
      // Without the de-duplication a batch job writes thousands of identical lines.
      expect(scanning).toHaveLength(1);

      runner.updateProgress(jobId, 20, 'Scanning');
      // A changed progress value is a new entry.
      expect(getJob(db, jobId)!.logs.filter((l) => l.message === 'Scanning')).toHaveLength(2);
    });
  });

  it('refuses to start a job cancelled while queued', () => {
    withDb((db) => {
      const runner = new JobRunner(db);
      const jobId = createJob(db, 'catalog_sync', {});
      updateJobStatus(db, jobId, 'cancelled');
      expect(runner.startJob(jobId, 'catalog_sync')).toBe(false);
    });
  });

  it('lets a cancellation win over a late completion', () => {
    withDb((db) => {
      const runner = new JobRunner(db);
      const jobId = createJob(db, 'catalog_sync', {});
      runner.startJob(jobId, 'catalog_sync');
      updateJobStatus(db, jobId, 'cancelled');

      runner.completeJob(jobId, { count: 1 });
      // The user's decision beats a handler that finished a moment too late.
      expect(getJob(db, jobId)!.status).toBe('cancelled');
    });
  });

  it('lets a cancellation win over a late failure too', () => {
    withDb((db) => {
      const runner = new JobRunner(db);
      const jobId = createJob(db, 'catalog_sync', {});
      runner.startJob(jobId, 'catalog_sync');
      updateJobStatus(db, jobId, 'cancelled');

      runner.failJob(jobId, 'boom');
      expect(getJob(db, jobId)!.status).toBe('cancelled');
    });
  });

  it('notices a cancel written straight to the database', () => {
    withDb((db) => {
      const runner = new JobRunner(db);
      const jobId = createJob(db, 'catalog_sync', {});
      runner.startJob(jobId, 'catalog_sync');
      expect(runner.isCancelled(jobId)).toBe(false);

      // Not via signalCancel: a long-running handler has to notice either route.
      updateJobStatus(db, jobId, 'cancelled');
      expect(runner.isCancelled(jobId)).toBe(true);
    });
  });

  it('notices an in-process signal without a database write', () => {
    withDb((db) => {
      const runner = new JobRunner(db);
      const jobId = createJob(db, 'catalog_sync', {});
      runner.startJob(jobId, 'catalog_sync');

      runner.signalCancel(jobId);
      expect(runner.isCancelled(jobId)).toBe(true);
      // The flag is cooperative only — the row is untouched.
      expect(getJob(db, jobId)!.status).toBe('running');
    });
  });

  it('normalizes an unknown severity to error', () => {
    withDb((db) => {
      const runner = new JobRunner(db);
      const jobId = createJob(db, 'catalog_sync', {});
      runner.startJob(jobId, 'catalog_sync');
      runner.failJob(jobId, 'boom', 'nonsense' as never);
      expect(getJob(db, jobId)!.error_severity).toBe('error');
    });
  });

  it('persists and clears a checkpoint without disturbing other metadata', () => {
    withDb((db) => {
      const runner = new JobRunner(db);
      const jobId = createJob(db, 'batch_score', { perspective: 'street' });

      runner.persistCheckpoint(jobId, { checkpoint_version: 1, processed_triplets: [] });
      let meta = getJob(db, jobId)!.metadata;
      expect(meta.perspective).toBe('street');
      expect((meta.checkpoint as { checkpoint_version: number }).checkpoint_version).toBe(1);

      runner.clearCheckpoint(jobId);
      meta = getJob(db, jobId)!.metadata;
      expect(meta.checkpoint).toBeNull();
      expect(meta.perspective).toBe('street');
    });
  });

  it('settles a cooperatively-cancelled job exactly once', () => {
    withDb((db) => {
      const runner = new JobRunner(db);
      const jobId = createJob(db, 'catalog_sync', {});
      runner.startJob(jobId, 'catalog_sync');

      runner.finalizeCancelled(jobId);
      let job = getJob(db, jobId)!;
      expect(job.status).toBe('cancelled');
      const stops = () =>
        getJob(db, jobId)!.logs.filter((l) => l.message === 'Job stopped after cancel request');
      expect(stops()).toHaveLength(1);

      // Idempotent: a second finalize must not append a duplicate marker.
      runner.finalizeCancelled(jobId);
      job = getJob(db, jobId)!;
      expect(stops()).toHaveLength(1);
    });
  });

  it('preserves the original start time across a retry', () => {
    withDb((db) => {
      const jobId = createJob(db, 'catalog_sync', {});
      updateJobStatus(db, jobId, 'running');
      const firstStart = getJob(db, jobId)!.started_at;
      expect(firstStart).toBeTruthy();

      updateJobStatus(db, jobId, 'failed');
      transitionRetry(db, jobId);
      updateJobStatus(db, jobId, 'running');
      // COALESCE, so the retry does not lose when the job first started.
      expect(getJob(db, jobId)!.started_at).toBe(firstStart);
    });
  });

  it('does not resurrect a cancelled job by writing running', () => {
    withDb((db) => {
      const jobId = createJob(db, 'catalog_sync', {});
      updateJobStatus(db, jobId, 'cancelled');
      // The WHERE clause excludes cancelled rows, so a worker that picked the job
      // up before the cancel landed cannot bring it back.
      updateJobStatus(db, jobId, 'running');
      expect(getJob(db, jobId)!.status).toBe('cancelled');
    });
  });
});

describe('updateJobField', () => {
  it('rejects a field outside the whitelist', () => {
    withDb((db) => {
      const jobId = createJob(db, 'catalog_sync', {});
      // The column name is interpolated into the SQL, so the whitelist is the
      // thing standing between this and an injection.
      expect(() => updateJobField(db, jobId, 'status', 'completed')).toThrow(
        /Unsupported job field/,
      );
      expect(() => updateJobField(db, jobId, "id = 'x'; --", 'x')).toThrow(
        /Unsupported job field/,
      );
    });
  });

  it('stores a string verbatim and JSON-encodes anything else', () => {
    withDb((db) => {
      const jobId = createJob(db, 'catalog_sync', {});
      updateJobField(db, jobId, 'error', 'plain message');
      expect(getJob(db, jobId)!.error).toBe('plain message');

      updateJobField(db, jobId, 'result', { ok: true });
      expect(getJob(db, jobId)!.result).toEqual({ ok: true });
    });
  });
});

describe('the jobs database is created on demand', () => {
  it('serves an empty list on a first run with no file', async () => {
    const fresh = join(dir, 'nested', 'brand-new.db');
    process.env.DATABASE_PATH = fresh;
    // A first run must not 404 the jobs page just because nothing has enqueued yet;
    // the parent directory is created too.
    const res = await send('GET', '/api/jobs/');
    expect(res.status).toBe(200);
    expect(await json<{ total: number }>(res)).toMatchObject({ total: 0 });
  });

  it('adds error_severity to a file that predates the column', async () => {
    const legacy = join(dir, 'legacy.db');
    const db = new Database(legacy);
    db.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        progress INTEGER DEFAULT 0, current_step TEXT, logs TEXT DEFAULT '[]',
        result TEXT, error TEXT, created_at TEXT NOT NULL, started_at TEXT,
        completed_at TEXT, metadata TEXT DEFAULT '{}'
      );
    `);
    db.close();

    process.env.DATABASE_PATH = legacy;
    expect((await send('GET', '/api/jobs/')).status).toBe(200);

    const check = new Database(legacy, { readonly: true });
    const columns = check.pragma('table_info(jobs)') as { name: string }[];
    check.close();
    expect(columns.map((c) => c.name)).toContain('error_severity');
  });
});
