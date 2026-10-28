/**
 * `/api/culling-models`: each culling stage's System One endpoint, model and API key in `config.yaml`,
 * the models its endpoint lists, and how many photos its current answers cover.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createApp } from '../src/app.js';
import { openLibraryDb } from '../src/db/connection.js';
import { createJob, initJobsDb } from '../src/db/jobs/jobs.js';
import { APP_MODEL_INSTALL_JOB_TYPE } from '../src/app-models/install.js';
import { seedCullingDefaults } from '../src/db/library/cull-profiles.js';
import { getOrCreateStageVersion, upsertStageAnswer } from '../src/db/library/cull-stages.js';
import { insertCullRun } from '../src/db/library/cull-verdicts.js';
import { FAKE_PROFILE_MODEL_ID, fakeModelState, writeFakeAppModels } from './helpers/fake-app-models.js';
import { startFakeSystemOneServer, type FakeSystemOneServer } from './helpers/fake-systemone-server.js';
import { LibraryFixture } from './helpers/library-fixture.js';

let fx: LibraryFixture;
let dir: string;
let configPath: string;
let modelsDir: string;
const app = createApp();

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const put = (stage: string, body: unknown) =>
  app.request(`/api/culling-models/${stage}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const yamlOnDisk = () => parseYaml(readFileSync(configPath, 'utf8')) as Record<string, unknown>;

interface StageState {
  endpoint: string;
  model: string | null;
  has_api_key: boolean;
  answered: { photos: number; model: string | null };
}
type Listing = { culling_profile: StageState; score_forecast: StageState; total_photos: number };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-culling-models-'));
  configPath = join(dir, 'config.yaml');
  modelsDir = join(dir, 'models');
  writeFileSync(configPath, `app_models_dir: ${modelsDir}\ncatalog_path: /somewhere/catalog.lrcat\n`);
  process.env.LT_CONFIG_YAML = configPath;
  process.env.DATABASE_PATH = join(dir, 'visualizer.db');
  fx = new LibraryFixture().seedFactoryDefaults().activate();
});

afterEach(() => {
  delete process.env.LT_CONFIG_YAML;
  delete process.env.DATABASE_PATH;
  fx.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const NONE: StageState = { endpoint: 'this_app', model: null, has_api_key: false, answered: { photos: 0, model: null } };

describe('GET /api/culling-models', () => {
  it('a new install: both stages on this app with no model, nothing answered', async () => {
    fx.addImages('a', 'b');
    const res = await app.request('/api/culling-models');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ culling_profile: NONE, score_forecast: NONE, total_photos: 2 });
  });
});

describe('PUT /api/culling-models/{stage}', () => {
  it('saves the model in config.yaml, keeping every other key', async () => {
    const res = await put('culling_profile', { model: 'culling-model' });
    expect(res.status).toBe(200);
    expect((await json<StageState>(res)).model).toBe('culling-model');
    expect(yamlOnDisk()).toEqual({
      app_models_dir: modelsDir,
      catalog_path: '/somewhere/catalog.lrcat',
      culling_models: {
        culling_profile: { endpoint: 'this_app', model: 'culling-model', api_key: '' },
        score_forecast: { endpoint: 'this_app', model: '', api_key: '' },
      },
    });
    expect((await json<Listing>(await app.request('/api/culling-models'))).culling_profile.model).toBe('culling-model');
  });

  it('a new URL clears the model; the API key is saved but never sent back', async () => {
    await put('score_forecast', { model: 'forecast-model' });
    const res = await put('score_forecast', { endpoint: 'http://localhost:11434/', api_key: 'sk-1' });
    expect(await json(res)).toEqual({
      endpoint: 'http://localhost:11434',
      model: null,
      has_api_key: true,
      answered: { photos: 0, model: null },
    });
    expect((yamlOnDisk().culling_models as Record<string, unknown>).score_forecast).toEqual({
      endpoint: 'http://localhost:11434',
      model: '',
      api_key: 'sk-1',
    });
    expect(JSON.stringify(await json(await app.request('/api/culling-models')))).not.toContain('sk-1');
  });

  it('the same URL again keeps its model and key; an empty key removes it', async () => {
    await put('culling_profile', { endpoint: 'http://h:1', api_key: 'k' });
    await put('culling_profile', { model: 'clef' });
    expect(await json(await put('culling_profile', { endpoint: 'http://h:1' }))).toMatchObject({
      model: 'clef',
      has_api_key: true,
    });
    expect(await json(await put('culling_profile', { api_key: '' }))).toMatchObject({ model: 'clef', has_api_key: false });
  });

  it('the key belongs to its URL: another URL or this app drops it', async () => {
    await put('culling_profile', { endpoint: 'http://h:1', api_key: 'k' });
    expect(await json(await put('culling_profile', { endpoint: 'http://h:2' }))).toMatchObject({ has_api_key: false });
    await put('culling_profile', { api_key: 'k2' });
    expect(await json(await put('culling_profile', { endpoint: 'this_app' }))).toEqual(NONE);
  });

  it('refuses an endpoint that is neither this app nor an http(s) URL, and an unknown stage', async () => {
    expect((await put('culling_profile', { endpoint: 'localhost:11434' })).status).toBe(400);
    expect((await put('culling_profile', { endpoint: 'ftp://h' })).status).toBe(400);
    expect((await put('kimi', { model: 'x' })).status).toBe(422);
    expect(yamlOnDisk().culling_models).toBeUndefined();
  });
});

describe('GET /api/culling-models/{stage}/models', () => {
  let server: FakeSystemOneServer;

  beforeEach(async () => {
    server = await startFakeSystemOneServer(fakeModelState(), ['clef-cull', 'clef-forecast']);
  });
  afterEach(() => server.close());

  it('lists what the saved endpoint lists, asking with the saved key', async () => {
    server.apiKey = 'k1';
    await put('culling_profile', { endpoint: server.url, api_key: 'k1' });
    expect(await json(await app.request('/api/culling-models/culling_profile/models'))).toEqual({
      answers: true,
      models: ['clef-cull', 'clef-forecast'],
      error: null,
    });
  });

  it('an endpoint that does not answer says so and lists nothing', async () => {
    await put('culling_profile', { endpoint: server.url });
    await server.close();
    const body = await json<{ answers: boolean; models: string[]; error: string }>(
      await app.request('/api/culling-models/culling_profile/models'),
    );
    expect(body).toMatchObject({ answers: false, models: [] });
    expect(body.error).toContain(`${server.url} does not answer`);
  });

  it('a refused key is no answer either, with the reason', async () => {
    server.apiKey = 'right';
    await put('culling_profile', { endpoint: server.url, api_key: 'wrong' });
    const body = await json<{ answers: boolean; error: string }>(await app.request('/api/culling-models/culling_profile/models'));
    expect(body.answers).toBe(false);
    expect(body.error).toContain('refused the API key');
  });

  it('this app lists the models installed in it', async () => {
    writeFakeAppModels(modelsDir);
    expect(await json(await app.request('/api/culling-models/score_forecast/models'))).toEqual({
      answers: true,
      models: ['culling-model', 'forecast-model'],
      error: null,
    });
  });
});

describe('GET /api/culling-models/usable', () => {
  type Usable = { on: boolean; problem: string | null; model: string | null; endpoint: string; job_id: string | null; detail: string | null };
  type Body = { culling_profile: Usable; score_forecast: Usable; culling_profile_filter: boolean };
  const usable = async () => json<Body>(await app.request('/api/culling-models/usable'));
  const pipelinePut = (path: string, body: unknown) =>
    app.request(`/api/culling-profiles/pipeline/${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const ok = (model: string, endpoint = 'this_app'): Usable => ({ on: true, problem: null, model, endpoint, job_id: null, detail: null });
  const stagesOn = async () => {
    await pipelinePut('culling-profiles', { enabled: true });
    await pipelinePut('score-forecast', { enabled: true });
  };

  let server: FakeSystemOneServer;
  beforeEach(async () => {
    server = await startFakeSystemOneServer(fakeModelState(), ['clef-cull']);
  });
  afterEach(() => server.close());

  it('a new install: both stages off with no model; turned on, neither has one', async () => {
    const off: Usable = { on: false, problem: null, model: null, endpoint: 'this_app', job_id: null, detail: null };
    expect(await usable()).toEqual({ culling_profile: off, score_forecast: off, culling_profile_filter: true });
    await stagesOn();
    const none: Usable = { ...off, on: true, problem: 'no_model' };
    expect(await usable()).toEqual({ culling_profile: none, score_forecast: none, culling_profile_filter: true });
  });

  it('a stage that is off is never unusable', async () => {
    await pipelinePut('culling-profiles', { enabled: false, filter_enabled: false });
    await pipelinePut('score-forecast', { enabled: false });
    const off: Usable = { on: false, problem: null, model: null, endpoint: 'this_app', job_id: null, detail: null };
    expect(await usable()).toEqual({ culling_profile: off, score_forecast: off, culling_profile_filter: false });
  });

  it('this app: a listed model is usable, a model it does not list is not', async () => {
    await stagesOn();
    writeFakeAppModels(modelsDir);
    await put('culling_profile', { model: 'culling-model' });
    await put('score_forecast', { model: 'model-gone' });
    const body = await usable();
    expect(body.culling_profile).toEqual(ok('culling-model'));
    expect(body.score_forecast).toMatchObject({ problem: 'not_listed', model: 'model-gone' });
  });

  it('a model still converting in this app names its job', async () => {
    await stagesOn();
    const jobsDb = initJobsDb(join(dir, 'visualizer.db'));
    const jobId = createJob(jobsDb, APP_MODEL_INSTALL_JOB_TYPE, { source: '/models/model-x', name: 'model-x' });
    jobsDb.close();
    await put('culling_profile', { model: 'model-x' });
    expect((await usable()).culling_profile).toEqual({
      on: true,
      problem: 'converting',
      model: 'model-x',
      endpoint: 'this_app',
      job_id: jobId,
      detail: null,
    });
  });

  it('another endpoint: listed, not listed, refused key, down', async () => {
    await stagesOn();
    await put('culling_profile', { endpoint: server.url });
    await put('culling_profile', { model: 'clef-cull' });
    expect((await usable()).culling_profile).toEqual(ok('clef-cull', server.url));

    await put('culling_profile', { model: 'nope' });
    expect((await usable()).culling_profile).toMatchObject({ problem: 'not_listed', model: 'nope' });

    server.apiKey = 'right';
    await put('culling_profile', { model: 'clef-cull', api_key: 'wrong' });
    const refused = (await usable()).culling_profile;
    expect(refused.problem).toBe('refused');
    expect(refused.detail).toContain('refused the API key');

    await server.close();
    const down = (await usable()).culling_profile;
    expect(down.problem).toBe('down');
    expect(down.detail).toContain(`${server.url} does not answer`);
  });
});

describe('answered photos', () => {
  function answer(kind: 'culling_profile' | 'score_forecast', stageKey: string, modelId: string, keys: string[]) {
    const db = openLibraryDb(fx.dbPath);
    try {
      seedCullingDefaults(db);
      const versionId = getOrCreateStageVersion(db, {
        stageKey,
        kind,
        profileSlug: kind === 'culling_profile' ? 'default' : null,
        levelSet: kind === 'culling_profile' ? stageKey.split(':').pop()! : null,
        modelId,
        questions: { q: { type: 'score', instructions: 'q', criteria: ['a', 'b'] } },
      });
      const runId = insertCullRun(db, { kind: 'job', jobId: null, pipelineSettingVersion: 1 });
      for (const imageKey of keys) {
        upsertStageAnswer(db, {
          imageKey,
          stageVersionId: versionId,
          answers: {},
          verdict: 'passed',
          decision: {},
          pipelineSettingVersion: 1,
          source: 'job',
          runId,
        });
      }
    } finally {
      db.close();
    }
  }

  it('counts each photo once under the stage’s current versions, naming the model they were made with', async () => {
    writeFakeAppModels(modelsDir);
    fx.addImages('a', 'b', 'c');
    answer('culling_profile', 'culling_profile:default:7', FAKE_PROFILE_MODEL_ID, ['a', 'b']);
    answer('culling_profile', 'culling_profile:default:10', FAKE_PROFILE_MODEL_ID, ['a', 'b', 'c']);
    answer('score_forecast', 'score_forecast', 'clef-forecast@http://h:1', ['a']);
    answer('score_forecast', 'score_forecast', 'other@http://h:1', ['b']);
    const body = await json<Listing>(await app.request('/api/culling-models'));
    expect(body.culling_profile.answered).toEqual({ photos: 3, model: 'culling-model' });
    expect(body.score_forecast.answered).toEqual({ photos: 1, model: 'other on http://h:1' });
  });
});
