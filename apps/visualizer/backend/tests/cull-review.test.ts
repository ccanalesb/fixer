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
import { layaNewForecastQuestions, saveForecastQuestions } from '../src/db/library/score-forecast-questions.js';
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

const filteredBase = (imageKey: string, p8: number | null, filteredBy: 'culling_profile' | 'score_forecast'): CullVerdictInput => ({
  imageKey,
  verdict: 'filtered',
  filteredBy,
  filteredByStageKey: filteredBy === 'score_forecast' ? 'score_forecast' : 'culling_profile:recipe-culling:7',
  cullingProfileVerdict: filteredBy === 'culling_profile' ? 'filtered' : null,
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
  fx.addImages('filtered-a', 'passed-b', 'filtered-send', 'filtered-low');
  seedVerdict(fx, filteredBase('filtered-a', 0.25, 'culling_profile'));
  seedVerdict(fx, {
    imageKey: 'passed-b',
    verdict: 'passed',
    filteredBy: null,
    filteredByStageKey: null,
    cullingProfileVerdict: null,
    sentByHand: false,
    pendingStages: [],
    pendingReason: '',
    scoreForecastOff: false,
    scoreForecastP8: null,
    pipelineSettingVersion: 1,
    stageVersionIds: [],
    runId: null,
  });
  seedVerdict(fx, filteredBase('filtered-low', 0.05, 'score_forecast'));
});

afterEach(() => {
  delete process.env.DATABASE_PATH;
  fx.cleanup();
  rmSync(jobsDir, { recursive: true, force: true });
});

function seedFailingProfileAnswers(fx: LibraryFixture, imageKey: string, levelIndex: number): void {
  const db = new Database(fx.dbPath);
  const pipe = getCurrentPipelineSetting(db);
  const stages = resolveCurrentStages(db, pipe.config, { culling_profile: 'laya-base', score_forecast: 'laya-new' });
  const stage = stages.find((s) => s.stageKey === 'culling_profile:recipe-culling:7');
  if (!stage) throw new Error('expected profile 7 stage');
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
    verdict: 'filtered',
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
  it('counts sent-by-hand photos even after verdict becomes passed', async () => {
    seedVerdict(fx, filteredBase('hand-count', 0.1, 'culling_profile'));
    const db = new Database(fx.dbPath);
    recordCullUserAction(db, 'hand-count', 'sent_by_hand');
    db.close();
    const res = await app.request('/api/cull/summary');
    const body = await json<{ sent_manually_count: number }>(res);
    expect(body.sent_manually_count).toBeGreaterThan(0);
  });

  it('counts filtered photos not sent by hand', async () => {
    const res = await app.request('/api/cull/summary');
    expect(res.status).toBe(200);
    const body = await json<{ not_passed_count: number; tab_counts: Record<string, number> }>(res);
    expect(body.not_passed_count).toBe(2);
    expect(body.tab_counts.all).toBe(2);
    expect(body.tab_counts.culling_profile).toBe(1);
    expect(body.tab_counts.score_forecast).toBe(1);
  });
});

