/**
 * `batch_cull_photos_before_scoring` through the processor. Laya's runtime is faked — no model is ever
 * loaded here — but the model files' presence check, model ids, library.db, the vision cache and the
 * JPEGs are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { LibraryFixture } from './helpers/library-fixture.js';
import { createJob, getJob, initJobsDb } from '../src/db/jobs/jobs.js';
import type { Db } from '../src/db/connection.js';
import { openLibraryDb } from '../src/db/connection.js';
import { JobRunner } from '../src/jobs/runner.js';
import { tick } from '../src/jobs/processor.js';
import { JOB_TYPES_BY_NAME } from '../src/jobs/registry.js';
import { LazyLaya } from '../src/cull/lazy-laya.js';
import { LAYA_SETUP_COMMAND, LayaSetupError } from '../src/laya/files.js';
import { getCurrentPipelineSetting, createPipelineSettingVersion } from '../src/db/library/cull-pipeline.js';
import { recordCullUserAction } from '../src/db/library/cull-user-actions.js';
import { seedCullingDefaults } from '../src/db/library/cull-recipes.js';
import type { LayaAnswerWant } from '../src/laya/sessions.js';
import { importResearchRuns } from '../src/cull/import-research.js';
import { LAYA_BASE_RESEARCH_MODEL_ID, layaNewModelId } from '../src/laya/model-id.js';
import { computePromptVersion } from '../src/vision/scoring-service.js';
import { getPerspectiveBySlug } from '../src/db/library/scores.js';

/** Per photo file: the recipe levels (impact, structure, tension, connotation) and the highest P(≥ 8). */
interface Script {
  levels: [number, number, number, number];
  p8: number;
}

const laya = vi.hoisted(() => ({
  scripts: new Map<string, Script>(),
  calls: [] as { file: string; want: LayaAnswerWant | undefined }[],
  starts: 0,
  closed: 0,
  forecastOn: true,
  failOn: null as null | string,
  /** The worker dies on this photo: the answer is rejected and every later one fails too. */
  dieOn: null as null | string,
  broken: false,
  startError: null as null | Error,
  cancelAfter: null as null | (() => void),
}));

vi.mock('../src/laya/runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/laya/runtime.js')>();
  const at = (level: number, n: number) => Array.from({ length: n }, (_, i) => (i === level - 1 ? 1 : 0));
  /** Level `l` of 10 lands on 7 levels at the same position on the scale, as the research maps them. */
  const on7 = (l: number) => Math.round(1 + ((l - 1) * 6) / 9);
  const runtime = {
    get scoreForecastOn() {
      return laya.forecastOn;
    },
    get broken() {
      return laya.broken;
    },
    async answer(file: string, want?: LayaAnswerWant) {
      laya.calls.push({ file, want });
      if (laya.broken) throw new Error('Laya worker exited (code 1)');
      if (laya.dieOn && file.endsWith(`/${laya.dieOn}.jpg`)) {
        laya.broken = true;
        throw new Error('Laya worker exited (code 1)');
      }
      if (laya.failOn && file.endsWith(`/${laya.failOn}.jpg`)) throw new Error('decode failed');
      const s = [...laya.scripts.entries()].find(([k]) => file.endsWith(`/${k}.jpg`))?.[1] ?? { levels: [5, 5, 5, 5], p8: 0.5 };
      const dims = ['immediate-impact', 'visual-structure', 'point-of-tension', 'connotation'];
      const base: Record<string, number[]> = {};
      for (const qid of want?.base ?? []) {
        const [, rest] = qid.split('#');
        const [set, dim] = rest!.split('|');
        const l = s.levels[dims.indexOf(dim!)]!;
        base[qid] = set === '7' ? at(on7(l), 7) : at(l, 10);
      }
      const neu = want?.new && laya.forecastOn
        ? {
            'framing-excusal': [0.9, 0.1],
            framing: [0, 0, 0, 0, 0, 0, 0, 0.99, 0, 0],
            'intensity-suggestion': [1 - s.p8, 0, 0, 0, 0, 0, 0, s.p8, 0, 0],
          }
        : null;
      laya.cancelAfter?.();
      return { answers: { base, new: neu }, seconds: { prep: 0.1, vision: 0.2, base: 0.3, new: 0.4, total: 1 } };
    },
    async close() {
      laya.closed += 1;
    },
  };
  return {
    ...actual,
    startLayaWithCheck: async () => {
      laya.starts += 1;
      if (laya.startError) throw laya.startError;
      return { runtime, loadSeconds: 0.5, testPhoto: { answers: { base: {}, new: null }, seconds: {} } };
    },
  };
});

