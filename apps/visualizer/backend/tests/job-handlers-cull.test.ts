/**
 * `batch_cull_photos_before_scoring` through the processor. The model worker is faked — no model is ever
 * loaded here — but the System One client, this app's endpoint, its model list and model ids,
 * library.db, the vision cache and the JPEGs are real. An external endpoint is a local fake server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibraryFixture } from './helpers/library-fixture.js';
import { fakeForecastModelId, fakeModelRuntimeModule, fakeModelState, writeFakeAppModels, writeFakePhoto, type FakeModelScript } from './helpers/fake-app-models.js';
import { insertProviderModel } from '../src/db/jobs/provider-models.js';
import { providerIdFromCullingUrl } from '../src/providers/culling-provider-id.js';
import { startFakeSystemOneServer, type FakeSystemOneServer } from './helpers/fake-systemone-server.js';
import { createJob, getJob, initJobsDb, updateJobStatus } from '../src/db/jobs/jobs.js';
import type { Db } from '../src/db/connection.js';
import { openLibraryDb } from '../src/db/connection.js';
import { JobRunner } from '../src/jobs/runner.js';
import { tick } from '../src/jobs/processor.js';
import { JOB_TYPES_BY_NAME } from '../src/jobs/registry.js';
import { APP_MODEL_SETUP_COMMAND } from '../src/app-models/files.js';
import { closeAppModels } from '../src/app-models/app-models.js';
import { APP_MODEL_INSTALL_JOB_TYPE } from '../src/app-models/install.js';
import { getCurrentPipelineSetting, createPipelineSettingVersion } from '../src/db/library/cull-pipeline.js';
import { recordCullUserAction } from '../src/db/library/cull-user-actions.js';
import { seedCullingDefaults } from '../src/db/library/cull-profiles.js';
import { FACTORY_QUESTIONS } from '../src/app-models/factory-questions.js';
import type { PipelineSettingConfig } from '../src/cull/types.js';
import { computePromptVersion } from '../src/vision/scoring-service.js';
import { getPerspectiveBySlug } from '../src/db/library/scores.js';

const fakeModels = vi.hoisted(() => ({}) as import('./helpers/fake-app-models.js').FakeModelState);

vi.mock('../src/app-models/runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app-models/runtime.js')>();
  return fakeModelRuntimeModule(actual, fakeModels);
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

type StageYaml = Partial<Record<'culling_profile' | 'score_forecast', string>>;

/** Each stage on this app's profile model and forecast model, unless named (a YAML flow map per stage). */
const THIS_APP_MODELS: Required<StageYaml> = {
  culling_profile: '{endpoint: this_app, model: culling-model}',
  score_forecast: '{endpoint: this_app, model: forecast-model}',
};

/** config.yaml with a `culling_models` block; `null` leaves the block out. */
function writeConfig(stages: StageYaml | null = {}): void {
  const s = { ...THIS_APP_MODELS, ...stages };
  const block = stages === null ? '' : `culling_models:\n  culling_profile: ${s.culling_profile}\n  score_forecast: ${s.score_forecast}\n`;
  writeFileSync(join(dir, 'config.yaml'), `vision_cache_dir: ${join(dir, 'vision')}\napp_models_dir: ${modelsDir}\n${block}`);
}

/** A catalog photo whose original is gone and whose vision-cache JPEG exists. */
async function addPhoto(key: string, script?: FakeModelScript): Promise<void> {
  const path = join(dir, 'vision', `${key}.jpg`);
  await writeFakePhoto(path, key);
  fx.addImage({ key, filepath: `/missing/${key}.NEF`, date_taken: '2024-01-01' }).addVisionCache(key, path);
  if (script) fakeModels.scripts.set(key, script);
}

function changePipeline(change: (cfg: PipelineSettingConfig) => PipelineSettingConfig): void {
  const lib = openLibraryDb(fx.dbPath);
  seedCullingDefaults(lib);
  createPipelineSettingVersion(lib, change(getCurrentPipelineSetting(lib).config));
  lib.close();
}

