/**
 * Job hooks invoke Lightroom write-back reconcile (#341).
 * Hermetic: temp config, fake Laya models + mocked runtime, temp library.db — never repo models/.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as writeback from '../src/lightroom/writeback.js';
import { openLibraryDb } from '../src/db/connection.js';
import { patchLrWritebackSettings } from '../src/db/library/lr-writeback-settings.js';
import { seedCullingDefaults } from '../src/db/library/cull-recipes.js';
import { createJob, getJob, initJobsDb } from '../src/db/jobs/jobs.js';
import { JobRunner } from '../src/jobs/runner.js';
import { tick } from '../src/jobs/processor.js';
import type { LayaAnswerWant } from '../src/laya/sessions.js';
import { writeFakeLayaModels } from './helpers/fake-laya.js';
import { LibraryFixture } from './helpers/library-fixture.js';
import { makeFakeCatalog } from './helpers/fake-catalog.js';

type LayaScript = { levels: [number, number, number, number]; p8: number };

const laya = vi.hoisted(() => ({
  scripts: new Map<string, LayaScript>(),
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
  const { fakeLayaRuntimeModule } = await import('./helpers/fake-laya.js');
  return fakeLayaRuntimeModule(actual, laya);
});

let fx: LibraryFixture;
let dir: string;
let jobsDbPath: string;
let modelsDir: string;

beforeEach(() => {
  fx = new LibraryFixture().activate();
  dir = mkdtempSync(join(tmpdir(), 'lt-lrw-job-'));
  jobsDbPath = join(dir, 'visualizer.db');
  modelsDir = join(dir, 'models');
  mkdirSync(join(dir, 'vision'), { recursive: true });
  writeFakeLayaModels(modelsDir);
  const lrcat = join(dir, 'c.lrcat');
  makeFakeCatalog(lrcat, []);
  process.env.DATABASE_PATH = jobsDbPath;
  writeFileSync(
    join(dir, 'config.yaml'),
    [
      `vision_cache_dir: ${join(dir, 'vision')}`,
      `laya_models_dir: ${modelsDir}`,
      `catalog_path: ${lrcat}`,
    ].join('\n'),
  );
  process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
  const db = openLibraryDb(fx.dbPath);
  seedCullingDefaults(db);
  patchLrWritebackSettings(db, { write_reject: true });
  db.close();
  laya.scripts.clear();
  laya.calls.length = 0;
  laya.starts = 0;
  laya.closed = 0;
  laya.forecastOn = true;
  laya.failOn = null;
  laya.dieOn = null;
  laya.broken = false;
  laya.startError = null;
  laya.cancelAfter = null;
  laya.sequence.length = 0;
});

afterEach(() => {
  fx.cleanup();
  delete process.env.DATABASE_PATH;
  delete process.env.LT_CONFIG_YAML;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('standalone cull job writeback hook', () => {
  it('invokes reconcile when LR closed', async () => {
    const spy = vi.spyOn(writeback, 'reconcileLrWriteback').mockResolvedValue({
      stars: { pending: 0, written: 0, skipped: 0, image_not_found: 0 },
      reject: { pending: 0, written: 0, skipped: 0, image_not_found: 0 },
      catalog_updated_stars: 0,
      catalog_updated_reject: 0,
      catalog_cleared_reject: 0,
    });
    const jobsDb = initJobsDb(jobsDbPath);
    const jobId = createJob(jobsDb, 'batch_cull_photos_before_scoring', { image_keys: [] });
    await tick(jobsDb, new JobRunner(jobsDb));
    const job = getJob(jobsDb, jobId)!;
    expect(job.status).toBe('completed');
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ trigger: 'cull_job_complete' }));
    jobsDb.close();
  });
});

describe('redecide hook', () => {
  it('invokes reconcile after redecide completes', async () => {
    const spy = vi.spyOn(writeback, 'reconcileLrWriteback').mockResolvedValue({
      stars: { pending: 0, written: 0, skipped: 0, image_not_found: 0 },
      reject: { pending: 0, written: 0, skipped: 0, image_not_found: 0 },
      catalog_updated_stars: 0,
      catalog_updated_reject: 0,
      catalog_cleared_reject: 0,
    });
    vi.spyOn(await import('../src/cull/redecide.js'), 'redecideAllPhotos').mockResolvedValue({
      total: 0,
      changed: 0,
      cut_by_culling_recipe: 0,
      cut_by_score_forecast: 0,
      pending: 0,
      sent: 0,
      sent_by_hand_passed: 0,
      pipeline_setting_version: 1,
      stage_versions: {},
      durations_s: { redecide: 0, total: 0 },
    });
    const jobsDb = initJobsDb(jobsDbPath);
    const jobId = createJob(jobsDb, 'batch_redecide_cull_verdicts_from_stored_answers', {});
    await tick(jobsDb, new JobRunner(jobsDb));
    expect(getJob(jobsDb, jobId)!.status).toBe('completed');
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ trigger: 'redecide_complete' }));
    jobsDb.close();
  });
});