let fx: LibraryFixture;
let dir: string;
let jobsDbPath: string;
let modelsDir: string;

async function withJobsDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const db = initJobsDb(jobsDbPath);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

async function runCull(metadata: Record<string, unknown> = {}, before?: (db: Db, jobId: string) => void) {
  return withJobsDb(async (db) => {
    const jobId = createJob(db, 'batch_cull_photos_before_scoring', metadata);
    before?.(db, jobId);
    await tick(db, new JobRunner(db));
    return getJob(db, jobId)!;
  });
}

function writeModels(withNew: boolean): void {
  const base = join(modelsDir, 'laya-base');
  for (const d of ['tokenizer', 'reference']) mkdirSync(join(base, d), { recursive: true });
  for (const f of ['vision.onnx', 'decoder.onnx', 'tokenizer/tokenizer.json', 'tokenizer/tokenizer_config.json', 'reference/photo.png']) {
    writeFileSync(join(base, f), '');
  }
  writeFileSync(join(base, 'model.json'), JSON.stringify({ source: 'thaitea/laya-vision', revision: '8b318c99d7ad3ce19c24369263463882eada9d1e' }));
  if (!withNew) return;
  const neu = join(modelsDir, 'laya-new');
  mkdirSync(join(neu, 'tokenizer'), { recursive: true });
  for (const f of ['decoder.onnx', 'tokenizer/tokenizer.json', 'tokenizer/tokenizer_config.json']) writeFileSync(join(neu, f), 'x');
  writeFileSync(join(neu, 'model.json'), JSON.stringify({ source: '/somewhere/best', revision: null }));
}

/** A catalog photo whose original is gone and whose vision-cache JPEG exists. */
async function addPhoto(key: string, script?: Script): Promise<void> {
  const path = join(dir, 'vision', `${key}.jpg`);
  mkdirSync(join(dir, 'vision'), { recursive: true });
  await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toFile(path);
  fx.addImage({ key, filepath: `/missing/${key}.NEF`, date_taken: '2024-01-01' }).addVisionCache(key, path);
  if (script) laya.scripts.set(key, script);
}

const verdicts = () =>
  fx.query<{ image_key: string; verdict: string; cut_by: string | null; pending_reason: string; pipeline_setting_version: number }>(
    'SELECT image_key, verdict, cut_by, pending_reason, pipeline_setting_version FROM cull_verdicts ORDER BY image_key',
  );
const result = (job: { result: unknown }) => job.result as Record<string, unknown>;
const logs = (job: { logs: { message: string }[] }) => job.logs.map((l) => l.message);

const PASS: Script = { levels: [5, 5, 6, 6], p8: 0.5 };
const RECIPE_CUT: Script = { levels: [5, 5, 2, 3], p8: 0.5 };
const FORECAST_CUT: Script = { levels: [5, 5, 6, 6], p8: 0.05 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-cull-job-'));
  jobsDbPath = join(dir, 'visualizer.db');
  modelsDir = join(dir, 'models');
  fx = new LibraryFixture().activate();
  Object.assign(laya, {
    calls: [],
    starts: 0,
    closed: 0,
    forecastOn: true,
    failOn: null,
    dieOn: null,
    broken: false,
    startError: null,
    cancelAfter: null,
  });
  laya.scripts.clear();
  process.env.DATABASE_PATH = jobsDbPath;
  writeFileSync(join(dir, 'config.yaml'), `vision_cache_dir: ${join(dir, 'vision')}\nlaya_models_dir: ${modelsDir}\n`);
  process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
  writeModels(true);
});