const verdicts = () =>
  fx.query<{ image_key: string; verdict: string; filtered_by: string | null; pending_reason: string; pipeline_setting_version: number }>(
    'SELECT image_key, verdict, filtered_by, pending_reason, pipeline_setting_version FROM cull_verdicts ORDER BY image_key',
  );
const result = (job: { result: unknown }) => job.result as Record<string, unknown>;
const logs = (job: { logs: { message: string }[] }) => job.logs.map((l) => l.message);
/** Calls as `[photo key, model, number of questions]`. */
const calls = () => fakeModels.calls.map((c) => [c.file.slice(1, -4), c.model, c.questions.length]);
const photosAsked = () => [...new Set(fakeModels.calls.map((c) => c.file.slice(1, -4)))];

const PASS: FakeModelScript = { levels: [5, 5, 6, 6], p8: 0.5 };
const PROFILE_CUT: FakeModelScript = { levels: [5, 5, 2, 3], p8: 0.5 };
const FORECAST_CUT: FakeModelScript = { levels: [5, 5, 6, 6], p8: 0.05 };
const FORECAST_QUESTIONS = Object.keys(FACTORY_QUESTIONS.score_forecast).length;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-cull-job-'));
  jobsDbPath = join(dir, 'visualizer.db');
  modelsDir = join(dir, 'models');
  fx = new LibraryFixture().cullingStagesOn().addForecastQuestions().activate();
  Object.assign(fakeModels, fakeModelState());
  process.env.DATABASE_PATH = jobsDbPath;
  writeConfig();
  process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
  writeFakeAppModels(modelsDir);
});

