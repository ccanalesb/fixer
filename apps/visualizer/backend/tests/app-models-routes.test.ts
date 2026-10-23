/**
 * `/api/app-models`: the models installed in this app with their conversion jobs, adding one, and the
 * folder dialog. Jobs go to a temp `visualizer.db`; nothing is converted here (see app-model-install.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { getJob, initJobsDb } from '../src/db/jobs/jobs.js';
import { writeFakeAppModels } from './helpers/fake-app-models.js';

let dir: string;
let modelsDir: string;
const app = createApp();
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const add = (source: unknown) =>
  app.request('/api/app-models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source }),
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-app-models-'));
  modelsDir = join(dir, 'models');
  writeFileSync(join(dir, 'config.yaml'), `app_models_dir: ${modelsDir}\n`);
  process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
  process.env.DATABASE_PATH = join(dir, 'visualizer.db');
});

afterEach(() => {
  delete process.env.LT_CONFIG_YAML;
  delete process.env.DATABASE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

type Listed = { models: { name: string; source: string | null; status: string; job_id: string | null }[] };

describe('GET /api/app-models', () => {
  it('lists nothing on a new install, and says whether the backend can open a folder dialog', async () => {
    const res = await app.request('/api/app-models');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ models: [], picker_available: process.platform === 'darwin' });
  });

  it('lists the installed models with their source and revision', async () => {
    writeFakeAppModels(modelsDir);
    const body = await json<Listed>(await app.request('/api/app-models'));
    expect(body.models).toEqual([
      {
        name: 'culling-model',
        source: 'owner/vision-model',
        revision: '8b318c99d7ad3ce19c24369263463882eada9d1e',
        status: 'ready',
        job_id: null,
      },
      { name: 'forecast-model', source: '/somewhere/best', revision: null, status: 'ready', job_id: null },
    ]);
  });
});

describe('POST /api/app-models', () => {
  it('queues the conversion job and lists the model as converting', async () => {
    const res = await add('owner/vision-model');
    expect(res.status).toBe(200);
    const { name, job_id } = await json<{ name: string; job_id: string }>(res);
    expect(name).toBe('vision-model');
    const db = initJobsDb(join(dir, 'visualizer.db'));
    try {
      expect(getJob(db, job_id)).toMatchObject({ type: 'app_model_install', status: 'pending' });
    } finally {
      db.close();
    }
    const body = await json<Listed>(await app.request('/api/app-models'));
    expect(body.models).toEqual([
      { name: 'vision-model', source: 'owner/vision-model', revision: null, status: 'converting', job_id },
    ]);
  });

  it('names a folder after it, and a name taken by an installed model gets -2', async () => {
    writeFakeAppModels(modelsDir);
    const best = join(dir, 'my-run', 'best');
    mkdirSync(best, { recursive: true });
    expect(await json(await add(best))).toMatchObject({ name: 'my-run-best' });
    expect(await json(await add('owner/culling-model@8b318c9'))).toMatchObject({ name: 'culling-model-2' });
  });

  it('refuses what is not a folder or a Hugging Face id (400), and a source already converting (409)', async () => {
    let res = await add(join(dir, 'nowhere'));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: `No folder at ${join(dir, 'nowhere')}` });
    expect((await add('vision')).status).toBe(400);
    expect((await add(42)).status).toBe(422);
    expect((await add('owner/vision-model')).status).toBe(200);
    res = await add('owner/vision-model');
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: 'Already converting as vision-model' });
  });
});

// Opening the dialog for real would block the suite on a human, so the only
// branch testable here is the one where there is no dialog to open.
describe('POST /api/app-models/pick', () => {
  it('answers 501 on a platform without a native dialog', async () => {
    const real = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const res = await app.request('/api/app-models/pick', { method: 'POST' });
      expect(res.status).toBe(501);
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true });
    }
  });
});
