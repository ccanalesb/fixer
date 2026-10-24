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
import { seedCullingDefaults } from '../src/db/library/cull-profiles.js';
import { upsertStageAnswer } from '../src/db/library/cull-stages.js';
import { upsertWritebackState } from '../src/db/library/lr-writeback-state.js';
import { resolveCurrentStages } from '../src/cull/stages.js';
import { createJob, getJob, initJobsDb } from '../src/db/jobs/jobs.js';
import { LR_WRITEBACK_JOB_TYPE } from '../src/jobs/handlers/lr-writeback.js';
import { JobRunner } from '../src/jobs/runner.js';
import { tick } from '../src/jobs/processor.js';
import { reconcileLrWriteback } from '../src/lightroom/writeback.js';
import {
  AUTO_REJECT_KEYWORD,
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
const imageKey = '2024-06-01_filtered-photo';
const starsKey = '2024-06-01_star-photo';
const MODEL_IDS = { culling_profile: 'test-culling-model', score_forecast: 'test-forecast-model' };
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
  const profile7 = stages.find((s) => s.stageKey === 'culling_profile:default:7');
  const profile10 = stages.find((s) => s.stageKey === 'culling_profile:default:10');
  if (!profile7 || !profile10) throw new Error('profile stages missing');
  const seven: Record<string, number[]> = {};
  const ten: Record<string, number[]> = {};
  STAR_DIMS.forEach((dim, di) => {
    Object.assign(seven, levelPick('7', dim, di < strongDimCount ? 5 : 0));
    Object.assign(ten, levelPick('10', dim, di < strongDimCount ? 7 : 0));
  });
  upsertStageAnswer(db, {
    imageKey,
    stageVersionId: profile7.versionId,
    answers: seven,
    verdict: 'filtered',
    decision: {},
    pipelineSettingVersion: pipe.version,
    source: 'job',
    runId: 1,
  });
  upsertStageAnswer(db, {
    imageKey,
    stageVersionId: profile10.versionId,
    answers: ten,
    verdict: 'filtered',
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
  fx = new LibraryFixture()
    .addImage({ key: imageKey, id: '1' })
    .addImage({ key: starsKey, id: '1' })
    .cullingStagesOn()
    .activate();
  dir = mkdtempSync(join(tmpdir(), 'lt-lrw-rst-'));
  cfgPath = join(dir, 'config.yaml');
  lrcatPath = join(dir, 'Test.lrcat');
  jobsDbPath = join(dir, 'visualizer.db');
  process.env.LT_CONFIG_YAML = cfgPath;
  process.env.DATABASE_PATH = jobsDbPath;
  writeFileSync(cfgPath, stringifyYaml({ workers: 4, catalog_path: lrcatPath }));
  makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'filtered-photo', pick: 0, rating: null }]);
  const db = openLibraryDb(fx.dbPath);
  seedCullingDefaults(db);
  patchLrWritebackSettings(db, { write_reject: true });
  upsertCullVerdict(db, {
    imageKey,
    verdict: 'filtered',
    filteredBy: 'culling_profile',
    filteredByStageKey: 'culling_profile:default:7',
    cullingProfileVerdict: 'filtered',
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
      stars_profile_version_id: null,
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
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'filtered-photo', pick: 0, rating: null }]);
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
      stars_profile_version_id: null,
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
        `SELECT ai.pick FROM Adobe_images ai JOIN AgLibraryFile f ON f.id_local = ai.rootFile WHERE f.baseName = 'filtered-photo'`,
      )
      .get() as { pick: number };
    cat.close();
    expect(Number(live.pick)).toBe(0);
  });

  it('takes a reject the user unflagged in Lightroom as undone, and does not write it again', async () => {
    const db = openLibraryDb(fx.dbPath);
    await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    editCatalog('UPDATE Adobe_images SET pick = 0');
    await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    const again = await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    db.close();

    expect(stateOf(imageKey, 'reject')).toBe('undone');
    expect(again.catalog_updated_reject).toBe(0);
    expect(liveOf('filtered-photo')).toEqual({ pick: 0, rating: null, keyword: false });
  });

  it('keeps a pick the user set over the app reject', async () => {
    const db = openLibraryDb(fx.dbPath);
    await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    editCatalog('UPDATE Adobe_images SET pick = 1');
    await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    db.close();

    expect(stateOf(imageKey, 'reject')).toBe('skipped');
    expect(liveOf('filtered-photo').pick).toBe(1);
  });
});

