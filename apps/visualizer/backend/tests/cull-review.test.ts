/**
 * Cull review HTTP routes.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resolveCurrentStages } from '../src/cull/stages.js';
import { initLibraryDb } from '../src/db/library/bootstrap.js';
import { getCurrentPipelineSetting } from '../src/db/library/cull-pipeline.js';
import { upsertStageAnswer } from '../src/db/library/cull-stages.js';
import { getJob, initJobsDb } from '../src/db/jobs/jobs.js';
import { getCullVerdict, upsertCullVerdict, type CullVerdictInput } from '../src/db/library/cull-verdicts.js';
import { listCullUserActions, recordCullUserAction } from '../src/db/library/cull-user-actions.js';
import { computePromptVersion } from '../src/vision/scoring-service.js';
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

function seedFailingRecipeAnswers(fx: LibraryFixture, imageKey: string, levelIndex: number): void {
  const db = new Database(fx.dbPath);
  const pipe = getCurrentPipelineSetting(db);
  const stages = resolveCurrentStages(db, pipe.config, { base: 'laya-base', new: 'laya-new' });
  const stage = stages.find((s) => s.stageKey === 'culling_recipe:recipe-7h47:7');
  if (!stage) throw new Error('expected recipe 7 stage');
  const dims = ['immediate-impact', 'visual-structure', 'point-of-tension', 'connotation'] as const;
  const answers: Record<string, number[]> = {};
  for (const dim of dims) {
    const v = Array<number>(7).fill(0);
    v[Math.min(levelIndex, 6)] = 1;
    answers[`7|${dim}`] = v;
  }
  upsertStageAnswer(db, {
    imageKey,
    stageVersionId: stage.versionId,
    answers,
    verdict: 'cut',
    decision: {},
    pipelineSettingVersion: pipe.version,
    source: 'job',
    runId: 1,
  });
  db.close();
}

function markDescribeScoreComplete(fx: LibraryFixture, imageKey: string): void {
  const db = new Database(fx.dbPath);
  db.prepare(
    `INSERT INTO image_descriptions (image_key, image_type, summary, model_used, described_at)
     VALUES (?, 'catalog', 'done', 'test', datetime('now'))`,
  ).run(imageKey);
  const perspectives = db
    .prepare('SELECT slug, prompt_markdown FROM perspectives WHERE active = 1')
    .all() as { slug: string; prompt_markdown: string }[];
  db.close();
  for (const p of perspectives) {
    fx.addScores({
      image_key: imageKey,
      perspective_slug: p.slug,
      score: 7,
      prompt_version: computePromptVersion(p),
    });
  }
}

describe('GET /api/cull/summary', () => {
  it('counts sent-by-hand photos even after verdict becomes sent', async () => {
    seedVerdict(fx, cutBase('hand-count', 0.1, 'culling_recipe'));
    const db = new Database(fx.dbPath);
    recordCullUserAction(db, 'hand-count', 'sent_by_hand');
    db.close();
    const res = await app.request('/api/cull/summary');
    const body = await json<{ sent_manually_count: number }>(res);
    expect(body.sent_manually_count).toBeGreaterThan(0);
  });

  it('counts cut photos not sent by hand', async () => {
    const res = await app.request('/api/cull/summary');
    expect(res.status).toBe(200);
    const body = await json<{ not_passed_count: number; tab_counts: Record<string, number> }>(res);
    expect(body.not_passed_count).toBe(2);
    expect(body.tab_counts.all).toBe(2);
    expect(body.tab_counts.culling_recipe).toBe(1);
    expect(body.tab_counts.score_forecast).toBe(1);
  });
});

describe('GET /api/cull/photos/', () => {
  it('sorts by score forecast descending', async () => {
    const res = await app.request('/api/cull/photos/');
    const body = await json<{ data: { image_key: string }[] }>(res);
    expect(body.data[0]!.image_key).toBe('cut-a');
  });

  it('returns needs_send_work false when describe/score complete', async () => {
    markDescribeScoreComplete(fx, 'cut-a');
    const res = await app.request('/api/cull/photos/');
    const body = await json<{ data: { image_key: string; completion: string; needs_send_work: boolean }[] }>(res);
    const row = body.data.find((r) => r.image_key === 'cut-a');
    expect(row?.completion).toBe('all');
    expect(row?.needs_send_work).toBe(false);
  });

  it('marks failing-band recipe answers on dimension readout (F21)', async () => {
    seedFailingRecipeAnswers(fx, 'cut-a', 1);
    const res = await app.request('/api/cull/photos/');
    const body = await json<{
      data: { image_key: string; recipe: { level_sets: { dimensions: { slug: string; levels: { fails: boolean }[] }[] }[] } }[];
    }>(res);
    const row = body.data.find((r) => r.image_key === 'cut-a');
    const dim = row?.recipe.level_sets[0]?.dimensions.find((d) => d.slug === 'immediate-impact');
    expect(dim?.levels[0]?.fails).toBe(true);
  });
});

describe('GET /api/cull/photos/send', () => {
  it('is not treated as a photo detail key', async () => {
    const res = await app.request('/api/cull/photos/send');
    expect(res.status).not.toBe(200);
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

  it('skips already-complete keys without recording sent_by_hand', async () => {
    seedVerdict(fx, cutBase('cut-complete', 0.15, 'culling_recipe'));
    seedVerdict(fx, cutBase('cut-needs-work', 0.12, 'culling_recipe'));
    markDescribeScoreComplete(fx, 'cut-complete');

    const res = await app.request('/api/cull/photos/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image_keys: ['cut-complete', 'cut-needs-work'] }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ sent_by_hand: string[]; skipped_complete: number; job_id: string | null }>(res);
    expect(body.sent_by_hand).toEqual(['cut-needs-work']);
    expect(body.skipped_complete).toBe(1);
    expect(body.job_id).toBeTruthy();

    const lib = new Database(fx.dbPath);
    expect(getCullVerdict(lib, 'cut-complete')!.verdict).toBe('cut');
    expect(getCullVerdict(lib, 'cut-needs-work')!.verdict).toBe('sent');
    lib.close();
  });
});

describe('POST /api/cull/photos/{image_key}/actions', () => {
  it('stores answered_verdict on agrees_with_cut', async () => {
    const res = await app.request('/api/cull/photos/cut-a/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'agrees_with_cut' }),
    });
    expect(res.status).toBe(200);
    const db = new Database(fx.dbPath);
    expect(listCullUserActions(db, 'cut-a').at(-1)).toMatchObject({
      action: 'agrees_with_cut',
      answered_verdict: 'cut',
    });
    db.close();
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