afterEach(async () => {
  await closeAppModels();
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
    await addPhoto('b', PROFILE_CUT);
    await addPhoto('c', FORECAST_CUT);
    const job = await runCull();
    expect(job.status).toBe('completed');
    expect(fakeModels.checks).toBe(2);
    expect(calls()).toEqual([
      ['c', 'culling-model', 8],
      ['c', 'forecast-model', FORECAST_QUESTIONS],
      ['b', 'culling-model', 8],
      ['b', 'forecast-model', FORECAST_QUESTIONS],
      ['a', 'culling-model', 8],
      ['a', 'forecast-model', FORECAST_QUESTIONS],
    ]);
    expect(verdicts()).toEqual([
      { image_key: 'a', verdict: 'passed', filtered_by: null, pending_reason: '', pipeline_setting_version: 1 },
      { image_key: 'b', verdict: 'filtered', filtered_by: 'culling_profile', pending_reason: '', pipeline_setting_version: 1 },
      { image_key: 'c', verdict: 'filtered', filtered_by: 'score_forecast', pending_reason: '', pipeline_setting_version: 1 },
    ]);
    const rows = fx.query<{ stage_key: string; verdict: string; answers_json: string; source: string; produced_by: string }>(
      `SELECT v.stage_key, a.verdict, a.answers_json, a.source, a.produced_by FROM cull_stage_answers a
       JOIN cull_stage_versions v ON v.id = a.stage_version_id WHERE a.image_key = 'b' ORDER BY v.stage_key`,
    );
    expect(rows.map((r) => [r.stage_key, r.verdict, r.produced_by])).toEqual([
      ['culling_profile:default:10', 'filtered', 'this_app'],
      ['culling_profile:default:7', 'filtered', 'this_app'],
      ['score_forecast', 'passed', 'this_app'],
    ]);
    expect(JSON.parse(rows[0]!.answers_json)['connotation']).toHaveLength(10);
    expect(JSON.parse(rows[1]!.answers_json)['connotation']).toHaveLength(7);
    expect(rows.every((r) => r.source === 'job')).toBe(true);
    expect(result(job)).toMatchObject({
      total: 3,
      culled: 3,
      failed: 0,
      filtered_by_culling_profile: 1,
      filtered_by_score_forecast: 1,
      pending: 0,
      passed: 1,
      sent_by_hand_passed: 0,
      score_forecast: 'on',
      pipeline_setting_version: 1,
      models_started: true,
    });
    expect(result(job).durations_s).toEqual(
      expect.objectContaining({ start_check: expect.any(Number), select: expect.any(Number), cull: expect.any(Number) }),
    );
    expect(result(job).stage_seconds).toEqual({ culling_profile: expect.any(Number), score_forecast: expect.any(Number) });
    expect(logs(job).some((m) => m.startsWith('[cull] status=complete photos=3 culled=3'))).toBe(true);
    expect(fx.query('SELECT kind, job_id IS NOT NULL AS has_job, finished_at IS NOT NULL AS finished FROM cull_runs')).toEqual([
      { kind: 'job', has_job: 1, finished: 1 },
    ]);
  });

  it("names this app's models by the ids they had before System One, so stored versions stay current", async () => {
    await addPhoto('a', PASS);
    await runCull();
    expect(fx.query('SELECT stage_key, model_id FROM cull_stage_versions ORDER BY id')).toEqual([
      { stage_key: 'culling_profile:default:7', model_id: 'owner/vision-model@8b318c99d7ad3ce19c24369263463882eada9d1e' },
      { stage_key: 'culling_profile:default:10', model_id: 'owner/vision-model@8b318c99d7ad3ce19c24369263463882eada9d1e' },
      { stage_key: 'score_forecast', model_id: await fakeForecastModelId(modelsDir) },
    ]);
  });

  it('asks only what is missing, and nothing for photos already decided', async () => {
    await addPhoto('a', PASS);
    await runCull();
    fakeModels.calls = [];
    const again = await runCull();
    expect(fakeModels.calls).toEqual([]);
    expect(result(again)).toMatchObject({ culled: 0, redecided: 0, models_started: false });

    fx.exec(
      `DELETE FROM cull_stage_answers WHERE stage_version_id =
         (SELECT id FROM cull_stage_versions WHERE stage_key = 'culling_profile:default:7')`,
    );
    await runCull();
    expect(calls()).toEqual([['a', 'culling-model', 4]]);
    expect(fakeModels.calls[0]!.questions.every((q) => q.startsWith('culling_profile:default:7#7|'))).toBe(true);
  });

  it('a new pipeline-setting version re-decides from stored answers, no model call', async () => {
    await addPhoto('c', FORECAST_CUT);
    await runCull();
    fakeModels.calls = [];
    changePipeline((cfg) => ({ ...cfg, score_forecast: { ...cfg.score_forecast, threshold: 0.01 } }));
    const job = await runCull();
    expect(fakeModels.calls).toEqual([]);
    expect(result(job)).toMatchObject({ redecided: 1, passed: 1 });
    expect(verdicts()[0]).toMatchObject({ verdict: 'passed', pipeline_setting_version: 2 });
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

  it('a photo a model fails on stays pending, naming the stage, is counted and is retried by the next job', async () => {
    await addPhoto('a', PASS);
    await addPhoto('bad', PASS);
    fakeModels.failOn = 'bad';
    const job = await runCull();
    expect(job.status).toBe('completed');
    expect(result(job)).toMatchObject({ culled: 1, failed: 1, pending: 1 });
    expect(verdicts().find((v) => v.image_key === 'bad')).toMatchObject({
      verdict: 'pending',
      pending_reason: 'model_failed: Culling profile: this app answered HTTP 422: decode failed',
    });
    expect(logs(job)).toContain('[cull] bad left pending: Culling profile: this app answered HTTP 422: decode failed');
    expect(fx.query("SELECT COUNT(*) AS n FROM cull_stage_answers WHERE image_key = 'bad'")).toEqual([{ n: 0 }]);

    fakeModels.failOn = null;
    fakeModels.calls = [];
    await runCull();
    expect(photosAsked()).toEqual(['bad']);
    expect(verdicts().find((v) => v.image_key === 'bad')!.verdict).toBe('passed');
  });

  it('a photo with no image to read stays pending, and no model is started', async () => {
    fx.addImage({ key: 'gone', filepath: '/missing/gone.NEF' });
    const job = await runCull();
    expect(result(job)).toMatchObject({ failed: 1, pending: 1, models_started: false });
    expect(verdicts()[0]).toMatchObject({ verdict: 'pending', pending_reason: 'no_image' });
    expect(fakeModels.starts).toBe(0);
  });

  it('scope_job_type batch_describe culls only undescribed photos', async () => {
    await addPhoto('done', PASS);
    await addPhoto('todo', PASS);
    fx.exec(
      `INSERT INTO image_descriptions (image_key, image_type, summary, model_used, described_at)
       VALUES ('done', 'catalog', 'x', 'local:vision-1', datetime('now'))`,
    );
    await runCull({ scope_job_type: 'batch_describe' });
    expect(photosAsked()).toEqual(['todo']);
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
    await runCull({ scope_job_type: 'batch_score', perspective_slugs: ['street'] });
    expect(photosAsked()).toEqual(['todo']);
  });

  it('missing models fail the job at the start, naming the stage, the model and the setup step', async () => {
    rmSync(modelsDir, { recursive: true, force: true });
    await addPhoto('a', PASS);
    const job = await runCull();
    expect(job.status).toBe('failed');
    expect(job.error).toContain('Culling profile: culling-model is not listed by this app');
    expect(job.error).toContain(APP_MODEL_SETUP_COMMAND);
    expect(job.error_severity).toBe('warning');
    expect(fx.query('SELECT COUNT(*) AS n FROM cull_stage_answers')).toEqual([{ n: 0 }]);
    expect(fakeModels.calls).toEqual([]);
  });

  it('a new install has no model for either stage: a stage that is on fails the job, naming the stage', async () => {
    writeConfig(null);
    await addPhoto('a', PASS);
    const job = await runCull();
    expect(job.status).toBe('failed');
    expect(job.error).toBe(
      'Culling profile: no model chosen. Choose one in Processing → Settings → Culling models, or turn the culling profile off',
    );
    expect(job.error_severity).toBe('warning');
    expect(fakeModels.calls).toEqual([]);
  });

  it('a Score forecast that is on with no model fails the job, naming it', async () => {
    writeConfig({ score_forecast: '{endpoint: this_app, model: ""}' });
    await addPhoto('a', PASS);
    const job = await runCull();
    expect(job.status).toBe('failed');
    expect(job.error).toBe(
      'Score forecast: no model chosen. Choose one in Processing → Settings → Culling models, or turn the Score forecast off',
    );
  });

  it('a stage that is off needs no model', async () => {
    writeConfig({ score_forecast: '{endpoint: this_app, model: ""}' });
    changePipeline((cfg) => ({ ...cfg, score_forecast: { ...cfg.score_forecast, enabled: false } }));
    await addPhoto('a', PASS);
    expect((await runCull()).status).toBe('completed');
  });

  it('a model still converting in this app fails the job saying so, not that the setup step is missing', async () => {
    writeConfig({ culling_profile: '{endpoint: this_app, model: model-x}' });
    await addPhoto('a', PASS);
    const job = await runCull({}, (db) => {
      updateJobStatus(db, createJob(db, APP_MODEL_INSTALL_JOB_TYPE, { source: '/models/model-x', name: 'model-x' }), 'running');
    });
    expect(job.status).toBe('failed');
    expect(job.error).toBe('Culling profile: model-x is still converting. It can be used once its conversion job finishes');
    expect(fakeModels.calls).toEqual([]);
  });

  it('the Score forecast on with no questions fails the job naming the stage, before any photo', async () => {
    fx.exec('DELETE FROM score_forecast_question_versions');
    await addPhoto('a', PASS);
    const job = await runCull();
    expect(job.status).toBe('failed');
    expect(job.error).toBe(
      'Score forecast: no questions yet. Create them in Perspectives → Score forecast questions, or turn the Score forecast off',
    );
    expect(job.error_severity).toBe('warning');
    expect(fakeModels.calls).toEqual([]);
  });

  it('without the forecast model and the Score forecast on, the job fails naming the Score forecast', async () => {
    rmSync(join(modelsDir, 'forecast-model'), { recursive: true, force: true });
    await addPhoto('c', FORECAST_CUT);
    const job = await runCull();
    expect(job.status).toBe('failed');
    expect(job.error).toContain('Score forecast: forecast-model is not listed by this app');
    expect(job.error_severity).toBe('warning');
    expect(fakeModels.calls).toEqual([]);
  });

  it('without the forecast model and the Score forecast off, the profile runs alone', async () => {
    rmSync(join(modelsDir, 'forecast-model'), { recursive: true, force: true });
    changePipeline((cfg) => ({ ...cfg, score_forecast: { ...cfg.score_forecast, enabled: false } }));
    await addPhoto('c', FORECAST_CUT);
    const job = await runCull();
    expect(result(job)).toMatchObject({ score_forecast: 'off', passed: 1, culled: 1 });
    expect(calls()).toEqual([['c', 'culling-model', 8]]);
    expect(fx.query("SELECT COUNT(*) AS n FROM cull_stage_versions WHERE stage_key = 'score_forecast'")).toEqual([{ n: 0 }]);
    expect(fx.query('SELECT score_forecast_off FROM cull_verdicts')).toEqual([{ score_forecast_off: 1 }]);
  });

  it('a start check that fails stops the job before any photo, naming the stage', async () => {
    await addPhoto('a', PASS);
    fakeModels.startError = new Error('Models failed to load (bad onnx)');
    const job = await runCull();
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/^Culling profile: the start check failed: .*bad onnx/);
    expect(job.error_severity).toBe('warning');
    expect(verdicts()).toEqual([]);
  });

  it('asks every stage that is on, even on a photo the profile filters', async () => {
    await addPhoto('b', PROFILE_CUT);
    await runCull();
    expect(calls()).toEqual([
      ['b', 'culling-model', 8],
      ['b', 'forecast-model', FORECAST_QUESTIONS],
    ]);
    expect(verdicts().map((v) => [v.image_key, v.verdict])).toEqual([['b', 'filtered']]);
  });

  it('with the culling profiles off, only the Score forecast is asked, and it alone filters', async () => {
    await addPhoto('b', PROFILE_CUT);
    await addPhoto('c', FORECAST_CUT);
    changePipeline((cfg) => ({ ...cfg, culling_profiles_enabled: false }));
    await runCull();
    expect(calls()).toEqual([
      ['c', 'forecast-model', FORECAST_QUESTIONS],
      ['b', 'forecast-model', FORECAST_QUESTIONS],
    ]);
    expect(verdicts().map((v) => [v.image_key, v.verdict])).toEqual([
      ['b', 'passed'],
      ['c', 'filtered'],
    ]);
  });

  it("with the culling profiles off, this app's Score forecast still needs the profile model's vision graph", async () => {
    rmSync(join(modelsDir, 'culling-model', 'vision.onnx'));
    changePipeline((cfg) => ({ ...cfg, culling_profiles_enabled: false }));
    await addPhoto('c', FORECAST_CUT);
    const job = await runCull();
    expect(job.status).toBe('failed');
    // The forecast model reuses the profile model's vision graph: without it, this app does not list the forecast model.
    expect(job.error).toContain('Score forecast: forecast-model is not listed by this app');
  });

  it('sent by hand: passed whatever the stages say, and counted', async () => {
    await addPhoto('b', PROFILE_CUT);
    const db = openLibraryDb(fx.dbPath);
    recordCullUserAction(db, 'b', 'sent_by_hand');
    db.close();
    const job = await runCull();
    expect(result(job)).toMatchObject({ passed: 1, sent_by_hand_passed: 1 });
    expect(fx.query("SELECT verdict, sent_by_hand FROM cull_verdicts WHERE image_key = 'b'")).toEqual([
      { verdict: 'passed', sent_by_hand: 1 },
    ]);
  });

  it('cancelling keeps what was stored', async () => {
    await addPhoto('a', PASS);
    await addPhoto('b', PASS);
    const job = await withJobsDb(async (db) => {
      const runner = new JobRunner(db);
      const jobId = createJob(db, 'batch_cull_photos_before_scoring', {});
      fakeModels.cancelAfter = () => runner.signalCancel(jobId);
      await tick(db, runner);
      return getJob(db, jobId)!;
    });
    expect(job.status).toBe('cancelled');
    expect(photosAsked()).toEqual(['b']);
    expect(verdicts()).toHaveLength(1);
  });

  it('resumes past photos it failed on; a pipeline-setting change starts over', async () => {
    await addPhoto('a', PASS);
    await addPhoto('bad', PASS);
    fakeModels.failOn = 'bad';
    // A checkpoint that says `bad` already failed in this run, under the current versions.
    await runCull();
    const checkpoint = await cullCheckpoint(['bad'], 2);
    fakeModels.calls = [];
    const resumed = await runCull({ checkpoint });
    expect(fakeModels.calls).toEqual([]);
    // The photo skipped through the checkpoint is still in the counts, from its stored summary.
    expect(result(resumed)).toMatchObject({ failed: 1, pending: 1, culled: 0 });

    changePipeline((cfg) => cfg);
    const job = await runCull({ checkpoint });
    expect(logs(job)).toContain('checkpoint mismatch: batch_cull_photos_before_scoring stage or pipeline-setting version changed, starting fresh');
    expect(photosAsked()).toEqual(['bad']);
  });

  it('the worker dies: the job fails, the photo is pending as such, and the next job asks it last', async () => {
    await addPhoto('a', PASS);
    await addPhoto('b', PASS);
    await addPhoto('c', PASS);
    fakeModels.dieOn = 'c';
    const job = await runCull();
    expect(job.status).toBe('failed');
    expect(job.error).toBe('Culling profile: this app cannot answer now (this app answered HTTP 503: Model worker exited (code 1))');
    const [run] = fx.query<{ detail_json: string }>('SELECT detail_json FROM cull_runs');
    expect(JSON.parse(run!.detail_json)).toMatchObject({ status: 'failed' });
    expect(verdicts().find((v) => v.image_key === 'c')).toMatchObject({ verdict: 'pending', pending_reason: 'endpoint_down' });
    expect(job.metadata.checkpoint).toMatchObject({ failed_keys: ['c'] });

    // Selection is newest first, by key descending: c would come first. Now it comes last.
    await addPhoto('d', PASS);
    Object.assign(fakeModels, { dieOn: null, broken: false, calls: [] });
    await runCull();
    expect(photosAsked()).toEqual(['d', 'b', 'a', 'c']);
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
    changePipeline((cfg) => cfg);
    fakeModels.dieOn = 'a';
    fx.exec("DELETE FROM cull_stage_answers WHERE image_key = 'a'");
    const job = await runCull({ checkpoint: await cullCheckpoint(['b'], 7, 2) });
    expect(job.status).toBe('failed');
    expect(job.metadata.checkpoint).toMatchObject({ total_at_start: 7, failed_keys: ['a', 'b'] });
  });

  it('a photo skipped on resume counts as sent by hand past a filter, from what is stored', async () => {
    await addPhoto('b', PROFILE_CUT);
    await runCull();
    const lib = openLibraryDb(fx.dbPath);
    recordCullUserAction(lib, 'b', 'sent_by_hand');
    createPipelineSettingVersion(lib, getCurrentPipelineSetting(lib).config);
    lib.close();
    fakeModels.calls = [];
    const job = await runCull({ checkpoint: await cullCheckpoint(['b'], 1, 2) });
    expect(fakeModels.calls).toEqual([]);
    expect(result(job)).toMatchObject({ failed: 1, passed: 1, sent_by_hand_passed: 1 });
  });
});

