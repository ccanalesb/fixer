/**
 * Job hooks invoke Lightroom write-back reconcile (#341).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import * as writeback from '../src/lightroom/writeback.js';
import { openLibraryDb } from '../src/db/connection.js';
import { patchLrWritebackSettings } from '../src/db/library/lr-writeback-settings.js';
import { seedCullingDefaults } from '../src/db/library/cull-recipes.js';
import { createJob, initJobsDb } from '../src/db/jobs/jobs.js';
import { JobRunner } from '../src/jobs/runner.js';
import { tick } from '../src/jobs/processor.js';
import { LibraryFixture } from './helpers/library-fixture.js';
import { makeFakeCatalog } from './helpers/fake-catalog.js';

let fx: LibraryFixture;
let dir: string;
let jobsDbPath: string;

beforeEach(() => {
  fx = new LibraryFixture().activate();
  dir = mkdtempSync(join(tmpdir(), 'lt-lrw-job-'));
  jobsDbPath = join(dir, 'jobs.db');
  const lrcat = join(dir, 'c.lrcat');
  writeFileSync(join(dir, 'config.yaml'), stringifyYaml({ workers: 4, catalog_path: lrcat }));
  makeFakeCatalog(lrcat, []);
  process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
  const db = openLibraryDb(fx.dbPath);
  seedCullingDefaults(db);
  patchLrWritebackSettings(db, { write_reject: true });
  db.close();
});

afterEach(() => {
  fx.cleanup();
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
    createJob(jobsDb, 'batch_redecide_cull_verdicts_from_stored_answers', {});
    await tick(jobsDb, new JobRunner(jobsDb));
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ trigger: 'redecide_complete' }));
    jobsDb.close();
  });
});
