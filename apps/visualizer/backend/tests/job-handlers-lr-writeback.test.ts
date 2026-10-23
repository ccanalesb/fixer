/**
 * Job hooks enqueue Lightroom write-back.
 * Hermetic: temp config, fake models + mocked runtime, temp library.db — never repo models/.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLibraryDb } from '../src/db/connection.js';
import { patchLrWritebackSettings } from '../src/db/library/lr-writeback-settings.js';
import { seedCullingDefaults } from '../src/db/library/cull-profiles.js';
import { createJob, getJob, getPendingJobs, initJobsDb } from '../src/db/jobs/jobs.js';
import { LR_WRITEBACK_JOB_TYPE } from '../src/jobs/handlers/lr-writeback.js';
import { JobRunner } from '../src/jobs/runner.js';
import { tick } from '../src/jobs/processor.js';
import { fakeModelState, THIS_APP_MODELS_YAML, writeFakeAppModels } from './helpers/fake-app-models.js';
import { closeAppModels } from '../src/app-models/app-models.js';
import { LibraryFixture } from './helpers/library-fixture.js';
import { makeFakeCatalog } from './helpers/fake-catalog.js';

type ModelScript = { levels: [number, number, number, number]; p8: number };

const fakeModels = vi.hoisted(() => ({}) as import('./helpers/fake-app-models.js').FakeModelState);

vi.mock('../src/app-models/runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app-models/runtime.js')>();
  const { fakeModelRuntimeModule } = await import('./helpers/fake-app-models.js');
  return fakeModelRuntimeModule(actual, fakeModels);
});

let fx: LibraryFixture;
let dir: string;
let jobsDbPath: string;
let modelsDir: string;

beforeEach(() => {
  fx = new LibraryFixture().addForecastQuestions().activate();
  dir = mkdtempSync(join(tmpdir(), 'lt-lrw-job-'));
  jobsDbPath = join(dir, 'visualizer.db');
  modelsDir = join(dir, 'models');
  mkdirSync(join(dir, 'vision'), { recursive: true });
  writeFakeAppModels(modelsDir);
  const lrcat = join(dir, 'c.lrcat');
  makeFakeCatalog(lrcat, []);
  process.env.DATABASE_PATH = jobsDbPath;
  writeFileSync(
    join(dir, 'config.yaml'),
    [
      `vision_cache_dir: ${join(dir, 'vision')}`,
      `app_models_dir: ${modelsDir}`,
      `catalog_path: ${lrcat}`,
      THIS_APP_MODELS_YAML,
    ].join('\n'),
  );
  process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
  const db = openLibraryDb(fx.dbPath);
  seedCullingDefaults(db);
  patchLrWritebackSettings(db, { write_reject: true });
  db.close();
  Object.assign(fakeModels, fakeModelState());
  fakeModels.sequence.length = 0;
});

afterEach(async () => {
  await closeAppModels();
  fx.cleanup();
  delete process.env.DATABASE_PATH;
  delete process.env.LT_CONFIG_YAML;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('standalone cull job writeback hook', () => {
  it('enqueues lr_writeback when switches are on', async () => {
    const jobsDb = initJobsDb(jobsDbPath);
    const jobId = createJob(jobsDb, 'batch_cull_photos_before_scoring', { image_keys: [] });
    await tick(jobsDb, new JobRunner(jobsDb));
    const job = getJob(jobsDb, jobId)!;
    expect(job.status).toBe('completed');
    const lrPending = getPendingJobs(jobsDb).filter((j) => j.type === LR_WRITEBACK_JOB_TYPE);
    expect(lrPending).toHaveLength(1);
    jobsDb.close();
  });
});

describe('redecide hook', () => {
  it('enqueues lr_writeback after redecide completes', async () => {
    vi.spyOn(await import('../src/cull/redecide.js'), 'redecideAllPhotos').mockResolvedValue({
      total: 0,
      changed: 0,
      filtered_by_culling_profile: 0,
      filtered_by_score_forecast: 0,
      pending: 0,
      passed: 0,
      sent_by_hand_passed: 0,
      pipeline_setting_version: 1,
      stage_versions: {},
      durations_s: { redecide: 0, total: 0 },
    });
    const jobsDb = initJobsDb(jobsDbPath);
    const jobId = createJob(jobsDb, 'batch_redecide_cull_verdicts_from_stored_answers', {});
    await tick(jobsDb, new JobRunner(jobsDb));
    expect(getJob(jobsDb, jobId)!.status).toBe('completed');
    const lrPending = getPendingJobs(jobsDb).filter((j) => j.type === LR_WRITEBACK_JOB_TYPE);
    expect(lrPending).toHaveLength(1);
    jobsDb.close();
  });
});
