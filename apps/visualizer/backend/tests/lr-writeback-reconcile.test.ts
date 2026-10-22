/**
 * End-to-end reconcile on temp config + fake catalog + temp library.db.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { openLibraryDb } from '../src/db/connection.js';
import { reconcileLrWriteback } from '../src/lightroom/writeback.js';
import { AUTO_REJECT_KEYWORD } from '../src/lightroom/writer.js';
import { patchLrWritebackSettings } from '../src/db/library/lr-writeback-settings.js';
import { getWritebackState } from '../src/db/library/lr-writeback-state.js';
import { upsertCullVerdict } from '../src/db/library/cull-verdicts.js';
import { seedCullingDefaults } from '../src/db/library/cull-profiles.js';
import { LibraryFixture } from './helpers/library-fixture.js';
import { makeFakeCatalog } from './helpers/fake-catalog.js';

let fx: LibraryFixture;
let dir: string;
let cfgPath: string;
let lrcatPath: string;

beforeEach(() => {
  fx = new LibraryFixture().addImage({ key: '2024-06-01_filtered-photo', id: '1' }).activate();
  dir = mkdtempSync(join(tmpdir(), 'lt-lrw-rec-'));
  cfgPath = join(dir, 'config.yaml');
  lrcatPath = join(dir, 'Test.lrcat');
  process.env.LT_CONFIG_YAML = cfgPath;
  writeFileSync(cfgPath, stringifyYaml({ workers: 4, catalog_path: lrcatPath }));
  makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'filtered-photo', pick: 0, rating: null }]);
  const db = openLibraryDb(fx.dbPath);
  seedCullingDefaults(db);
  patchLrWritebackSettings(db, { write_reject: true });
  upsertCullVerdict(db, {
    imageKey: '2024-06-01_filtered-photo',
    verdict: 'filtered',
    filteredBy: 'culling_profile',
    filteredByStageKey: 'culling_profile:recipe-culling:7',
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
  rmSync(dir, { recursive: true, force: true });
});

describe('reconcileLrWriteback', () => {
  it('writes reject + keyword for a profile-filtered photo when LR closed', async () => {
    const db = openLibraryDb(fx.dbPath);
    await reconcileLrWriteback(db, { trigger: 'write_pending', catalogPath: lrcatPath });
    const state = getWritebackState(db, '2024-06-01_filtered-photo', 'reject');
    expect(state?.status).toBe('written');
    db.close();
    const cat = new Database(lrcatPath, { readonly: true });
    const pick = cat
      .prepare(
        `SELECT ai.pick FROM Adobe_images ai JOIN AgLibraryFile f ON f.id_local = ai.rootFile WHERE f.baseName = ?`,
      )
      .get('filtered-photo') as { pick: number };
    expect(Number(pick.pick)).toBe(-1);
    const kw = cat
      .prepare(
        `SELECT k.name FROM AgLibraryKeyword k
         JOIN AgLibraryKeywordImage ki ON ki.tag = k.id_local
         JOIN Adobe_images ai ON ai.id_local = ki.image
         JOIN AgLibraryFile f ON f.id_local = ai.rootFile
         WHERE f.baseName = ?`,
      )
      .all('filtered-photo') as { name: string }[];
    expect(kw.some((r) => r.name === AUTO_REJECT_KEYWORD)).toBe(true);
    cat.close();
  });

  it('skips a photo the Score forecast filtered', async () => {
    const db = openLibraryDb(fx.dbPath);
    upsertCullVerdict(db, {
      imageKey: '2024-06-01_filtered-photo',
      verdict: 'filtered',
      filteredBy: 'score_forecast',
      filteredByStageKey: 'score_forecast',
      cullingProfileVerdict: null,
      sentByHand: false,
      pendingStages: [],
      pendingReason: '',
      scoreForecastOff: false,
      scoreForecastP8: 0.05,
      pipelineSettingVersion: 1,
      stageVersionIds: [],
      runId: null,
    });
    await reconcileLrWriteback(db, { trigger: 'write_pending', catalogPath: lrcatPath });
    expect(getWritebackState(db, '2024-06-01_filtered-photo', 'reject')).toBeNull();
    db.close();
  });
});