describe('GET /api/cull/photos/', () => {
  it('sorts by score forecast descending', async () => {
    const res = await app.request('/api/cull/photos/');
    const body = await json<{ data: { image_key: string }[] }>(res);
    expect(body.data[0]!.image_key).toBe('filtered-a');
  });

  it('returns needs_send_work false when describe/score complete', async () => {
    markDescribeScoreComplete(fx, 'filtered-a');
    const res = await app.request('/api/cull/photos/');
    const body = await json<{ data: { image_key: string; completion: string; needs_send_work: boolean }[] }>(res);
    const row = body.data.find((r) => r.image_key === 'filtered-a');
    expect(row?.completion).toBe('all');
    expect(row?.needs_send_work).toBe(false);
  });

  it('marks failing-band profile answers on dimension readout (F21)', async () => {
    seedFailingProfileAnswers(fx, 'filtered-a', 1);
    const res = await app.request('/api/cull/photos/');
    const body = await json<{
      data: { image_key: string; profile: { level_sets: { dimensions: { slug: string; levels: { fails: boolean }[] }[] }[] } }[];
    }>(res);
    const row = body.data.find((r) => r.image_key === 'filtered-a');
    const dim = row?.profile.level_sets[0]?.dimensions.find((d) => d.slug === 'immediate-impact');
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
    seedVerdict(fx, filteredBase('filtered-send', 0.1, 'culling_profile'));

    const res = await app.request('/api/cull/photos/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image_keys: ['filtered-send'] }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ job_id: string | null }>(res);
    expect(body.job_id).toBeTruthy();
    const jobsDb = initJobsDb(jobsDbPath);
    const job = getJob(jobsDb, body.job_id!);
    jobsDb.close();
    expect(job!.type).toBe('batch_analyze');
    expect((job!.metadata as { image_keys: string[] }).image_keys).toContain('filtered-send');
  });

  it('skips already-complete keys without recording sent_by_hand', async () => {
    seedVerdict(fx, filteredBase('filtered-complete', 0.15, 'culling_profile'));
    seedVerdict(fx, filteredBase('filtered-needs-work', 0.12, 'culling_profile'));
    markDescribeScoreComplete(fx, 'filtered-complete');

    const res = await app.request('/api/cull/photos/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image_keys: ['filtered-complete', 'filtered-needs-work'] }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ sent_by_hand: string[]; skipped_complete: number; job_id: string | null }>(res);
    expect(body.sent_by_hand).toEqual(['filtered-needs-work']);
    expect(body.skipped_complete).toBe(1);
    expect(body.job_id).toBeTruthy();

    const lib = new Database(fx.dbPath);
    expect(getCullVerdict(lib, 'filtered-complete')!.verdict).toBe('filtered');
    expect(getCullVerdict(lib, 'filtered-needs-work')!.verdict).toBe('passed');
    lib.close();
  });
});

describe('POST /api/cull/photos/{image_key}/actions', () => {
  it('stores answered_verdict on agrees_with_filter', async () => {
    const res = await app.request('/api/cull/photos/filtered-a/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'agrees_with_filter' }),
    });
    expect(res.status).toBe(200);
    const db = new Database(fx.dbPath);
    expect(listCullUserActions(db, 'filtered-a').at(-1)).toMatchObject({
      action: 'agrees_with_filter',
      answered_verdict: 'filtered',
    });
    db.close();
  });
});

describe('DELETE /api/cull/photos/{image_key}/actions/{action}', () => {
  it('withdraws should_have_been_filtered and leaves other actions', async () => {
    const db = new Database(fx.dbPath);
    recordCullUserAction(db, 'passed-b', 'should_have_been_filtered');
    recordCullUserAction(db, 'passed-b', 'should_have_been_filtered');
    recordCullUserAction(db, 'filtered-a', 'should_have_been_filtered');
    db.close();

    const res = await app.request('/api/cull/photos/passed-b/actions/should_have_been_filtered', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: 2 });

    const after = new Database(fx.dbPath);
    expect(listCullUserActions(after, 'passed-b').filter((a) => a.action === 'should_have_been_filtered')).toEqual([]);
    expect(listCullUserActions(after, 'filtered-a').map((a) => a.action)).toContain('should_have_been_filtered');
    after.close();
  });

  it('refuses to withdraw other actions', async () => {
    const res = await app.request('/api/cull/photos/passed-b/actions/sent_by_hand', { method: 'DELETE' });
    expect(res.status).toBe(422);
  });
});

describe('GET /api/cull/photos/{image_key}', () => {
  it('returns detail for passed photos on the cull catalog', async () => {
    const res = await app.request('/api/cull/photos/passed-b');
    expect(res.status).toBe(200);
    const body = await json<{ verdict: string }>(res);
    expect(body.verdict).toBe('passed');
  });

  it("lists the Score forecast per question, named by its perspective, an excused one as not applying", async () => {
    const db = new Database(fx.dbPath);
    saveForecastQuestions(db, [
      ...layaNewForecastQuestions(db).filter((q) => q.id === 'framing' || q.id === 'compositional-cleanliness'),
      {
        id: 'own',
        name: 'My own question',
        perspective_slug: null,
        instructions: 'Is it good?',
        levels: Array.from({ length: 10 }, (_, i) => `level ${i + 1}`),
        optional: false,
        applies: null,
      },
    ]);
    const pipe = getCurrentPipelineSetting(db);
    const stage = resolveCurrentStages(db, pipe.config, { culling_profile: 'laya-base', score_forecast: 'laya-new' }).find(
      (s) => s.kind === 'score_forecast',
    )!;
    const tenth = (i: number) => Array.from({ length: 10 }, (_, k) => (k === i ? 1 : 0));
    upsertStageAnswer(db, {
      imageKey: 'filtered-low',
      stageVersionId: stage.versionId,
      answers: { 'framing-excusal': [0.9, 0.1], framing: tenth(9), 'compositional-cleanliness': tenth(8), own: tenth(2) },
      verdict: 'filtered',
      decision: {},
      pipelineSettingVersion: pipe.version,
      source: 'job',
      runId: 1,
    });
    db.close();
    const body = await json<{ score_forecast: unknown[] }>(await app.request('/api/cull/photos/filtered-low'));
    expect(body.score_forecast).toEqual([
      { name: 'Framing', p8: null, excused: true },
      { name: 'Compositional-Cleanliness', p8: 1, excused: false },
      { name: 'My own question', p8: 0, excused: false },
    ]);
  });
});

describe('cull catalog filter', () => {
  it('includes passed verdict, excludes filtered', async () => {
    const res = await app.request('/api/images/catalog/?cull_catalog=true');
    expect(res.status).toBe(200);
    const body = await json<{ images: { key: string }[] }>(res);
    const keys = body.images.map((i) => i.key);
    expect(keys).toContain('passed-b');
    expect(keys).not.toContain('filtered-a');
  });
});

describe('the culling verdict in the API contract', () => {
  it('is one of filtered, passed or pending', async () => {
    const doc = await json<{ components: { schemas: Record<string, { properties: Record<string, { enum?: string[] }> }> } }>(
      await app.request('/apidoc/openapi.json'),
    );
    expect(doc.components.schemas['CullReviewDetail']!.properties['verdict']!.enum).toEqual(['filtered', 'passed', 'pending']);
  });
});
