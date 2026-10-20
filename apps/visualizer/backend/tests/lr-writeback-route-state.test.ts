/**
 * Switch-on job / reconcile must persist lr_writeback_state.status=written when the
 * catalog already holds the app reject/stars (idempotent re-run).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { createApp } from '../src/app.js';
import { openLibraryDb } from '../src/db/connection.js';
import { patchLrWritebackSettings } from '../src/db/library/lr-writeback-settings.js';
import { upsertCullVerdict } from '../src/db/library/cull-verdicts.js';
import { getCurrentPipelineSetting } from '../src/db/library/cull-pipeline.js';
import { seedCullingDefaults } from '../src/db/library/cull-recipes.js';
import { upsertStageAnswer } from '../src/db/library/cull-stages.js';
import { upsertWritebackState } from '../src/db/library/lr-writeback-state.js';
import { resolveCurrentStages } from '../src/cull/stages.js';
import { createJob, getJob, initJobsDb } from '../src/db/jobs/jobs.js';
import { LR_WRITEBACK_JOB_TYPE } from '../src/jobs/handlers/lr-writeback.js';
import { JobRunner } from '../src/jobs/runner.js';
import { tick } from '../src/jobs/processor.js';
import { reconcileLrWriteback } from '../src/lightroom/writeback.js';
import {
  AUTO_STARS_KEYWORD,
  connectCatalog,
  imageHasKeywordByKey,
  writeRejectToCatalog,
  writeStarsToCatalog,
} from '../src/lightroom/writer.js';
import { LibraryFixture } from './helpers/library-fixture.js';
import { makeFakeCatalog } from './helpers/fake-catalog.js';

const app = createApp();

let fx: LibraryFixture;
let dir: string;
let cfgPath: string;
let lrcatPath: string;
let jobsDbPath: string;
const imageKey = '2024-06-01_cut-photo';
const starsKey = '2024-06-01_star-photo';
const MODEL_IDS = { base: 'test-laya-base', new: 'test-laya-new' };
const STAR_DIMS = ['immediate-impact', 'visual-structure', 'point-of-tension', 'connotation'] as const;

function levelPick(levelSet: '7' | '10', dim: string, levelIndex: number): Record<string, number[]> {
  const n = levelSet === '7' ? 7 : 10;
  const v = Array<number>(n).fill(0);
  v[Math.min(levelIndex, n - 1)] = 1;
  return { [`${levelSet}|${dim}`]: v };
}

function seedStarsEligible(db: ReturnType<typeof openLibraryDb>, imageKey: string, strongDimCount: number): void {
  const pipe = getCurrentPipelineSetting(db);
  const stages = resolveCurrentStages(db, pipe.config, MODEL_IDS);
  const recipe7 = stages.find((s) => s.stageKey === 'culling_recipe:recipe-7h47:7');
  const recipe10 = stages.find((s) => s.stageKey === 'culling_recipe:recipe-7h47:10');
  if (!recipe7 || !recipe10) throw new Error('recipe stages missing');
  const seven: Record<string, number[]> = {};
  const ten: Record<string, number[]> = {};
  STAR_DIMS.forEach((dim, di) => {
    Object.assign(seven, levelPick('7', dim, di < strongDimCount ? 5 : 0));
    Object.assign(ten, levelPick('10', dim, di < strongDimCount ? 7 : 0));
  });
  upsertStageAnswer(db, {
    imageKey,
    stageVersionId: recipe7.versionId,
    answers: seven,
    verdict: 'cut',
    decision: {},
    pipelineSettingVersion: pipe.version,
    source: 'job',
    runId: 1,
  });
  upsertStageAnswer(db, {
    imageKey,
    stageVersionId: recipe10.versionId,
    answers: ten,
    verdict: 'cut',
    decision: {},
    pipelineSettingVersion: pipe.version,
    source: 'job',
    runId: 1,
  });
}

async function runWritebackJob(): Promise<string> {
  const jobsDb = initJobsDb(jobsDbPath);
  const jobId = createJob(jobsDb, LR_WRITEBACK_JOB_TYPE, {});
  await tick(jobsDb, new JobRunner(jobsDb));
  expect(getJob(jobsDb, jobId)!.status).toBe('completed');
  jobsDb.close();
  return jobId;
}

beforeEach(() => {
  fx = new LibraryFixture().activate();
  dir = mkdtempSync(join(tmpdir(), 'lt-lrw-rst-'));
  cfgPath = join(dir, 'config.yaml');
  lrcatPath = join(dir, 'Test.lrcat');
  jobsDbPath = join(dir, 'visualizer.db');
  process.env.LT_CONFIG_YAML = cfgPath;
  process.env.DATABASE_PATH = jobsDbPath;
  writeFileSync(cfgPath, stringifyYaml({ workers: 4, catalog_path: lrcatPath }));
  makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'cut-photo', pick: 0, rating: null }]);
  const db = openLibraryDb(fx.dbPath);
  seedCullingDefaults(db);
  patchLrWritebackSettings(db, { write_reject: true });
  upsertCullVerdict(db, {
    imageKey,
    verdict: 'cut',
    cutBy: 'culling_recipe',
    cutByStageKey: 'culling_recipe:recipe-7h47:7',
    sentByHand: false,
    pendingStages: [],
    pendingReason: '',
    scoreForecastOff: false,
    scoreForecastP8: null,
    pipelineSettingVersion: 1,
    stageVersionIds: [],
    runId: null,
  });
  db.close();
});

afterEach(() => {
  fx.cleanup();
  delete process.env.LT_CONFIG_YAML;
  delete process.env.DATABASE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe('switch job reject state', () => {
  it('sets written after catalog already has reject from a prior write with skipped state', async () => {
    const conn = connectCatalog(lrcatPath);
    writeRejectToCatalog(conn, imageKey);
    conn.close();
    const db = openLibraryDb(fx.dbPath);
    upsertWritebackState(db, {
      image_key: imageKey,
      kind: 'reject',
      status: 'skipped',
      before_pick: 0,
      before_rating: null,
      written_pick: null,
      written_rating: null,
      stars_recipe_version_id: null,
      written_at: null,
    });
    db.close();

    await runWritebackJob();

    const state = fx.query<{ status: string }>(
      "SELECT status FROM lr_writeback_state WHERE image_key = ? AND kind = 'reject'",
      imageKey,
    )[0];
    expect(state?.status).toBe('written');
  });

  it('send-by-hand clears app reject when state was skipped', async () => {
    try {
      unlinkSync(lrcatPath);
    } catch {
      /* fresh catalog */
    }
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'cut-photo', pick: 0, rating: null }]);
    const conn = connectCatalog(lrcatPath);
    writeRejectToCatalog(conn, imageKey);
    conn.close();
    const db = openLibraryDb(fx.dbPath);
    upsertWritebackState(db, {
      image_key: imageKey,
      kind: 'reject',
      status: 'skipped',
      before_pick: 0,
      before_rating: null,
      written_pick: null,
      written_rating: null,
      stars_recipe_version_id: null,
      written_at: null,
    });
    db.close();

    const res = await app.request('/api/cull/photos/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_keys: [imageKey] }),
    });
    expect(res.status).toBe(200);

    const jobsDb = initJobsDb(jobsDbPath);
    const runner = new JobRunner(jobsDb);
    for (let i = 0; i < 5; i += 1) {
      await tick(jobsDb, runner);
    }
    jobsDb.close();

    const cat = connectCatalog(lrcatPath);
    const live = cat
      .prepare(
        `SELECT ai.pick FROM Adobe_images ai JOIN AgLibraryFile f ON f.id_local = ai.rootFile WHERE f.baseName = 'cut-photo'`,
      )
      .get() as { pick: number };
    cat.close();
    expect(Number(live.pick)).toBe(0);
  });
});

