/**
 * This app's System One endpoint: `GET /v1/models` and `POST /v1/systemone` over the models in
 * `app_models_dir`. The model worker is faked; the model files' check, their identities, the wire
 * shapes and the worker's lifetime are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeForecastModelId, fakeModelRuntimeModule, fakeModelState, writeFakeAppModels, writeFakePhoto } from './helpers/fake-app-models.js';
import { createApp } from '../src/app.js';
import { systemOneRoutes } from '../src/api/systemone.js';
import { AppModels, closeAppModels } from '../src/app-models/app-models.js';
import { APP_MODEL_SETUP_COMMAND } from '../src/app-models/files.js';

const fakeModels = vi.hoisted(() => ({}) as ReturnType<typeof import('./helpers/fake-app-models.js').fakeModelState>);

vi.mock('../src/app-models/runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app-models/runtime.js')>();
  return fakeModelRuntimeModule(actual, fakeModels);
});

let dir: string;
let modelsDir: string;
let photo: string;

beforeEach(async () => {
  Object.assign(fakeModels, fakeModelState());
  dir = mkdtempSync(join(tmpdir(), 'lt-s1-endpoint-'));
  modelsDir = join(dir, 'models');
  writeFakeAppModels(modelsDir);
  writeFileSync(join(dir, 'config.yaml'), `app_models_dir: ${modelsDir}\n`);
  process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
  photo = join(dir, 'a.jpg');
  await writeFakePhoto(photo, 'a');
});

afterEach(async () => {
  await closeAppModels();
  delete process.env.LT_CONFIG_YAML;
  rmSync(dir, { recursive: true, force: true });
});

const post = (body: unknown) =>
  systemOneRoutes.request('/v1/systemone', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const b64 = () => readFileSync(photo).toString('base64');
const QUESTIONS = {
  'culling_profile:default:7#7|connotation': {
    type: 'score',
    instructions: 'What does it suggest?',
    criteria: ['1', '2', '3', '4', '5', '6', '7'],
  },
  'score_forecast#framing-excusal': { type: 'noul', instructions: 'No framing device?' },
};

describe('GET /v1/models', () => {
  it('lists the profile model and the forecast model under the identities stage versions already hash', async () => {
    const res = await systemOneRoutes.request('/v1/models');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: { name: string; x_model_id: string; release_date: string }[] };
    expect(body.models.map((m) => [m.name, m.x_model_id])).toEqual([
      ['culling-model', 'owner/vision-model@8b318c99d7ad3ce19c24369263463882eada9d1e'],
      ['forecast-model', await fakeForecastModelId(modelsDir)],
    ]);
    expect(body.models[0]!.release_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('lists the profile model alone without the forecast model, and nothing before the setup step', async () => {
    rmSync(join(modelsDir, 'forecast-model'), { recursive: true });
    let body = (await (await systemOneRoutes.request('/v1/models')).json()) as { models: { name: string }[] };
    expect(body.models.map((m) => m.name)).toEqual(['culling-model']);
    rmSync(modelsDir, { recursive: true });
    body = (await (await systemOneRoutes.request('/v1/models')).json()) as { models: { name: string }[] };
    expect(body.models).toEqual([]);
  });

  it('is served by the app at the root, outside /api', async () => {
    const res = await createApp().request('/v1/models');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('POST /v1/systemone', () => {
  it('answers in the System One shape, a noul with its false/true probabilities', async () => {
    fakeModels.scripts.set('a', { levels: [5, 5, 5, 4], p8: 0.5 });
    const res = await post({ model: 'culling-model', state: '', images: [b64()], questions: QUESTIONS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.model).toBe('culling-model');
    const score = body.answers['culling_profile:default:7#7|connotation'];
    expect(score).toMatchObject({ type: 'score', legend: { '0': '1', '6': '7' } });
    expect(score.probabilities).toEqual({ '0': 0, '1': 0, '2': 1, '3': 0, '4': 0, '5': 0, '6': 0 });
    expect(score.score).toBe(2);
    expect(score.confidence).toBe(1);
    expect(body.answers['score_forecast#framing-excusal']).toEqual({
      type: 'noul',
      noul: 0.1,
      probabilities: { false: 0.9, true: 0.1 },
    });
    expect(fakeModels.calls).toEqual([{ file: '/a.jpg', model: 'culling-model', questions: Object.keys(QUESTIONS) }]);
  });

  it('takes the image as a data: URL too, and the state left out', async () => {
    const res = await post({ model: 'forecast-model', images: [`data:image/jpeg;base64,${b64()}`], questions: QUESTIONS });
    expect(res.status).toBe(200);
    expect(fakeModels.calls[0]).toMatchObject({ file: '/a.jpg', model: 'forecast-model' });
  });

  it('refuses state text and anything but one image', async () => {
    expect((await post({ model: 'culling-model', state: 'The attached photograph.', images: [b64()], questions: QUESTIONS })).status).toBe(422);
    expect((await post({ model: 'culling-model', images: [b64(), b64()], questions: QUESTIONS })).status).toBe(422);
    expect((await post({ model: 'culling-model', images: [], questions: QUESTIONS })).status).toBe(422);
    expect((await post({ model: 'culling-model', images: [b64()], questions: {} })).status).toBe(422);
    expect(fakeModels.starts).toBe(0);
  });

  it('a model it does not serve is 404; a forecast model not exported names the setup step', async () => {
    let res = await post({ model: 'jev-latest', images: [b64()], questions: QUESTIONS });
    expect(res.status).toBe(404);
    rmSync(join(modelsDir, 'forecast-model'), { recursive: true });
    res = await post({ model: 'forecast-model', images: [b64()], questions: QUESTIONS });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain(APP_MODEL_SETUP_COMMAND);
  });

  it('a photo the worker cannot answer is 422; the worker dying is 503, and the next request starts another', async () => {
    fakeModels.failOn = 'a';
    let res = await post({ model: 'culling-model', images: [b64()], questions: QUESTIONS });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('decode failed');

    Object.assign(fakeModels, { failOn: null, dieOn: 'a' });
    res = await post({ model: 'culling-model', images: [b64()], questions: QUESTIONS });
    expect(res.status).toBe(503);
    Object.assign(fakeModels, { dieOn: null, broken: false });
    res = await post({ model: 'culling-model', images: [b64()], questions: QUESTIONS });
    expect(res.status).toBe(200);
    expect(fakeModels.starts).toBe(2);
  });

  it('a worker that cannot start is 503', async () => {
    fakeModels.startError = new Error('Models failed to load (bad graph)');
    const res = await post({ model: 'culling-model', images: [b64()], questions: QUESTIONS });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain('bad graph');
  });
});

describe('the worker’s lifetime', () => {
  it('starts on the first answer, serves the next from the same worker, and closes when idle', async () => {
    const models = new AppModels(() => modelsDir, 30);
    const image = new Uint8Array(readFileSync(photo));
    const q = { 'x#7|connotation': QUESTIONS['culling_profile:default:7#7|connotation'] as never };
    await models.list();
    expect(fakeModels.starts).toBe(0);
    await models.answer('culling-model', image, q);
    await models.answer('forecast-model', image, q);
    expect(fakeModels.starts).toBe(1);
    await new Promise((r) => setTimeout(r, 80));
    expect(fakeModels.closed).toBe(1);
    await models.answer('culling-model', image, q);
    expect(fakeModels.starts).toBe(2);
    await models.close();
  });
});