function editCatalog(sql: string): void {
  const cat = connectCatalog(lrcatPath);
  cat.exec(sql);
  cat.close();
}

function stateOf(key: string, kind: 'stars' | 'reject'): string | undefined {
  return fx.query<{ status: string }>(
    'SELECT status FROM lr_writeback_state WHERE image_key = ? AND kind = ?',
    key,
    kind,
  )[0]?.status;
}

function liveOf(baseName: string): { pick: number; rating: number | null; keyword: boolean } {
  const cat = connectCatalog(lrcatPath);
  const row = cat
    .prepare(
      `SELECT ai.id_local AS id, ai.pick, ai.rating FROM Adobe_images ai
       JOIN AgLibraryFile f ON f.id_local = ai.rootFile WHERE f.baseName = ?`,
    )
    .get(baseName) as { id: number; pick: number; rating: number | null };
  const keyword =
    cat
      .prepare(
        `SELECT 1 FROM AgLibraryKeywordImage ki JOIN AgLibraryKeyword k ON k.id_local = ki.tag
         WHERE ki.image = ? AND k.name IN (?, ?)`,
      )
      .get(row.id, AUTO_STARS_KEYWORD, AUTO_REJECT_KEYWORD) !== undefined;
  cat.close();
  return { pick: Number(row.pick), rating: row.rating === null ? null : Number(row.rating), keyword };
}

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
      verdict: 'passed',
      filteredBy: null,
      filteredByStageKey: null,
      cullingProfileVerdict: null,
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
      stars_profile_version_id: null,
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

  it('takes stars the user cleared in Lightroom as undone, and does not write them again', async () => {
    const db = openLibraryDb(fx.dbPath);
    const first = await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    expect(first.catalog_updated_stars).toBe(1);
    editCatalog('UPDATE Adobe_images SET rating = NULL');
    await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    const again = await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    db.close();

    expect(stateOf(starsKey, 'stars')).toBe('undone');
    expect(again.catalog_updated_stars).toBe(0);
    expect(liveOf('star-photo')).toEqual({ pick: 0, rating: null, keyword: false });
  });

  const starsRow = () =>
    fx.query<{ status: string; before_rating: number | null; written_rating: number | null }>(
      "SELECT status, before_rating, written_rating FROM lr_writeback_state WHERE image_key = ? AND kind = 'stars'",
      starsKey,
    )[0];

  it('replaces its own stars when the rule now asks for others', async () => {
    const db = openLibraryDb(fx.dbPath);
    await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    seedStarsEligible(db, starsKey, 3);
    const second = await reconcileLrWriteback(db, { trigger: 'redecide_complete', catalogPath: lrcatPath });
    db.close();

    expect(second.catalog_updated_stars).toBe(1);
    expect(liveOf('star-photo')).toEqual({ pick: 0, rating: 3, keyword: true });
    expect(starsRow()).toEqual({ status: 'written', before_rating: null, written_rating: 3 });
  });

  it('leaves stars the user changed in Lightroom when the rule asks for others', async () => {
    const db = openLibraryDb(fx.dbPath);
    await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    editCatalog('UPDATE Adobe_images SET rating = 2');
    seedStarsEligible(db, starsKey, 3);
    await reconcileLrWriteback(db, { trigger: 'redecide_complete', catalogPath: lrcatPath });
    db.close();

    expect(liveOf('star-photo').rating).toBe(2);
    expect(starsRow()?.status).toBe('skipped');
  });

  it('keeps stars the user already had under the app keyword when the rule asks for others', async () => {
    editCatalog('UPDATE Adobe_images SET rating = 1');
    const db = openLibraryDb(fx.dbPath);
    await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    seedStarsEligible(db, starsKey, 3);
    await reconcileLrWriteback(db, { trigger: 'redecide_complete', catalogPath: lrcatPath });
    await reconcileLrWriteback(db, { trigger: 'redecide_complete', catalogPath: lrcatPath });
    db.close();

    expect(liveOf('star-photo').rating).toBe(1);
    expect(starsRow()).toMatchObject({ status: 'skipped', before_rating: 1 });
  });

  it('keeps the rating from before its write when the user later changes the stars', async () => {
    const db = openLibraryDb(fx.dbPath);
    await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    editCatalog('UPDATE Adobe_images SET rating = 2');
    seedStarsEligible(db, starsKey, 3);
    await reconcileLrWriteback(db, { trigger: 'redecide_complete', catalogPath: lrcatPath });
    await reconcileLrWriteback(db, { trigger: 'redecide_complete', catalogPath: lrcatPath });
    db.close();

    expect(liveOf('star-photo').rating).toBe(2);
    expect(starsRow()).toMatchObject({ status: 'skipped', before_rating: null });
  });

  it('takes back its stars from a void frame and rejects it', async () => {
    const db = openLibraryDb(fx.dbPath);
    await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    expect(liveOf('star-photo').rating).toBe(1);
    fx.addFrameSubstance(starsKey, 'void');
    await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    db.close();

    expect(liveOf('star-photo')).toMatchObject({ pick: -1, rating: null });
    expect(stateOf(starsKey, 'reject')).toBe('written');
  });

  it('the photo detail says a void frame gets no stars, and gives the count again once overridden', async () => {
    const line = async () =>
      ((await (await app.request(`/api/cull/lightroom-writeback/photos/${starsKey}`)).json()) as {
        strong_dimensions_line: string | null;
      }).strong_dimensions_line;
    fx.addFrameSubstance(starsKey, 'void');
    expect(await line()).toBe('No stars: void frame');
    fx.addFrameSubstanceOverride(starsKey);
    expect(await line()).toBe('Strong dimensions (Default culling profile): 1 strong → ★');
  });

  it('leaves a void frame the user overrode as any other photo', async () => {
    fx.addFrameSubstance(starsKey, 'void').addFrameSubstanceOverride(starsKey);
    const db = openLibraryDb(fx.dbPath);
    await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    db.close();

    expect(liveOf('star-photo')).toMatchObject({ pick: 0, rating: 1 });
  });

  it('never rejects a void frame sent by hand', async () => {
    fx.addFrameSubstance(starsKey, 'void');
    fx.exec('UPDATE cull_verdicts SET sent_by_hand = 1 WHERE image_key = ?', starsKey);
    const db = openLibraryDb(fx.dbPath);
    await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    db.close();

    expect(liveOf('star-photo')).toMatchObject({ pick: 0, rating: null });
  });

  it('keeps stars and no reject on an illegible frame: it still has a subject to judge', async () => {
    fx.addFrameSubstance(starsKey, 'illegible');
    const db = openLibraryDb(fx.dbPath);
    await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    db.close();

    expect(liveOf('star-photo')).toMatchObject({ pick: 0, rating: 1 });
  });

  it('takes back its own stars from a row marked skipped, and undo then clears them', async () => {
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
      written_rating: 1,
      stars_profile_version_id: 1,
      written_at: '2026-10-21T15:12:03Z',
    });
    seedStarsEligible(db, starsKey, 3);
    await reconcileLrWriteback(db, { trigger: 'redecide_complete', catalogPath: lrcatPath });
    db.close();

    expect(liveOf('star-photo')).toEqual({ pick: 0, rating: 3, keyword: true });
    expect(starsRow()).toEqual({ status: 'written', before_rating: null, written_rating: 3 });

    const undo = await app.request(`/api/cull/lightroom-writeback/photos/${starsKey}/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'stars' }),
    });
    expect(undo.status).toBe(200);
    expect(liveOf('star-photo')).toEqual({ pick: 0, rating: null, keyword: false });
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
