/**
 * Lightroom write-back job, settings PATCH, and POST /write.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { createApp } from '../src/app.js';
import { openLibraryDb } from '../src/db/connection.js';
import { getLrWritebackSettings, patchLrWritebackSettings } from '../src/db/library/lr-writeback-settings.js';
import { createJob, getJob, getPendingJobs, initJobsDb } from '../src/db/jobs/jobs.js';
import {
  LR_WRITEBACK_JOB_TYPE,
  enqueueLrWritebackWrite,
  handleLrWriteback,
  maybeEnqueueLrWriteback,
} from '../src/jobs/handlers/lr-writeback.js';
import { JobRunner } from '../src/jobs/runner.js';
import { tick } from '../src/jobs/processor.js';
import { upsertCullVerdict } from '../src/db/library/cull-verdicts.js';
import { seedCullingDefaults } from '../src/db/library/cull-profiles.js';
import { connectCatalog } from '../src/lightroom/writer.js';
import { LibraryFixture } from './helpers/library-fixture.js';
import { makeFakeCatalog } from './helpers/fake-catalog.js';

const app = createApp();
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

let fx: LibraryFixture;
let dir: string;
let cfgPath: string;
let lrcatPath: string;
let jobsDbPath: string;

beforeEach(() => {
  fx = new LibraryFixture().addImage({ key: '2024-06-01_filtered-photo', id: '1' }).activate();
  dir = mkdtempSync(join(tmpdir(), 'lt-lrw-switch-'));
  cfgPath = join(dir, 'config.yaml');
  lrcatPath = join(dir, 'Test.lrcat');
  jobsDbPath = join(dir, 'visualizer.db');
  process.env.LT_CONFIG_YAML = cfgPath;
  process.env.DATABASE_PATH = jobsDbPath;
  writeFileSync(cfgPath, stringifyYaml({ workers: 4, catalog_path: lrcatPath }));
  makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'x', pick: 0 }]);
  const db = openLibraryDb(fx.dbPath);
  seedCullingDefaults(db);
  db.close();
});

afterEach(() => {
  fx.cleanup();
  delete process.env.LT_CONFIG_YAML;
  delete process.env.DATABASE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe('PATCH /api/cull/lightroom-writeback/settings', () => {
  it('only saves settings when turning write_reject on (no job)', async () => {
    const res = await app.request('/api/cull/lightroom-writeback/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ write_reject: true }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ write_reject: boolean }>(res);
    expect(body.write_reject).toBe(true);
    const jobsDb = initJobsDb(jobsDbPath);
    const pending = getPendingJobs(jobsDb).filter((j) => j.type === LR_WRITEBACK_JOB_TYPE);
    jobsDb.close();
    expect(pending).toHaveLength(0);
  });

  it('allows switch-on when catalog is locked', async () => {
    writeFileSync(join(dir, 'Test.lrcat-lock'), '');
    const res = await app.request('/api/cull/lightroom-writeback/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ write_stars: true }),
    });
    expect(res.status).toBe(200);
    const db = openLibraryDb(fx.dbPath);
    expect(getLrWritebackSettings(db).write_stars).toBe(true);
    db.close();
  });

  it('PATCH off cancels a running write-back job', async () => {
    const jobsDb = initJobsDb(jobsDbPath);
    const jobId = createJob(jobsDb, LR_WRITEBACK_JOB_TYPE, {});
    jobsDb.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
    jobsDb.close();
    const db = openLibraryDb(fx.dbPath);
    patchLrWritebackSettings(db, { write_reject: true });
    db.close();

    const res = await app.request('/api/cull/lightroom-writeback/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ write_reject: false }),
    });
    expect(res.status).toBe(200);
    const after = initJobsDb(jobsDbPath);
    expect(getJob(after, jobId)!.status).toBe('cancelled');
    after.close();
  });
});

describe('POST /api/cull/lightroom-writeback/write', () => {
  it('enqueues one job and returns job_id', async () => {
    const db = openLibraryDb(fx.dbPath);
    patchLrWritebackSettings(db, { write_reject: true });
    db.close();

    const res = await app.request('/api/cull/lightroom-writeback/write', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await json<{ job_id: string }>(res);
    expect(body.job_id).toBeTruthy();
    const jobsDb = initJobsDb(jobsDbPath);
    const pending = getPendingJobs(jobsDb).filter((j) => j.type === LR_WRITEBACK_JOB_TYPE);
    jobsDb.close();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(body.job_id);
  });

  it('returns the same job_id when one is already pending', async () => {
    const db = openLibraryDb(fx.dbPath);
    patchLrWritebackSettings(db, { write_stars: true });
    db.close();
    const first = await app.request('/api/cull/lightroom-writeback/write', { method: 'POST' });
    const firstBody = await json<{ job_id: string }>(first);
    const second = await app.request('/api/cull/lightroom-writeback/write', { method: 'POST' });
    const secondBody = await json<{ job_id: string }>(second);
    expect(secondBody.job_id).toBe(firstBody.job_id);
    const jobsDb = initJobsDb(jobsDbPath);
    const pending = getPendingJobs(jobsDb).filter((j) => j.type === LR_WRITEBACK_JOB_TYPE);
    jobsDb.close();
    expect(pending).toHaveLength(1);
  });
});

describe('lr_writeback handler', () => {
  it('honours cancel mid-run', async () => {
    const db = openLibraryDb(fx.dbPath);
    patchLrWritebackSettings(db, { write_reject: true });
    db.close();

    const jobsDb = initJobsDb(jobsDbPath);
    const jobId = createJob(jobsDb, LR_WRITEBACK_JOB_TYPE, {});
    const runner = new JobRunner(jobsDb);
    runner.startJob(jobId, LR_WRITEBACK_JOB_TYPE);
    runner.signalCancel(jobId);
    await handleLrWriteback(runner, jobId, {});
    expect(getJob(jobsDb, jobId)!.status).toBe('cancelled');
    jobsDb.close();
  });

  it('writes reject to fixture catalog when run', async () => {
    const imageKey = '2024-06-01_filtered-photo';
    try {
      unlinkSync(lrcatPath);
    } catch {
      /* fresh */
    }
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'filtered-photo', pick: 0, rating: null }]);
    const db = openLibraryDb(fx.dbPath);
    upsertCullVerdict(db, {
      imageKey,
      verdict: 'filtered',
      filteredBy: 'culling_profile',
      filteredByStageKey: 'culling_profile:default:7',
      cullingProfileVerdict: 'filtered',
      sentByHand: false,
      pendingStages: [],
      pendingReason: '',
      scoreForecastOff: false,
      scoreForecastP8: null,
      pipelineSettingVersion: 1,
      stageVersionIds: [],
      runId: null,
    });
    patchLrWritebackSettings(db, { write_reject: true });
    db.close();
    await runWritebackJob();
    const conn = connectCatalog(lrcatPath);
    const live = conn
      .prepare(
        `SELECT ai.pick FROM Adobe_images ai JOIN AgLibraryFile f ON f.id_local = ai.rootFile WHERE f.baseName = 'filtered-photo'`,
      )
      .get() as { pick: number };
    conn.close();
    expect(Number(live.pick)).toBe(-1);
  });

  async function runWritebackJob(): Promise<void> {
    const jobsDb = initJobsDb(jobsDbPath);
    const jobId = createJob(jobsDb, LR_WRITEBACK_JOB_TYPE, {});
    await tick(jobsDb, new JobRunner(jobsDb));
    expect(getJob(jobsDb, jobId)!.status).toBe('completed');
    jobsDb.close();
  }

  it('dedupes via enqueue helper', () => {
    const jobsDb = initJobsDb(jobsDbPath);
    const a = enqueueLrWritebackWrite(jobsDb);
    const b = enqueueLrWritebackWrite(jobsDb);
    expect(a).toBeTruthy();
    expect(b).toBe(a);
    jobsDb.close();
  });

  it('maybeEnqueue skips when a full run is already pending', () => {
    const jobsDb = initJobsDb(jobsDbPath);
    createJob(jobsDb, LR_WRITEBACK_JOB_TYPE, {});
    expect(maybeEnqueueLrWriteback(jobsDb)).toBeNull();
    expect(maybeEnqueueLrWriteback(jobsDb, { imageKeys: ['a'] })).toBeNull();
    jobsDb.close();
  });

  it('maybeEnqueue enqueues full run when only a keyed run is pending', () => {
    const jobsDb = initJobsDb(jobsDbPath);
    createJob(jobsDb, LR_WRITEBACK_JOB_TYPE, { image_keys: ['only-one'] });
    const id = maybeEnqueueLrWriteback(jobsDb);
    expect(id).toBeTruthy();
    const pending = getPendingJobs(jobsDb).filter((j) => j.type === LR_WRITEBACK_JOB_TYPE);
    expect(pending).toHaveLength(2);
    jobsDb.close();
  });
});