afterEach(() => {
  delete process.env.DATABASE_PATH;
  delete process.env.LT_CONFIG_YAML;
  fx.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe('batch_cull_photos_before_scoring', () => {
  it('is registered as a catalog job with its checkpoint message', () => {
    expect(JOB_TYPES_BY_NAME.get('batch_cull_photos_before_scoring')).toMatchObject({ requiresCatalog: true });
  });

  it('answers every stage, stores every level probability and decides each photo', async () => {
    await addPhoto('a', PASS);
    await addPhoto('b', RECIPE_CUT);
    await addPhoto('c', FORECAST_CUT);
    const job = await runCull();
    expect(job.status).toBe('completed');
    expect(laya.calls).toHaveLength(3);
    expect(laya.calls[0]!.want).toMatchObject({ new: true });
    expect(laya.calls[0]!.want!.base).toHaveLength(8);
    expect(verdicts()).toEqual([
      { image_key: 'a', verdict: 'sent', cut_by: null, pending_reason: '', pipeline_setting_version: 1 },
      { image_key: 'b', verdict: 'cut', cut_by: 'culling_recipe', pending_reason: '', pipeline_setting_version: 1 },
      { image_key: 'c', verdict: 'cut', cut_by: 'score_forecast', pending_reason: '', pipeline_setting_version: 1 },
    ]);
    const rows = fx.query<{ image_key: string; stage_key: string; verdict: string; answers_json: string; source: string }>(
      `SELECT a.image_key, v.stage_key, a.verdict, a.answers_json, a.source FROM cull_stage_answers a
       JOIN cull_stage_versions v ON v.id = a.stage_version_id WHERE a.image_key = 'b' ORDER BY v.stage_key`,
    );
    expect(rows.map((r) => [r.stage_key, r.verdict])).toEqual([
      ['culling_recipe:recipe-7h47:10', 'cut'],
      ['culling_recipe:recipe-7h47:7', 'cut'],
      ['score_forecast', 'sent'],
    ]);
    expect(JSON.parse(rows[0]!.answers_json)['connotation']).toHaveLength(10);
    expect(JSON.parse(rows[1]!.answers_json)['connotation']).toHaveLength(7);
    expect(rows.every((r) => r.source === 'job')).toBe(true);
    expect(result(job)).toMatchObject({
      total: 3,
      culled: 3,
      failed: 0,
      cut_by_culling_recipe: 1,
      cut_by_score_forecast: 1,
      pending: 0,
      sent: 1,
      sent_by_hand_passed: 0,
      score_forecast: 'on',
      pipeline_setting_version: 1,
    });
    expect(result(job).durations_s).toEqual(
      expect.objectContaining({ start_check: expect.any(Number), select: expect.any(Number), cull: expect.any(Number) }),
    );
    expect(result(job).laya_seconds).toEqual({ prep: 0.3, vision: 0.6, base: 0.9, new: 1.2 });
    expect(logs(job).some((m) => m.startsWith('[cull] status=complete photos=3 culled=3'))).toBe(true);
    expect(fx.query('SELECT kind, job_id IS NOT NULL AS has_job, finished_at IS NOT NULL AS finished FROM cull_runs')).toEqual([
      { kind: 'job', has_job: 1, finished: 1 },
    ]);
    expect(laya.closed).toBe(1);
  });

  it('asks only what is missing, and nothing for photos already decided', async () => {
    await addPhoto('a', PASS);
    await runCull();
    laya.calls = [];
    const again = await runCull();
    expect(laya.calls).toEqual([]);
    expect(result(again)).toMatchObject({ culled: 0, redecided: 0 });

    fx.exec(
      `DELETE FROM cull_stage_answers WHERE stage_version_id =
         (SELECT id FROM cull_stage_versions WHERE stage_key = 'culling_recipe:recipe-7h47:7')`,
    );
    await runCull();
    expect(laya.calls).toHaveLength(1);
    expect(laya.calls[0]!.want!.base).toHaveLength(4);
    expect(laya.calls[0]!.want!.base!.every((q) => q.startsWith('culling_recipe:recipe-7h47:7#7|'))).toBe(true);
    expect(laya.calls[0]!.want!.new).toBe(false);
  });

  it('a new pipeline-setting version re-decides from stored answers, no model call', async () => {
    await addPhoto('c', FORECAST_CUT);
    await runCull();
    laya.calls = [];
    const db = openLibraryDb(fx.dbPath);
    const cfg = getCurrentPipelineSetting(db).config;
    createPipelineSettingVersion(db, { ...cfg, score_forecast: { ...cfg.score_forecast, threshold: 0.01 } });
    db.close();
    const job = await runCull();
    expect(laya.calls).toEqual([]);
    expect(result(job)).toMatchObject({ redecided: 1, sent: 1 });
    expect(verdicts()[0]).toMatchObject({ verdict: 'sent', pipeline_setting_version: 2 });
  });

  it('skips void frames unless overridden, and videos', async () => {
    await addPhoto('void', PASS);
    await addPhoto('void-ok', PASS);
    await addPhoto('ill', PASS);
    fx.addFrameSubstance('void', 'void').addFrameSubstance('void-ok', 'void').addFrameSubstance('ill', 'illegible');
    fx.addFrameSubstanceOverride('void-ok');
    fx.addImage({ key: 'movie', filepath: '/x/movie.mov' });
    await runCull();
    expect(verdicts().map((v) => v.image_key)).toEqual(['ill', 'void-ok']);
  });

  it('a photo Laya fails on stays pending, is counted and is retried by the next job', async () => {
    await addPhoto('a', PASS);
    await addPhoto('bad', PASS);
    laya.failOn = 'bad';
    const job = await runCull();
    expect(job.status).toBe('completed');
    expect(result(job)).toMatchObject({ culled: 1, failed: 1, pending: 1 });
    expect(verdicts().find((v) => v.image_key === 'bad')).toMatchObject({ verdict: 'pending', pending_reason: 'laya_failed: decode failed' });
    expect(fx.query("SELECT COUNT(*) AS n FROM cull_stage_answers WHERE image_key = 'bad'")).toEqual([{ n: 0 }]);

    laya.failOn = null;
    laya.calls = [];
    await runCull();
    expect(laya.calls.map((c) => c.file.endsWith('/bad.jpg'))).toEqual([true]);
    expect(verdicts().find((v) => v.image_key === 'bad')!.verdict).toBe('sent');
  });

  it('a photo with no image to read stays pending', async () => {
    fx.addImage({ key: 'gone', filepath: '/missing/gone.NEF' });
    laya.starts = 0;
    const job = await runCull();
    expect(result(job)).toMatchObject({ failed: 1, pending: 1 });
    expect(verdicts()[0]).toMatchObject({ verdict: 'pending', pending_reason: 'no_image' });
    expect(laya.starts).toBe(0);
  });

  it('scope_job_type batch_describe culls only undescribed photos', async () => {
    await addPhoto('done', PASS);
    await addPhoto('todo', PASS);
    fx.exec(
      `INSERT INTO image_descriptions (image_key, image_type, summary, model_used, described_at)
       VALUES ('done', 'catalog', 'x', 'local:vision-1', datetime('now'))`,
    );
    laya.calls = [];
    await runCull({ scope_job_type: 'batch_describe' });
    expect(laya.calls.map((c) => (c.file.match(/\/(\w+)\.jpg$/) ?? [])[1])).toEqual(['todo']);
  });

  it('scope_job_type batch_score culls only photos with unscored work', async () => {
    await addPhoto('done', PASS);
    await addPhoto('todo', PASS);
    fx.addPerspectives({ slug: 'street' });
    const lib = openLibraryDb(fx.dbPath);
    const promptVersion = computePromptVersion(getPerspectiveBySlug(lib, 'street')!);
    lib.close();
    fx.exec(
      `INSERT INTO image_descriptions (image_key, image_type, summary, model_used, described_at)
       VALUES ('done', 'catalog', 'x', 'local:vision-1', datetime('now')),
              ('todo', 'catalog', 'x', 'local:vision-1', datetime('now'))`,
    );
    fx.exec(
      `INSERT INTO image_scores (image_key, image_type, perspective_slug, score, prompt_version, model_used, is_current, scored_at)
       VALUES ('done', 'catalog', 'street', 7, ?, 'local:vision-1', 1, datetime('now'))`,
      promptVersion,
    );
    laya.calls = [];
    await runCull({ scope_job_type: 'batch_score', perspective_slugs: ['street'] });
    expect(laya.calls.map((c) => (c.file.match(/\/(\w+)\.jpg$/) ?? [])[1])).toEqual(['todo']);
  });

  it('missing models fail the job at the start, naming the missing piece and the setup step', async () => {
    rmSync(modelsDir, { recursive: true, force: true });
    await addPhoto('a', PASS);
    const job = await runCull();
    expect(job.status).toBe('failed');
    expect(job.error).toContain('laya-base');
    expect(job.error).toContain(LAYA_SETUP_COMMAND);
    expect(job.error_severity).toBe('warning');
    expect(fx.query('SELECT COUNT(*) AS n FROM cull_stage_answers')).toEqual([{ n: 0 }]);
    expect(laya.calls).toEqual([]);
  });

  it('without Laya new the recipe still runs and the Score forecast is off', async () => {
    rmSync(join(modelsDir, 'laya-new'), { recursive: true, force: true });
    laya.forecastOn = false;
    await addPhoto('c', FORECAST_CUT);
    const job = await runCull();
    expect(result(job)).toMatchObject({ score_forecast: 'off', sent: 1, culled: 1 });
    expect(laya.calls[0]!.want!.new).toBe(false);
    expect(fx.query("SELECT COUNT(*) AS n FROM cull_stage_versions WHERE stage_key = 'score_forecast'")).toEqual([{ n: 0 }]);
    expect(fx.query('SELECT score_forecast_off FROM cull_verdicts')).toEqual([{ score_forecast_off: 1 }]);
  });

  it('a stage switched off for cut photos is not asked for a photo the recipe cut', async () => {
    await addPhoto('b', RECIPE_CUT);
    await addPhoto('a', PASS);
    const lib = openLibraryDb(fx.dbPath);
    seedCullingDefaults(lib);
    const cfg = getCurrentPipelineSetting(lib).config;
    createPipelineSettingVersion(lib, { ...cfg, score_forecast: { ...cfg.score_forecast, run_after_cut: false } });
    lib.close();
    await runCull();
    const forB = laya.calls.filter((c) => c.file.includes('/b.jpg'));
    expect(forB.map((c) => c.want!.new)).toEqual([false]);
    const forA = laya.calls.filter((c) => c.file.includes('/a.jpg'));
    expect(forA.map((c) => [c.want!.base!.length, c.want!.new])).toEqual([
      [8, false],
      [0, true],
    ]);
    expect(verdicts().map((v) => [v.image_key, v.verdict])).toEqual([
      ['a', 'sent'],
      ['b', 'cut'],
    ]);
  });

  it('sent by hand: sent whatever the stages say, and counted', async () => {
    await addPhoto('b', RECIPE_CUT);
    const db = openLibraryDb(fx.dbPath);
    recordCullUserAction(db, 'b', 'sent_by_hand');
    db.close();
    const job = await runCull();
    expect(result(job)).toMatchObject({ sent: 1, sent_by_hand_passed: 1 });
    expect(fx.query("SELECT verdict, sent_by_hand FROM cull_verdicts WHERE image_key = 'b'")).toEqual([
      { verdict: 'sent', sent_by_hand: 1 },
    ]);
  });

  it('cancelling keeps what was stored and closes the models', async () => {
    await addPhoto('a', PASS);
    await addPhoto('b', PASS);
    const job = await withJobsDb(async (db) => {
      const runner = new JobRunner(db);
      const jobId = createJob(db, 'batch_cull_photos_before_scoring', {});
      laya.cancelAfter = () => runner.signalCancel(jobId);
      await tick(db, runner);
      return getJob(db, jobId)!;
    });
    expect(job.status).toBe('cancelled');
    expect(laya.calls).toHaveLength(1);
    expect(verdicts()).toHaveLength(1);
    expect(laya.closed).toBe(1);
  });

  it('resumes past photos it failed on; a pipeline-setting change starts over', async () => {
    await addPhoto('a', PASS);
    await addPhoto('bad', PASS);
    laya.failOn = 'bad';
    // A checkpoint that says `bad` already failed in this run, under the current versions.
    await runCull();
    const stages = fx.query<{ stage_key: string; id: number }>('SELECT stage_key, id FROM cull_stage_versions WHERE is_current = 1');
    const { fingerprintBatchCull } = await import('../src/jobs/checkpoint.js');
    const fingerprint = await fingerprintBatchCull({
      stageVersions: Object.fromEntries(stages.map((s) => [s.stage_key, s.id])),
      pipelineSettingVersion: 1,
      imageKeys: null,
      resolvedMonths: null,
      resolvedYear: null,
      minRating: null,
    });
    const checkpoint = {
      checkpoint_version: 1,
      job_type: 'batch_cull_photos_before_scoring',
      fingerprint,
      processed_by_stage: {},
      failed_keys: ['bad'],
      total_at_start: 2,
    };
    laya.calls = [];
    const resumed = await runCull({ checkpoint });
    expect(laya.calls).toEqual([]);
    // The photo skipped through the checkpoint is still in the counts, from its stored summary.
    expect(result(resumed)).toMatchObject({ failed: 1, pending: 1, culled: 0 });

    const lib = openLibraryDb(fx.dbPath);
    createPipelineSettingVersion(lib, getCurrentPipelineSetting(lib).config, 'changed');
    lib.close();
    const job = await runCull({ checkpoint });
    expect(logs(job)).toContain('checkpoint mismatch: batch_cull_photos_before_scoring stage or pipeline-setting version changed, starting fresh');
    expect(laya.calls.map((c) => c.file.endsWith('/bad.jpg'))).toEqual([true]);
  });

  it('after the research import a job asks Laya only what the research left out', async () => {
    for (const key of ['fx-001-pass', 'fx-002-recipe', 'fx-003-forecast', 'fx-004-no7']) await addPhoto(key);
    const fixtures = join(import.meta.dirname, 'fixtures', 'cull');
    const lib = openLibraryDb(fx.dbPath);
    await importResearchRuns(lib, {
      layaNewPath: join(fixtures, 'laya_new_catalog.sample.jsonl'),
      recipePath: join(fixtures, 'laya_cull_catalog_all.sample.jsonl'),
      modelIds: { base: LAYA_BASE_RESEARCH_MODEL_ID, new: await layaNewModelId(join(modelsDir, 'laya-new')) },
    });
    lib.close();
    const job = await runCull();
    expect(laya.calls.map((c) => [c.file.endsWith('/fx-004-no7.jpg'), c.want!.base!.length, c.want!.new])).toEqual([
      [true, 4, false],
    ]);
    expect(result(job)).toMatchObject({ culled: 1, redecided: 0 });
  });

  it('the worker dies: the job fails, the photo is pending as such, and the next job asks it last', async () => {
    await addPhoto('a', PASS);
    await addPhoto('b', PASS);
    await addPhoto('c', PASS);
    laya.dieOn = 'c';
    const job = await runCull();
    expect(job.status).toBe('failed');
    expect(job.error).toContain('Laya worker exited');
    const [run] = fx.query<{ detail_json: string }>('SELECT detail_json FROM cull_runs');
    expect(JSON.parse(run!.detail_json)).toMatchObject({ status: 'failed' });
    expect(verdicts().find((v) => v.image_key === 'c')).toMatchObject({ verdict: 'pending', pending_reason: 'laya_worker_died' });
    expect(job.metadata.checkpoint).toMatchObject({ failed_keys: ['c'] });
    expect(laya.closed).toBe(1);

    // Selection is newest first, by key descending: c would come first. Now it comes last.
    await addPhoto('d', PASS);
    Object.assign(laya, { dieOn: null, broken: false, calls: [] });
    await runCull();
    expect(laya.calls.map((x) => x.file.split('/').at(-1))).toEqual(['d.jpg', 'b.jpg', 'a.jpg', 'c.jpg']);
  });

  async function cullCheckpoint(failedKeys: string[], totalAtStart: number, pipelineSettingVersion = 1) {
    const stages = fx.query<{ stage_key: string; id: number }>('SELECT stage_key, id FROM cull_stage_versions WHERE is_current = 1');
    const { fingerprintBatchCull } = await import('../src/jobs/checkpoint.js');
    const fingerprint = await fingerprintBatchCull({
      stageVersions: Object.fromEntries(stages.map((st) => [st.stage_key, st.id])),
      pipelineSettingVersion,
      imageKeys: null,
      resolvedMonths: null,
      resolvedYear: null,
      minRating: null,
    });
    return {
      checkpoint_version: 1,
      job_type: 'batch_cull_photos_before_scoring',
      fingerprint,
      done_by_stage: {},
      failed_keys: failedKeys,
      total_at_start: totalAtStart,
    };
  }

  it('a resumed run keeps the checkpoint’s total at start', async () => {
    await addPhoto('a', PASS);
    await addPhoto('b', PASS);
    await runCull();
    const lib = openLibraryDb(fx.dbPath);
    createPipelineSettingVersion(lib, getCurrentPipelineSetting(lib).config);
    lib.close();
    laya.dieOn = 'a';
    fx.exec("DELETE FROM cull_stage_answers WHERE image_key = 'a'");
    const job = await runCull({ checkpoint: await cullCheckpoint(['b'], 7, 2) });
    expect(job.status).toBe('failed');
    expect(job.metadata.checkpoint).toMatchObject({ total_at_start: 7, failed_keys: ['a', 'b'] });
  });

  it('a photo skipped on resume counts as sent by hand past a cut, from what is stored', async () => {
    await addPhoto('b', RECIPE_CUT);
    await runCull();
    const lib = openLibraryDb(fx.dbPath);
    recordCullUserAction(lib, 'b', 'sent_by_hand');
    createPipelineSettingVersion(lib, getCurrentPipelineSetting(lib).config);
    lib.close();
    laya.calls = [];
    const job = await runCull({ checkpoint: await cullCheckpoint(['b'], 1, 2) });
    expect(laya.calls).toEqual([]);
    expect(result(job)).toMatchObject({ failed: 1, sent: 1, sent_by_hand_passed: 1 });
  });
});

describe('LazyLaya', () => {
  it('does not start until the first answer()', async () => {
    const lazy = new LazyLaya(modelsDir);
    expect(lazy.started).toBe(false);
    await lazy.close();
    expect(laya.starts).toBe(0);
  });

  it('starts once on first answer and surfaces start errors', async () => {
    laya.startError = new LayaSetupError('missing');
    const bad = new LazyLaya(modelsDir);
    await expect(bad.answer('/x/a.jpg')).rejects.toBeInstanceOf(LayaSetupError);
    laya.startError = null;
    laya.starts = 0;
    const lazy = new LazyLaya(modelsDir);
    await lazy.answer('/x/a.jpg');
    await lazy.answer('/x/b.jpg');
    expect(laya.starts).toBe(1);
  });
});

