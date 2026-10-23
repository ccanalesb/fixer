/**
 * `batch_redecide_cull_verdicts_from_stored_answers` — threshold/profile changes, no model call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { LibraryFixture } from './helpers/library-fixture.js';
import { fakeModelRuntimeModule, fakeModelState, THIS_APP_MODELS_YAML, writeFakeAppModels, writeFakePhoto } from './helpers/fake-app-models.js';
import { closeAppModels } from '../src/app-models/app-models.js';
import { createJob, getJob, getPendingJobs, initJobsDb } from '../src/db/jobs/jobs.js';
import type { Db } from '../src/db/connection.js';
import { JobRunner } from '../src/jobs/runner.js';
import { tick } from '../src/jobs/processor.js';
import { openLibraryDb } from '../src/db/connection.js';
import { createPipelineSettingVersion, getCurrentPipelineSetting } from '../src/db/library/cull-pipeline.js';
import { seedCullingDefaults, getCullProfile, setProfileRule } from '../src/db/library/cull-profiles.js';
import { recordCullUserAction } from '../src/db/library/cull-user-actions.js';
import { enqueueRedecideCullVerdicts, BATCH_REDECIDE_JOB_TYPE } from '../src/jobs/handlers/redecide.js';
import type { PipelineSettingConfig } from '../src/cull/types.js';

type Script = { levels: [number, number, number, number]; p8: number };
const PASS: Script = { levels: [5, 5, 6, 6], p8: 0.5 };
const FORECAST_BORDER: Script = { levels: [5, 5, 6, 6], p8: 0.12 };
const PROFILE_CUT: Script = { levels: [5, 5, 3, 3], p8: 0.5 };
const FORECAST_CUT: Script = { levels: [5, 5, 6, 6], p8: 0.05 };

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

async function addPhoto(key: string, script: Script): Promise<void> {
  const path = join(dir, 'vision', `${key}.jpg`);
  await writeFakePhoto(path, key);
  fx.addImage({ key, filepath: `/missing/${key}.NEF` }).addVisionCache(key, path);
  fakeModels.scripts.set(key, script);
}

async function runCull(): Promise<void> {
  await withJobsDb(async (db) => {
    const jobId = createJob(db, 'batch_cull_photos_before_scoring', {});
    await tick(db, new JobRunner(db));
    expect(getJob(db, jobId)!.status).toBe('completed');
  });
}

async function runRedecide(opts: { cancelAfterProgress?: string } = {}) {
  return withJobsDb(async (db) => {
    const jobId = createJob(db, BATCH_REDECIDE_JOB_TYPE, {});
    const runner = new JobRunner(db, (_id, _p, step) => {
      if (opts.cancelAfterProgress && step.includes(opts.cancelAfterProgress)) runner.signalCancel(jobId);
    });
    await tick(db, runner);
    return getJob(db, jobId)!;
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lt-redecide-'));
  mkdirSync(join(dir, 'vision'), { recursive: true });
  jobsDbPath = join(dir, 'visualizer.db');
  modelsDir = join(dir, 'models');
  writeFakeAppModels(modelsDir);
  fx = new LibraryFixture().cullingStagesOn().addForecastQuestions().activate();
  process.env.DATABASE_PATH = jobsDbPath;
  writeFileSync(
    join(dir, 'config.yaml'),
    `vision_cache_dir: ${join(dir, 'vision')}\napp_models_dir: ${modelsDir}\n${THIS_APP_MODELS_YAML}`,
  );
  process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
  Object.assign(fakeModels, fakeModelState());
});

afterEach(async () => {
  await closeAppModels();
  delete process.env.DATABASE_PATH;
  delete process.env.LT_CONFIG_YAML;
  fx.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe('batch_redecide_cull_verdicts_from_stored_answers', () => {
  it('changes verdicts after a threshold change with no model call (models dir deleted)', async () => {
    await addPhoto('a', PASS);
    await addPhoto('b', PASS);
    await addPhoto('c', FORECAST_BORDER);
    await runCull();
    fakeModels.calls.length = 0;
    fakeModels.starts = 0;
    const lib = openLibraryDb(fx.dbPath);
    seedCullingDefaults(lib);
    createPipelineSettingVersion(lib, {
      ...getCurrentPipelineSetting(lib).config,
      score_forecast: { ...getCurrentPipelineSetting(lib).config.score_forecast, threshold: 0.99 },
    });
    lib.close();
    rmSync(modelsDir, { recursive: true, force: true });

    const job = await runRedecide();
    expect(job.status).toBe('completed');
    const r = job.result as { changed: number };
    expect(r.changed).toBeGreaterThanOrEqual(1);
    expect(fx.query("SELECT verdict FROM cull_verdicts WHERE image_key = 'c'")[0]?.verdict).toBe('filtered');
    expect(fakeModels.calls.length).toBe(0);
    expect(fakeModels.starts).toBe(0);
  });

  it('profile rule change via setProfileRule flips profile filters', async () => {
    await addPhoto('a', PASS);
    await runCull();
    expect(fx.query("SELECT verdict FROM cull_verdicts WHERE image_key = 'a'")[0]?.verdict).toBe('passed');
    const lib = openLibraryDb(fx.dbPath);
    const base = getCullProfile(lib, 'default')!.rule;
    setProfileRule(lib, 'default', {
      ...base,
      combine: 'any',
      filter_rule: { type: 'mean_fail' },
      level_sets: {
        ...base.level_sets,
        '10': { fails_at_most: 6, strong_at_least: base.level_sets['10']!.strong_at_least },
      },
    });
    lib.close();
    fakeModels.calls.length = 0;
    const job = await runRedecide();
    expect((job.result as { changed: number }).changed).toBeGreaterThanOrEqual(1);
    expect(fx.query("SELECT verdict FROM cull_verdicts WHERE image_key = 'a'")[0]?.verdict).toBe('filtered');
    expect(fakeModels.calls.length).toBe(0);
  });

  it('a switch change re-decides every photo from stored answers, with no model call', async () => {
    await addPhoto('p', PROFILE_CUT);
    await addPhoto('f', FORECAST_CUT);
    await runCull();
    rmSync(modelsDir, { recursive: true, force: true });
    fakeModels.calls.length = 0;
    const rows = () =>
      fx.query('SELECT image_key, verdict, filtered_by, culling_profile_verdict FROM cull_verdicts ORDER BY image_key');
    const switchTo = async (change: Partial<PipelineSettingConfig>, forecastEnabled = true) => {
      const lib = openLibraryDb(fx.dbPath);
      const cfg = getCurrentPipelineSetting(lib).config;
      createPipelineSettingVersion(lib, { ...cfg, ...change, score_forecast: { ...cfg.score_forecast, enabled: forecastEnabled } });
      lib.close();
      expect((await runRedecide()).status).toBe('completed');
    };
    expect(rows()).toEqual([
      { image_key: 'f', verdict: 'filtered', filtered_by: 'score_forecast', culling_profile_verdict: 'passed' },
      { image_key: 'p', verdict: 'filtered', filtered_by: 'culling_profile', culling_profile_verdict: 'filtered' },
    ]);

    await switchTo({ culling_profiles_filter_enabled: false });
    expect(rows()).toEqual([
      { image_key: 'f', verdict: 'filtered', filtered_by: 'score_forecast', culling_profile_verdict: 'passed' },
      { image_key: 'p', verdict: 'passed', filtered_by: null, culling_profile_verdict: 'filtered' },
    ]);

    await switchTo({ culling_profiles_filter_enabled: true }, false);
    expect(rows()).toEqual([
      { image_key: 'f', verdict: 'passed', filtered_by: null, culling_profile_verdict: 'passed' },
      { image_key: 'p', verdict: 'filtered', filtered_by: 'culling_profile', culling_profile_verdict: 'filtered' },
    ]);

    await switchTo({ culling_profiles_enabled: false });
    expect(rows()).toEqual([
      { image_key: 'f', verdict: 'filtered', filtered_by: 'score_forecast', culling_profile_verdict: null },
      { image_key: 'p', verdict: 'passed', filtered_by: null, culling_profile_verdict: null },
    ]);
    expect(fakeModels.calls).toEqual([]);
  });

  it('keeps sent-by-hand passed and preserves pending_reason', async () => {
    await addPhoto('filtered', PROFILE_CUT);
    await addPhoto('pend', PASS);
    fakeModels.failOn = 'pend';
    await runCull();
    fakeModels.failOn = null;
    const lib = openLibraryDb(fx.dbPath);
    recordCullUserAction(lib, 'filtered', 'sent_by_hand');
    lib.close();
    const pendingReason = fx.query<{ pending_reason: string }>(
      "SELECT pending_reason FROM cull_verdicts WHERE image_key = 'pend'",
    )[0]!.pending_reason;
    expect(pendingReason).toContain('model_failed: Culling profile:');

    const lib2 = openLibraryDb(fx.dbPath);
    createPipelineSettingVersion(lib2, getCurrentPipelineSetting(lib2).config);
    lib2.close();
    const job = await runRedecide();
    expect(job.status).toBe('completed');
    expect(fx.query("SELECT verdict FROM cull_verdicts WHERE image_key = 'filtered'")[0]?.verdict).toBe('passed');
    expect(fx.query("SELECT pending_reason FROM cull_verdicts WHERE image_key = 'pend'")[0]?.pending_reason).toBe(
      pendingReason,
    );
  });

  it('runs queued behind an earlier job in one tick', async () => {
    await withJobsDb(async (db) => {
      const scoreId = createJob(db, 'batch_score', { perspective_slugs: ['street'] });
      const redecideId = createJob(db, BATCH_REDECIDE_JOB_TYPE, {});
      await tick(db, new JobRunner(db));
      const score = getJob(db, scoreId)!;
      const redecide = getJob(db, redecideId)!;
      expect(score.status).toBe('completed');
      expect(redecide.status).toBe('completed');
      expect(score.started_at! <= redecide.started_at!).toBe(true);
    });
  });

  it('enqueueRedecideCullVerdicts dedupes pending rows', async () => {
    await withJobsDb(async (db) => {
      expect(enqueueRedecideCullVerdicts(db, 'a')).toBeTruthy();
      expect(enqueueRedecideCullVerdicts(db, 'b')).toBeNull();
      expect(getPendingJobs(db).filter((j) => j.type === BATCH_REDECIDE_JOB_TYPE)).toHaveLength(1);
    });
  });

  it('completes with zeros when nothing was ever culled', async () => {
    const job = await runRedecide();
    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({ total: 0, changed: 0 });
  });

  it('cancel between chunks keeps written chunks consistent', async () => {
    await addPhoto('_seed', PASS);
    await runCull();
    fx.exec("DELETE FROM cull_verdicts WHERE image_key = '_seed'");
    fx.exec("DELETE FROM cull_stage_answers WHERE image_key = '_seed'");
    const filepath = join(dir, 'bulk.jpg');
    await sharp({ create: { width: 4, height: 4, channels: 3, background: '#111' } }).jpeg().toFile(filepath);
    for (let i = 0; i < 501; i++) {
      const key = `k${String(i).padStart(3, '0')}`;
      fx.addImage({ key, filepath });
      fx.exec(
        `INSERT INTO cull_verdicts (image_key, verdict, pipeline_setting_version, decided_at, pending_reason, pending_stages, stage_version_ids, sent_by_hand, score_forecast_off)
         VALUES (?, 'passed', 1, datetime('now'), '', '[]', '[]', 0, 0)`,
        key,
      );
    }
    const lib = openLibraryDb(fx.dbPath);
    seedCullingDefaults(lib);
    createPipelineSettingVersion(lib, getCurrentPipelineSetting(lib).config);
    lib.close();

    const job = await runRedecide({ cancelAfterProgress: '500/501' });
    expect(job.status).toBe('cancelled');
    expect(fx.query('SELECT COUNT(*) AS n FROM cull_verdicts')[0]?.n).toBe(501);
  });
});