describe('batch_cull_photos_before_scoring on an external System One endpoint', () => {
  let server: FakeSystemOneServer;
  let providerId: string;

  function writeSystemOneProvider(url: string, apiKey: string, models: string[]): void {
    providerId = providerIdFromCullingUrl(url);
    writeFileSync(
      join(dir, 'providers.json'),
      JSON.stringify(
        {
          providers: {
            [providerId]: {
              name: 'External',
              protocol: 'system_one',
              enabled: true,
              base_url: { from: 'literal', value: url.replace(/\/+$/, '') },
              auth: { mode: 'bearer', secret: { from: 'literal', value: apiKey } },
            },
          },
          defaults: {},
          fallback_order: [],
        },
        null,
        2,
      ),
    );
    process.env.LT_PROVIDERS_JSON = join(dir, 'providers.json');
    const db = initJobsDb(jobsDbPath);
    for (const m of models) {
      insertProviderModel(db, {
        providerId,
        modelId: m,
        modelName: m,
        origin: 'config',
        acceptsImages: true,
        refusedReason: null,
      });
    }
    db.close();
  }

  beforeEach(async () => {
    server = await startFakeSystemOneServer(fakeModels, ['clef-cull', 'clef-forecast']);
    writeSystemOneProvider(server.url, 'k1', ['clef-cull', 'clef-forecast']);
  });
  afterEach(() => server.close());

  const both = (): StageYaml => ({
    culling_profile: `{endpoint: ${providerId}, model: clef-cull}`,
    score_forecast: `{endpoint: ${providerId}, model: clef-forecast}`,
  });
  const forecastElsewhere = (model: string): StageYaml => ({
    score_forecast: `{endpoint: ${providerId}, model: ${model}}`,
  });

  it('keeps the endpoint the pass started with after the provider is parked', async () => {
    writeConfig(both());
    await addPhoto('a', PASS);
    const providersPath = join(dir, 'providers.json');
    const stored = JSON.parse(readFileSync(providersPath, 'utf8')) as {
      providers: Record<string, { enabled: boolean }>;
    };
    stored.providers[providerId]!.enabled = false;
    writeFileSync(providersPath, JSON.stringify(stored, null, 2));
    const job = await runCull();
    expect(job.status).toBe('completed');
    expect(server.requests.length).toBeGreaterThan(0);
  });

  it('asks each stage of the endpoint config.yaml names, with its API key, and files answers under it', async () => {
    writeConfig(both());
    server.apiKey = 'k1';
    await addPhoto('b', PROFILE_CUT);
    await addPhoto('c', FORECAST_CUT);
    const job = await runCull();
    expect(job.status).toBe('completed');
    expect(fakeModels.calls).toEqual([]);
    expect(server.requests.map((r) => [r.key, r.model, r.questions.length])).toEqual([
      [null, 'clef-cull', 8],
      [null, 'clef-forecast', FORECAST_QUESTIONS],
      ['c', 'clef-cull', 8],
      ['c', 'clef-forecast', FORECAST_QUESTIONS],
      ['b', 'clef-cull', 8],
      ['b', 'clef-forecast', FORECAST_QUESTIONS],
    ]);
    expect(server.requests.every((r) => r.authorization === 'Bearer k1' && r.state === '')).toBe(true);
    expect(verdicts().map((v) => [v.image_key, v.verdict, v.filtered_by])).toEqual([
      ['b', 'filtered', 'culling_profile'],
      ['c', 'filtered', 'score_forecast'],
    ]);
    expect(fx.query('SELECT stage_key, model_id FROM cull_stage_versions ORDER BY id')).toEqual([
      { stage_key: 'culling_profile:default:7', model_id: `clef-cull@${server.url}` },
      { stage_key: 'culling_profile:default:10', model_id: `clef-cull@${server.url}` },
      { stage_key: 'score_forecast', model_id: `clef-forecast@${server.url}` },
    ]);
    expect(fx.query('SELECT DISTINCT produced_by FROM cull_stage_answers')).toEqual([{ produced_by: server.url }]);
  });

  it('one stage on this app and one elsewhere', async () => {
    writeConfig(forecastElsewhere('clef-forecast'));
    await addPhoto('a', PASS);
    const job = await runCull();
    expect(job.status).toBe('completed');
    expect(calls()).toEqual([['a', 'culling-model', 8]]);
    expect(server.requests.map((r) => [r.key, r.model])).toEqual([
      [null, 'clef-forecast'],
      ['a', 'clef-forecast'],
    ]);
    expect(
      fx.query(
        `SELECT v.stage_key, a.produced_by FROM cull_stage_answers a JOIN cull_stage_versions v ON v.id = a.stage_version_id ORDER BY v.id`,
      ),
    ).toEqual([
      { stage_key: 'culling_profile:default:7', produced_by: 'this_app' },
      { stage_key: 'culling_profile:default:10', produced_by: 'this_app' },
      { stage_key: 'score_forecast', produced_by: server.url },
    ]);
  });

  it("another model's answers never read as current; switching back makes the earlier answers current again", async () => {
    await addPhoto('a', PASS);
    await runCull();
    writeConfig(forecastElsewhere('clef-forecast'));
    fakeModels.calls = [];
    await runCull();
    expect(fakeModels.calls).toEqual([]);
    expect(server.requests.map((r) => r.key)).toEqual([null, 'a']);
    writeConfig();
    server.requests = [];
    const back = await runCull();
    expect(fakeModels.calls).toEqual([]);
    expect(server.requests).toEqual([]);
    expect(result(back)).toMatchObject({ culled: 0, redecided: 1 });
    expect(fx.query("SELECT model_id, is_current FROM cull_stage_versions WHERE kind = 'score_forecast' ORDER BY id")).toEqual([
      { model_id: await fakeForecastModelId(modelsDir), is_current: 1 },
      { model_id: `clef-forecast@${server.url}`, is_current: 0 },
    ]);
  });

  it('an endpoint that wants a data URL gets one from the first request', async () => {
    writeConfig(both());
    await addPhoto('a', PASS);
    expect((await runCull()).status).toBe('completed');
    expect(server.requests.map((r) => r.encoding)).toEqual(['data_url', 'data_url', 'data_url', 'data_url']);
  });

  it('an endpoint that wants raw base64: the start check finds out, and every photo goes that way', async () => {
    writeConfig(both());
    server.accepts = 'base64';
    await addPhoto('a', PASS);
    await addPhoto('b', PROFILE_CUT);
    const job = await runCull();
    expect(job.status).toBe('completed');
    expect(server.requests.map((r) => [r.key, r.model, r.encoding])).toEqual([
      [null, 'clef-cull', 'data_url'],
      [null, 'clef-cull', 'base64'],
      [null, 'clef-forecast', 'data_url'],
      [null, 'clef-forecast', 'base64'],
      ['b', 'clef-cull', 'base64'],
      ['b', 'clef-forecast', 'base64'],
      ['a', 'clef-cull', 'base64'],
      ['a', 'clef-forecast', 'base64'],
    ]);
    expect(verdicts().map((v) => [v.image_key, v.verdict])).toEqual([
      ['a', 'passed'],
      ['b', 'filtered'],
    ]);
  });

  it('a start check refused in both encodings fails the job, naming the stage and what the endpoint said', async () => {
    writeConfig(both());
    server.badRequest = true;
    await addPhoto('a', PASS);
    const job = await runCull();
    expect(job.status).toBe('failed');
    expect(job.error).toBe('Culling profile: the start check failed: External answered HTTP 400: question too long');
    expect(server.requests.map((r) => r.encoding)).toEqual(['data_url', 'base64']);
  });

  it('a refused API key fails the job at the start, naming the stage', async () => {
    writeConfig(both());
    server.apiKey = 'other';
    await addPhoto('a', PASS);
    const job = await runCull();
    expect(job.status).toBe('failed');
    expect(job.error).toBe('Culling profile: External refused the API key (External answered HTTP 401: invalid api key)');
    expect(job.error_severity).toBe('warning');
  });

  it('a model the endpoint does not list fails the job at the start, naming the stage and the model', async () => {
    writeConfig(forecastElsewhere('nope'));
    await addPhoto('a', PASS);
    const job = await runCull();
    expect(job.status).toBe('failed');
    expect(job.error).toBe('Score forecast: nope is not listed by External');
  });

  it('an endpoint that does not answer fails the job at the start, naming the stage', async () => {
    await server.close();
    writeConfig(both());
    await addPhoto('a', PASS);
    const job = await runCull();
    expect(job.status).toBe('failed');
    expect(job.error).toContain('Culling profile: External does not answer');
  });

  it('an HTTP error on one photo leaves it pending; the endpoint going away mid-job stops the job', async () => {
    writeConfig(both());
    await addPhoto('a', PASS);
    await addPhoto('b', PASS);
    await addPhoto('c', PASS);
    server.failOn = 'c';
    server.dieOn = 'a';
    const job = await runCull();
    expect(job.status).toBe('failed');
    expect(job.error).toContain('Culling profile: External does not answer');
    expect(verdicts().map((v) => [v.image_key, v.verdict, v.pending_reason])).toEqual([
      ['a', 'pending', 'endpoint_down'],
      ['b', 'passed', ''],
      ['c', 'pending', 'model_failed: Culling profile: External answered HTTP 500: out of memory'],
    ]);
  });
});
