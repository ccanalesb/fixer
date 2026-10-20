/**
 * `batch_redecide_cull_verdicts_from_stored_answers` — threshold changes, no Laya.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { LibraryFixture } from './helpers/library-fixture.js';
import type { LayaAnswerWant } from '../src/laya/sessions.js';
import { fakeLayaRuntimeModule, writeFakeLayaModels } from './helpers/fake-laya.js';
import { createJob, getJob, getPendingJobs, initJobsDb } from '../src/db/jobs/jobs.js';
import type { Db } from '../src/db/connection.js';
import { JobRunner } from '../src/jobs/runner.js';
import { tick } from '../src/jobs/processor.js';
import { openLibraryDb } from '../src/db/connection.js';
import { createPipelineSettingVersion, getCurrentPipelineSetting } from '../src/db/library/cull-pipeline.js';
import { seedCullingDefaults } from '../src/db/library/cull-recipes.js';
import { enqueueRedecideCullVerdicts, BATCH_REDECIDE_JOB_TYPE } from '../src/jobs/handlers/redecide.js';

const laya = vi.hoisted(() => ({
  scripts: new Map<string, { levels: [number, number, number, number]; p8: number }>(),
  calls: [] as { file: string; want: LayaAnswerWant | undefined }[],
  starts: 0,
  closed: 0,
  forecastOn: true,
  failOn: null as null | string,
  dieOn: null as null | string,
  broken: false,
  startError: null as null | Error,
  cancelAfter: null as null | (() => void),
  sequence: [] as string[],
}));

vi.mock('../src/laya/runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/laya/runtime.js')>();
  return fakeLayaRuntimeModule(actual, laya);
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

async function runCull(): Promise<void> {
  await withJobsDb(async (db) => {
    const jobId = createJob(db, 'batch_cull_photos_before_scoring', {});
    await tick(db, new JobRunner(db));
    expect(getJob(db, jobId)!.status).toBe('completed');
  });
}

async function runRedecide() {
  return withJobsDb(async (db) => {
    const jobId = createJob(db, BATCH_REDECIDE_JOB_TYPE, {});
    await tick(db, new JobRunner(db));
    const job = getJob(db, jobId);
    expect(job).toBeTruthy();
    return job!;
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lt-redecide-'));
  jobsDbPath = join(dir, 'visualizer.db');
  modelsDir = join(dir, 'models');
  writeFakeLayaModels(modelsDir);
  fx = new LibraryFixture().activate();
  process.env.DATABASE_PATH = jobsDbPath;
  writeFileSync(
    join(dir, 'config.yaml'),
    `vision_cache_dir: ${join(dir, 'vision')}\nlaya_models_dir: ${modelsDir}\n`,
  );
  process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
  laya.scripts.clear();
  laya.calls.length = 0;
  laya.starts = 0;
  const path = join(dir, 'a.jpg');
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#888' } }).jpeg().toFile(path);
  fx.addImage({ key: 'a', filepath: path });
  laya.scripts.set('a', { levels: [5, 5, 6, 6], p8: 0.12 });
});

afterEach(() => {
  delete process.env.DATABASE_PATH;
  delete process.env.LT_CONFIG_YAML;
  fx.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe('batch_redecide_cull_verdicts_from_stored_answers', () => {
  it('changes verdicts after a threshold change with no model call', async () => {
    await runCull();
    laya.calls.length = 0;
    laya.starts = 0;
    const lib = openLibraryDb(fx.dbPath);
    seedCullingDefaults(lib);
    const cfg = getCurrentPipelineSetting(lib).config;
    createPipelineSettingVersion(lib, {
      ...cfg,
      score_forecast: { ...cfg.score_forecast, threshold: 0.99 },
    });
    lib.close();

    const job = await runRedecide();
    expect(job.status).toBe('completed');
    expect((job.result as { changed: number }).changed).toBeGreaterThanOrEqual(1);
    expect(laya.calls.length).toBe(0);
    expect(laya.starts).toBe(0);
  });

  it('enqueueRedecideCullVerdicts dedupes pending rows', async () => {
    await withJobsDb(async (db) => {
      expect(enqueueRedecideCullVerdicts(db, 'a')).toBeTruthy();
      expect(enqueueRedecideCullVerdicts(db, 'b')).toBeNull();
      expect(getPendingJobs(db).filter((j) => j.type === BATCH_REDECIDE_JOB_TYPE)).toHaveLength(1);
    });
  });
});
