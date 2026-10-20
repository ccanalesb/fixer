/**
 * write-pending via HTTP must persist lr_writeback_state.status=written when the
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
import { seedCullingDefaults } from '../src/db/library/cull-recipes.js';
import { upsertWritebackState } from '../src/db/library/lr-writeback-state.js';
import {
  AUTO_REJECT_KEYWORD,
  connectCatalog,
  writeRejectToCatalog,
} from '../src/lightroom/writer.js';
import { LibraryFixture } from './helpers/library-fixture.js';
import { makeFakeCatalog } from './helpers/fake-catalog.js';

const app = createApp();

let fx: LibraryFixture;
let dir: string;
let cfgPath: string;
let lrcatPath: string;
const imageKey = '2024-06-01_cut-photo';

beforeEach(() => {
  fx = new LibraryFixture().activate();
  dir = mkdtempSync(join(tmpdir(), 'lt-lrw-rst-'));
  cfgPath = join(dir, 'config.yaml');
  lrcatPath = join(dir, 'Test.lrcat');
  process.env.LT_CONFIG_YAML = cfgPath;
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
  rmSync(dir, { recursive: true, force: true });
});

describe('POST write-pending state', () => {
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

    const res = await app.request('/api/cull/lightroom-writeback/write-pending', { method: 'POST' });
    expect(res.status).toBe(200);

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
