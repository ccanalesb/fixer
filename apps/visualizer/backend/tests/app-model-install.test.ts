/**
 * Installing a model into this app: the source and name rules, the list with its conversion jobs, and
 * the `app_model_install` job. A fake `uv` on PATH stands in for the conversion script, so the real
 * child process, its output, cancellation and cleanup are exercised without converting anything.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../src/db/connection.js';
import { createJob, getJob, initJobsDb, updateJobStatus } from '../src/db/jobs/jobs.js';
import { JobRunner } from '../src/jobs/runner.js';
import { recoverOrphanedJobs, tick } from '../src/jobs/processor.js';
import { transitionCancel } from '../src/jobs/transitions.js';
import { CONVERSION_OFFLINE_MESSAGE, CONVERTER_PREP_STEP } from '../src/app-models/conversion-run.js';
import { stopRunningConversions } from '../src/jobs/handlers/app-model-install.js';
import {
  APP_MODEL_INSTALL_JOB_TYPE,
  AppModelSourceError,
  addAppModel,
  listAppModels,
  modelNameFor,
  parseModelSource,
} from '../src/app-models/install.js';

const FAKE_UV = join(dirname(fileURLToPath(import.meta.url)), 'helpers/fake-uv.mjs');

let dir: string;
let modelsDir: string;
let db: Db;
const originalPath = process.env.PATH;
const originalDataDir = process.env.LT_DATA_DIR;
const originalResourcesDir = process.env.LT_RESOURCES_DIR;
const originalUvWrapper = process.env.LT_UV_TEST_WRAPPER;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-install-'));
  modelsDir = join(dir, 'models');
  mkdirSync(modelsDir, { recursive: true });
  process.env.LT_UV_TEST_WRAPPER = FAKE_UV;
  process.env.PATH = originalPath;
  writeFileSync(join(dir, 'config.yaml'), `app_models_dir: ${modelsDir}\n`);
  process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
  db = initJobsDb(join(dir, 'visualizer.db'));
});

afterEach(() => {
  db.close();
  process.env.PATH = originalPath;
  if (originalUvWrapper === undefined) delete process.env.LT_UV_TEST_WRAPPER;
  else process.env.LT_UV_TEST_WRAPPER = originalUvWrapper;
  delete process.env.LT_CONFIG_YAML;
  if (originalDataDir === undefined) delete process.env.LT_DATA_DIR;
  else process.env.LT_DATA_DIR = originalDataDir;
  if (originalResourcesDir === undefined) delete process.env.LT_RESOURCES_DIR;
  else process.env.LT_RESOURCES_DIR = originalResourcesDir;
  rmSync(dir, { recursive: true, force: true });
});

const folder = (rel: string) => {
  const p = join(dir, rel);
  mkdirSync(p, { recursive: true });
  return p;
};
const run = () => tick(db, new JobRunner(db));
const job = (id: string) => getJob(db, id)!;
const names = () => listAppModels(modelsDir, db).map((m) => [m.name, m.status]);

describe('the source', () => {
  it('is a folder when it is a path, and must be one', () => {
    const p = folder('my-run/best');
    expect(parseModelSource(p)).toEqual({ kind: 'folder', source: p });
    expect(parseModelSource(`  '${p}'  `)).toEqual({ kind: 'folder', source: p });
    expect(parseModelSource('~/')).toEqual({ kind: 'folder', source: homedir() });
    expect(() => parseModelSource(join(dir, 'nowhere'))).toThrow(`No folder at ${join(dir, 'nowhere')}`);
    writeFileSync(join(dir, 'file'), '');
    expect(() => parseModelSource(join(dir, 'file'))).toThrow(AppModelSourceError);
  });

  it('is a Hugging Face id otherwise, with or without a revision', () => {
    expect(parseModelSource('owner/vision-model')).toEqual({ kind: 'hugging_face', source: 'owner/vision-model' });
    expect(parseModelSource('owner/vision-model@8b318c9')).toEqual({
      kind: 'hugging_face',
      source: 'owner/vision-model@8b318c9',
    });
    for (const bad of ['', 'vision', 'a/b/c', 'owner/vision model', 'owner/vision-model@']) {
      expect(() => parseModelSource(bad), bad).toThrow(AppModelSourceError);
    }
  });
});

describe('the name', () => {
  const name = (raw: string, taken: string[] = []) => modelNameFor(parseModelSource(raw), new Set(taken));

  it('is the repo name of a Hugging Face model, without its revision', () => {
    expect(name('owner/vision-model')).toBe('vision-model');
    expect(name('Owner/Vision-Model@8b318c9')).toBe('vision-model');
    expect(name('someone/My_Model.v2@main')).toBe('my_model.v2');
  });

  it('is the folder’s name, with its parent’s before a generic one', () => {
    expect(name(folder('models/vision-model'))).toBe('vision-model');
    expect(name(folder('my-run/best'))).toBe('my-run-best');
    expect(name(folder('run 3/checkpoint-1200'))).toBe('run-3-checkpoint-1200');
    expect(name(folder('x/Final'))).toBe('x-final');
  });

  it('gets -2, -3… when the name is taken', () => {
    expect(name('owner/vision-model', ['vision-model'])).toBe('vision-model-2');
    expect(name('owner/vision-model', ['vision-model', 'vision-model-2'])).toBe('vision-model-3');
  });
});

describe('adding a model', () => {
  it('queues one conversion job and lists the model as converting until it is installed', async () => {
    const added = addAppModel(db, modelsDir, 'owner/vision-model');
    expect(added.name).toBe('vision-model');
    expect(job(added.job_id)).toMatchObject({
      type: APP_MODEL_INSTALL_JOB_TYPE,
      status: 'pending',
      metadata: { source: 'owner/vision-model', name: 'vision-model' },
    });
    expect(listAppModels(modelsDir, db)).toEqual([
      { name: 'vision-model', source: 'owner/vision-model', revision: null, status: 'converting', job_id: added.job_id },
    ]);

    await run();
    expect(job(added.job_id).status).toBe('completed');
    expect(listAppModels(modelsDir, db)).toEqual([
      { name: 'vision-model', source: 'owner/vision-model', revision: 'abc1234', status: 'ready', job_id: added.job_id },
    ]);
  });

  it('refuses a source already converting, and gives the same source a new name once it is installed', async () => {
    const first = addAppModel(db, modelsDir, 'owner/vision-model');
    expect(() => addAppModel(db, modelsDir, 'owner/vision-model')).toThrow('Already converting as vision-model');
    await run();
    expect(job(first.job_id).status).toBe('completed');
    expect(addAppModel(db, modelsDir, 'owner/vision-model').name).toBe('vision-model-2');
  });

  it('does not list a failed or cancelled conversion', () => {
    const a = addAppModel(db, modelsDir, 'someone/a');
    const b = addAppModel(db, modelsDir, 'someone/b');
    updateJobStatus(db, a.job_id, 'failed');
    updateJobStatus(db, b.job_id, 'cancelled');
    expect(names()).toEqual([]);
    expect(addAppModel(db, modelsDir, 'someone/a').name).toBe('a');
  });
});

describe('the conversion job', () => {
  it('runs the script through uv and shows its steps', async () => {
    const src = folder('my-run/best');
    const { job_id } = addAppModel(db, modelsDir, src);
    await run();
    const j = getJob(db, job_id, { logsLimit: 50 })!;
    expect(j.status).toBe('completed');
    expect(j.result).toMatchObject({ name: 'my-run-best', source: src, revision: null });
    const messages = j.logs.map((l) => l.message);
    expect(messages).toContain('loading the model');
    expect(messages).not.toContain('step: loading the model');
    expect(messages).not.toContain('');
    expect(names()).toEqual([['my-run-best', 'ready']]);
  });

  it('a folder of another architecture fails with the cause, and nothing half-written is listed or left', async () => {
    const { job_id } = addAppModel(db, modelsDir, folder('downloads/not-supported'));
    await run();
    expect(job(job_id).status).toBe('failed');
    expect(job(job_id).error).toBe(`${join(dir, 'downloads/not-supported')} is not a model this app converts: it has no vlm_agent_config.json`);
    expect(names()).toEqual([]);
    expect(readdirSync(modelsDir)).toEqual([]);
  });

  it('a parity check above tolerance and an unexpected crash say so', async () => {
    const parity = addAppModel(db, modelsDir, 'someone/parity');
    await run();
    expect(job(parity.job_id).error).toBe(
      'Parity check failed: decoder: the ONNX graph differs from PyTorch by 2.00e-02, above 0.001',
    );
    const crash = addAppModel(db, modelsDir, 'someone/crash');
    await run();
    expect(job(crash.job_id).error).toBe(
      'The conversion failed (exit code 1): Traceback (most recent call last): · RuntimeError: out of memory',
    );
    expect(readdirSync(modelsDir)).toEqual([]);
  });

  it('without uv, says that uv is missing', async () => {
    delete process.env.LT_UV_TEST_WRAPPER;
    process.env.PATH = join(dir, 'empty');
    const { job_id } = addAppModel(db, modelsDir, 'someone/a');
    await run();
    expect(job(job_id).status).toBe('failed');
    expect(job(job_id).error).toMatch(/^uv is not installed/);
  });

  it(
    'is cancellable: the conversion is stopped and its files removed',
    async () => {
      const { job_id } = addAppModel(db, modelsDir, 'someone/slow');
      const running = run();
      while (!existsSync(join(modelsDir, '.slow-started'))) await new Promise((r) => setTimeout(r, 20));
      expect(job(job_id).current_step).toBe('exporting the decoder graph');
      transitionCancel(db, job_id);
      await running;
      expect(job(job_id).status).toBe('cancelled');
      expect(existsSync(join(modelsDir, '.install-slow'))).toBe(false);
      expect(names()).toEqual([]);
    },
    90_000,
  );

  it(
    'a backend that exits stops its conversion, so a resumed job is the only one writing',
    async () => {
      addAppModel(db, modelsDir, 'someone/slow');
      const running = run();
      while (!existsSync(join(modelsDir, '.slow-started'))) await new Promise((r) => setTimeout(r, 20));
      stopRunningConversions();
      await running;
      expect(existsSync(join(modelsDir, '.install-slow'))).toBe(false);
    },
    90_000,
  );

  it('resumes after a restart: re-queued, converted from the start', async () => {
    const { job_id } = addAppModel(db, modelsDir, 'someone/a');
    const runner = new JobRunner(db);
    runner.startJob(job_id, APP_MODEL_INSTALL_JOB_TYPE);
    runner.persistCheckpoint(job_id, { step: 'converting' });
    mkdirSync(join(modelsDir, '.install-a'), { recursive: true });
    expect(recoverOrphanedJobs(db)).toEqual([job_id]);
    expect(names()).toEqual([['a', 'converting']]);
    await run();
    expect(job(job_id).status).toBe('completed');
    expect(names()).toEqual([['a', 'ready']]);
  });

  it('a restart after the files were moved into place completes without converting again', async () => {
    const { job_id } = addAppModel(db, modelsDir, 'someone/a');
    await run();
    updateJobStatus(db, job_id, 'pending');
    process.env.PATH = join(dir, 'empty');
    await run();
    expect(job(job_id).status).toBe('completed');
  });

  it('a job queued by hand with no source fails saying so', async () => {
    const id = createJob(db, APP_MODEL_INSTALL_JOB_TYPE, {});
    await run();
    expect(job(id).error).toBe('app_model_install needs metadata.source and metadata.name');
  });

  it('starts on preparing the converter before the script speaks', async () => {
    const { job_id } = addAppModel(db, modelsDir, 'someone/prep-check');
    const running = run();
    while (getJob(db, job_id)?.current_step !== CONVERTER_PREP_STEP) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await running;
    expect(job(job_id).status).toBe('completed');
  });

  it('uses bundled uv, the resources folder as cwd, and uv dirs under the data folder', async () => {
    const data = join(dir, 'data');
    const resources = join(dir, 'resources');
    mkdirSync(join(resources, 'scripts', 'app-models'), { recursive: true });
    writeFileSync(join(resources, 'scripts', 'app-models', 'export_onnx.py'), '# stub');
    process.env.LT_DATA_DIR = data;
    process.env.LT_RESOURCES_DIR = resources;
    process.env.PATH = join(dir, 'empty');
    const { job_id } = addAppModel(db, modelsDir, 'someone/env-check');
    await run();
    const messages = getJob(db, job_id, { logsLimit: 20 })!.logs.map((l) => l.message);
    const resourcesReal = realpathSync(resources);
    expect(messages.some((m) => m === `meta: cwd=${resourcesReal}`)).toBe(true);
    expect(messages).toContain(`meta: UV_CACHE_DIR=${join(data, 'uv-cache')}`);
    expect(messages).toContain(`meta: UV_PYTHON_INSTALL_DIR=${join(data, 'python')}`);
    expect(job(job_id).status).toBe('completed');
  });

  it('when uv cannot fetch dependencies, says an internet connection is needed the first time', async () => {
    const { job_id } = addAppModel(db, modelsDir, 'someone/offline');
    await run();
    expect(job(job_id).status).toBe('failed');
    expect(job(job_id).error).toBe(CONVERSION_OFFLINE_MESSAGE);
  });
});