describe('switch job stars state', () => {
  beforeEach(() => {
    try {
      unlinkSync(lrcatPath);
    } catch {
      /* fresh */
    }
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'star-photo', pick: 0, rating: null }]);
    const db = openLibraryDb(fx.dbPath);
    seedCullingDefaults(db);
    patchLrWritebackSettings(db, { write_stars: true });
    upsertCullVerdict(db, {
      imageKey: starsKey,
      verdict: 'sent',
      cutBy: null,
      cutByStageKey: null,
      sentByHand: false,
      pendingStages: [],
      pendingReason: '',
      scoreForecastOff: false,
      scoreForecastP8: null,
      pipelineSettingVersion: getCurrentPipelineSetting(db).version,
      stageVersionIds: [],
      runId: null,
    });
    seedStarsEligible(db, starsKey, 1);
    db.close();
  });

  it('sets written when catalog already has stars with skipped state', async () => {
    const conn = connectCatalog(lrcatPath);
    writeStarsToCatalog(conn, starsKey, 1);
    conn.close();
    const db = openLibraryDb(fx.dbPath);
    upsertWritebackState(db, {
      image_key: starsKey,
      kind: 'stars',
      status: 'skipped',
      before_pick: null,
      before_rating: null,
      written_pick: null,
      written_rating: null,
      stars_recipe_version_id: null,
      written_at: null,
    });
    db.close();

    await runWritebackJob();

    const state = fx.query<{ status: string }>(
      "SELECT status FROM lr_writeback_state WHERE image_key = ? AND kind = 'stars'",
      starsKey,
    )[0];
    expect(state?.status).toBe('written');

    const detail = await app.request(`/api/cull/lightroom-writeback/photos/${starsKey}`);
    const body = (await detail.json()) as { rating: { app_wrote: boolean } };
    expect(body.rating.app_wrote).toBe(true);
  });

  it('undo restores null rating and removes keyword', async () => {
    await runWritebackJob();

    const undo = await app.request(`/api/cull/lightroom-writeback/photos/${starsKey}/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'stars' }),
    });
    expect(undo.status).toBe(200);

    const conn = connectCatalog(lrcatPath);
    const live = conn
      .prepare(
        `SELECT ai.rating FROM Adobe_images ai JOIN AgLibraryFile f ON f.id_local = ai.rootFile WHERE f.baseName = 'star-photo'`,
      )
      .get() as { rating: number | null };
    expect(live.rating).toBeNull();
    expect(imageHasKeywordByKey(conn, starsKey, AUTO_STARS_KEYWORD)).toBe(false);
    conn.close();
  });

  it('second reconcile run does not update catalog again (ruling 9)', async () => {
    const db = openLibraryDb(fx.dbPath);
    const first = await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    expect(first.catalog_updated_stars).toBeGreaterThan(0);
    const second = await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    expect(second.catalog_updated_stars ?? 0).toBe(0);
    db.close();
  });
});

describe('locked catalog', () => {
  it('writes nothing when catalog is locked', async () => {
    writeFileSync(join(dir, 'Test.lrcat-lock'), '');
    const db = openLibraryDb(fx.dbPath);
    patchLrWritebackSettings(db, { write_reject: true });
    const result = await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    expect(result.catalog_updated_reject).toBe(0);
    db.close();
  });
});
