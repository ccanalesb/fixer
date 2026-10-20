/**
 * Cull review HTTP routes.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { initLibraryDb } from '../src/db/library/bootstrap.js';
import { getJob, initJobsDb } from '../src/db/jobs/jobs.js';
import { upsertCullVerdict, type CullVerdictInput } from '../src/db/library/cull-verdicts.js';
import { LibraryFixture } from './helpers/library-fixture.js';

let fx: LibraryFixture;
let jobsDir: string;
let jobsDbPath: string;
const app = createApp();

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

function seedVerdict(fx: LibraryFixture, v: CullVerdictInput): void {
  const db = new Database(fx.dbPath);
  upsertCullVerdict(db, v);
  db.close();
}

const cutBase = (imageKey: string, p8: number | null, cutBy: 'culling_recipe' | 'score_forecast'): CullVerdictInput => ({
  imageKey,
  verdict: 'cut',
  cutBy,
  cutByStageKey: cutBy === 'score_forecast' ? 'score_forecast' : 'culling_recipe:recipe-7h47:7',
  sentByHand: false,
  pendingStages: [],
  pendingReason: '',
  scoreForecastOff: false,
  scoreForecastP8: p8,
  pipelineSettingVersion: 1,
  stageVersionIds: [],
  runId: null,
});

beforeEach(() => {
  jobsDir = mkdtempSync(join(tmpdir(), 'lt-cull-review-jobs-'));
  jobsDbPath = join(jobsDir, 'visualizer.db');
  process.env.DATABASE_PATH = jobsDbPath;
  fx = new LibraryFixture().activate();
  initLibraryDb(fx.dbPath);
  fx.addImages('cut-a', 'sent-b', 'cut-send', 'cut-low');
  seedVerdict(fx, cutBase('cut-a', 0.25, 'culling_recipe'));
  seedVerdict(fx, {
    imageKey: 'sent-b',
    verdict: 'sent',
    cutBy: null,
    cutByStageKey: null,
    sentByHand: false,
    pendingStages: [],
    pendingReason: '',
    scoreForecastOff: false,
    scoreForecastP8: null,
    pipelineSettingVersion: 1,
    stageVersionIds: [],
    runId: null,
  });
  seedVerdict(fx, cutBase('cut-low', 0.05, 'score_forecast'));
});

afterEach(() => {
  delete process.env.DATABASE_PATH;
  fx.cleanup();
  rmSync(jobsDir, { recursive: true, force: true });
});

describe('GET /api/cull/summary', () => {
  it('counts cut photos not sent by hand', async () => {
    const res = await app.request('/api/cull/summary');
    expect(res.status).toBe(200);
    const body = await json<{ not_passed_count: number }>(res);
    expect(body.not_passed_count).toBe(2);
  });
});

describe('GET /api/cull/photos/', () => {
  it('sorts by score forecast descending', async () => {
    const res = await app.request('/api/cull/photos/');
    const body = await json<{ data: { image_key: string }[] }>(res);
    expect(body.data[0]!.image_key).toBe('cut-a');
  });
});

describe('POST /api/cull/photos/send', () => {
  it('enqueues batch_analyze with image_keys', async () => {
    seedVerdict(fx, cutBase('cut-send', 0.1, 'culling_recipe'));

    const res = await app.request('/api/cull/photos/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image_keys: ['cut-send'] }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ job_id: string | null }>(res);
    expect(body.job_id).toBeTruthy();
    const jobsDb = initJobsDb(jobsDbPath);
    const job = getJob(jobsDb, body.job_id!);
    jobsDb.close();
    expect(job!.type).toBe('batch_analyze');
    expect((job!.metadata as { image_keys: string[] }).image_keys).toContain('cut-send');
  });
});

describe('GET /api/cull/photos/{image_key}', () => {
  it('returns detail for sent photos on the cull catalog', async () => {
    const res = await app.request('/api/cull/photos/sent-b');
    expect(res.status).toBe(200);
    const body = await json<{ verdict: string }>(res);
    expect(body.verdict).toBe('sent');
  });
});

describe('cull catalog filter', () => {
  it('includes sent verdict, excludes cut', async () => {
    const res = await app.request('/api/images/catalog/?cull_catalog=true');
    expect(res.status).toBe(200);
    const body = await json<{ images: { key: string }[] }>(res);
    const keys = body.images.map((i) => i.key);
    expect(keys).toContain('sent-b');
    expect(keys).not.toContain('cut-a');
  });
});
