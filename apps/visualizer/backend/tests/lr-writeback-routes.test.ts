import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { openLibraryDb } from '../src/db/connection.js';
import { patchLrWritebackSettings } from '../src/db/library/lr-writeback-settings.js';
import { getPendingJobs, initJobsDb } from '../src/db/jobs/jobs.js';
import { LR_WRITEBACK_JOB_TYPE } from '../src/jobs/handlers/lr-writeback.js';
import { seedCullingDefaults } from '../src/db/library/cull-profiles.js';
import { createApp } from '../src/app.js';
import { LibraryFixture } from './helpers/library-fixture.js';
import { makeFakeCatalog } from './helpers/fake-catalog.js';

const app = createApp();
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

let fx: LibraryFixture;
let dir: string;
let cfgPath: string;
let lrcatPath: string;
let jobsDbPath: string;

beforeEach(() => {
  fx = new LibraryFixture().activate();
  dir = mkdtempSync(join(tmpdir(), 'lt-lrw-rt-'));
  cfgPath = join(dir, 'config.yaml');
  lrcatPath = join(dir, 'Test.lrcat');
  jobsDbPath = join(dir, 'visualizer.db');
  process.env.LT_CONFIG_YAML = cfgPath;
  process.env.DATABASE_PATH = jobsDbPath;
  writeFileSync(cfgPath, stringifyYaml({ workers: 4, catalog_path: lrcatPath }));
  makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'x', pick: 0 }]);
  const db = openLibraryDb(fx.dbPath);
  seedCullingDefaults(db);
  db.close();
});

afterEach(() => {
  fx.cleanup();
  delete process.env.LT_CONFIG_YAML;
  delete process.env.DATABASE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe('lr writeback routes', () => {
  it('GET settings defaults switches off', async () => {
    const res = await app.request('/api/cull/lightroom-writeback/settings');
    expect(res.status).toBe(200);
    const body = await json<{ write_stars: boolean; write_reject: boolean }>(res);
    expect(body.write_stars).toBe(false);
    expect(body.write_reject).toBe(false);
  });

  it('POST write enqueues a job even when catalog locked', async () => {
    writeFileSync(join(dir, 'Test.lrcat-lock'), '');
    const db = openLibraryDb(fx.dbPath);
    patchLrWritebackSettings(db, { write_reject: true });
    db.close();
    const res = await app.request('/api/cull/lightroom-writeback/write', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await json<{ job_id: string }>(res);
    expect(body.job_id).toBeTruthy();
    const jobsDb = initJobsDb(jobsDbPath);
    const pending = getPendingJobs(jobsDb).filter((j) => j.type === LR_WRITEBACK_JOB_TYPE);
    jobsDb.close();
    expect(pending).toHaveLength(1);
  });
});
