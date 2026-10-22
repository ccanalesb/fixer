/**
 * `/api/app-models`: the models installed in this app with their conversion jobs, adding one, and the
 * folder dialog. Jobs go to a temp `visualizer.db`; nothing is converted here (see laya-install.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { getJob, initJobsDb } from '../src/db/jobs/jobs.js';
import { writeFakeLayaModels } from './helpers/fake-laya.js';

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
  writeFileSync(join(dir, 'config.yaml'), `laya_models_dir: ${modelsDir}\n`);
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
    writeFakeLayaModels(modelsDir);
    const body = await json<Listed>(await app.request('/api/app-models'));
    expect(body.models).toEqual([
      {
        name: 'laya-base',
        source: 'thaitea/laya-vision',
        revision: '8b318c99d7ad3ce19c24369263463882eada9d1e',
        status: 'ready',
        job_id: null,
      },
      { name: 'laya-new', source: '/somewhere/best', revision: null, status: 'ready', job_id: null },
    ]);
  });
});

describe('POST /api/app-models', () => {
  it('queues the conversion job and lists the model as converting', async () => {
    const res = await add('thaitea/laya-vision');
    expect(res.status).toBe(200);
    const { name, job_id } = await json<{ name: string; job_id: string }>(res);
    expect(name).toBe('laya-base');
    const db = initJobsDb(join(dir, 'visualizer.db'));
    try {
      expect(getJob(db, job_id)).toMatchObject({ type: 'laya_model_install', status: 'pending' });
    } finally {
      db.close();
    }
    const body = await json<Listed>(await app.request('/api/app-models'));
    expect(body.models).toEqual([
      { name: 'laya-base', source: 'thaitea/laya-vision', revision: null, status: 'converting', job_id },
    ]);
  });

  it('names a folder after it, and a name taken by an installed model gets -2', async () => {
    writeFakeLayaModels(modelsDir);
    const best = join(dir, 'laya-run', 'best');
    mkdirSync(best, { recursive: true });
    expect(await json(await add(best))).toMatchObject({ name: 'laya-run-best' });
    expect(await json(await add('thaitea/laya-vision@8b318c9'))).toMatchObject({ name: 'laya-base-2' });
  });

  it('refuses what is not a folder or a Hugging Face id (400), and a source already converting (409)', async () => {
    let res = await add(join(dir, 'nowhere'));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: `No folder at ${join(dir, 'nowhere')}` });
    expect((await add('laya')).status).toBe(400);
    expect((await add(42)).status).toBe(422);
    expect((await add('thaitea/laya-vision')).status).toBe(200);
    res = await add('thaitea/laya-vision');
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: 'Already converting as laya-base' });
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
