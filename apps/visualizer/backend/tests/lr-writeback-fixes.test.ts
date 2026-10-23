/**
 * Lightroom write-back edge cases: state sync, catalog transactions, sent-by-hand errors, undo, lock, not-found.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { createApp } from '../src/app.js';
import { openLibraryDb } from '../src/db/connection.js';
import { patchLrWritebackSettings } from '../src/db/library/lr-writeback-settings.js';
import { getWritebackState, upsertWritebackState } from '../src/db/library/lr-writeback-state.js';
import { upsertCullVerdict } from '../src/db/library/cull-verdicts.js';
import { seedCullingDefaults } from '../src/db/library/cull-profiles.js';
import { reconcileLrWriteback, undoWritebackKind } from '../src/lightroom/writeback.js';
import {
  AUTO_STARS_KEYWORD,
  catalogBaseNameFromImageKey,
  connectCatalog,
  getImageLocalId,
  readPickRating,
  AUTO_REJECT_KEYWORD,
  clearRejectFromCatalog,
  imageHasKeywordByKey,
  writeRejectToCatalog,
  writeStarsToCatalog,
  type WritebackCatalogHooks,
} from '../src/lightroom/writer.js';
import { LibraryFixture } from './helpers/library-fixture.js';
import { makeFakeCatalog } from './helpers/fake-catalog.js';

let fx: LibraryFixture;
let dir: string;
let cfgPath: string;
let lrcatPath: string;

beforeEach(() => {
  fx = new LibraryFixture()
    .addImage({ key: '2024-06-01_p', id: '1' })
    .addImage({ key: '2024-06-01_a', id: '1' })
    .addImage({ key: '2024-06-01_b', id: '2' })
    .activate();
  dir = mkdtempSync(join(tmpdir(), 'lt-lrw-fix-'));
  cfgPath = join(dir, 'config.yaml');
  lrcatPath = join(dir, 'Test.lrcat');
  process.env.LT_CONFIG_YAML = cfgPath;
  writeFileSync(cfgPath, stringifyYaml({ workers: 4, catalog_path: lrcatPath }));
});

afterEach(() => {
  fx.cleanup();
  delete process.env.LT_CONFIG_YAML;
  rmSync(dir, { recursive: true, force: true });
});

describe('clearRejectFromCatalog keyword guard', () => {
  it('keeps keyword when pick no longer matches app reject', () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'p', pick: 0, rating: null }]);
    const conn = connectCatalog(lrcatPath);
    writeRejectToCatalog(conn, '2024-06-01_p');
    conn.prepare('UPDATE Adobe_images SET pick = 0 WHERE id_local = 900001').run();
    clearRejectFromCatalog(conn, '2024-06-01_p');
    expect(imageHasKeywordByKey(conn, '2024-06-01_p', AUTO_REJECT_KEYWORD)).toBe(true);
    conn.close();
  });
});

describe('catalogBaseNameFromImageKey', () => {
  it('matches product keys YYYY-MM-DD_basename', () => {
    expect(catalogBaseNameFromImageKey('2017-03-03_DSC5875')).toBe('DSC5875');
    expect(catalogBaseNameFromImageKey('2024-06-01_foo.jpg')).toBe('foo');
  });
});

describe('finding the catalog photo for an image key', () => {
  function addVirtualCopy(masterId: number, fileId: number): void {
    const cat = new Database(lrcatPath);
    cat
      .prepare('INSERT INTO Adobe_images (id_local, rootFile, captureTime, masterImage) VALUES (?, ?, ?, ?)')
      .run(950_000 + fileId, fileId, '2024-06-01T12:00:00', masterId);
    cat.close();
  }

  it('takes the file the library holds for the key when a JPG and RAW share a name', () => {
    makeFakeCatalog(lrcatPath, [
      { id: 1, baseName: 'pair', extension: 'jpg' },
      { id: 2, baseName: 'pair', extension: 'dng' },
    ]);
    fx.addImage({ key: '2024-06-01_pair', id: '2' });
    const db = openLibraryDb(fx.dbPath);
    const bound = connectCatalog(lrcatPath, db);
    const unbound = connectCatalog(lrcatPath);
    expect(getImageLocalId(bound, '2024-06-01_pair')).toBe(900_002);
    expect(getImageLocalId(unbound, '2024-06-01_pair')).toBeNull();
    bound.close();
    unbound.close();
    db.close();
  });

  it('tells same-name photos apart by day without the library', () => {
    makeFakeCatalog(lrcatPath, [
      { id: 1, baseName: 'DSC0001', captureTime: '2017-03-03T10:00:00' },
      { id: 2, baseName: 'DSC0001', captureTime: '2024-06-01T10:00:00' },
    ]);
    const conn = connectCatalog(lrcatPath);
    expect(getImageLocalId(conn, '2024-06-01_DSC0001')).toBe(900_002);
    expect(getImageLocalId(conn, '2017-03-03_DSC0001')).toBe(900_001);
    expect(getImageLocalId(conn, '2020-01-01_DSC0001')).toBeNull();
    conn.close();
  });

  it('takes the master, not a virtual copy', () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'vc' }]);
    addVirtualCopy(900_001, 1);
    fx.addImage({ key: '2024-06-01_vc', id: '1' });
    const db = openLibraryDb(fx.dbPath);
    const bound = connectCatalog(lrcatPath, db);
    const unbound = connectCatalog(lrcatPath);
    expect(getImageLocalId(bound, '2024-06-01_vc')).toBe(900_001);
    expect(getImageLocalId(unbound, '2024-06-01_vc')).toBe(900_001);
    bound.close();
    unbound.close();
    db.close();
  });

  it('finds nothing for a key the library holds no file id for', () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'lonely' }]);
    fx.addImages('2024-06-01_lonely');
    const db = openLibraryDb(fx.dbPath);
    const bound = connectCatalog(lrcatPath, db);
    expect(getImageLocalId(bound, '2024-06-01_lonely')).toBeNull();
    bound.close();
    db.close();
  });

  it('writes the reject to the RAW the library holds, leaving the JPG alone', async () => {
    makeFakeCatalog(lrcatPath, [
      { id: 1, baseName: 'pair', extension: 'jpg', pick: 0 },
      { id: 2, baseName: 'pair', extension: 'dng', pick: 0 },
    ]);
    fx.addImage({ key: '2024-06-01_pair', id: '2' });
    const db = openLibraryDb(fx.dbPath);
    seedCullingDefaults(db);
    patchLrWritebackSettings(db, { write_reject: true });
    upsertCullVerdict(db, {
      imageKey: '2024-06-01_pair',
      verdict: 'filtered',
      filteredBy: 'culling_profile',
      filteredByStageKey: 'x',
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
    await reconcileLrWriteback(db, { trigger: 'write_pending', catalogPath: lrcatPath });
    db.close();
    const cat = new Database(lrcatPath, { readonly: true });
    const picks = cat.prepare('SELECT id_local, pick FROM Adobe_images ORDER BY id_local').all();
    cat.close();
    expect(picks).toEqual([
      { id_local: 900_001, pick: 0 },
      { id_local: 900_002, pick: -1 },
    ]);
  });
});

describe('writeStarsToCatalog transaction', () => {
  it('rolls back rating when keyword step throws', () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'x', pick: 0, rating: null }]);
    const conn = connectCatalog(lrcatPath);
    const hooks: WritebackCatalogHooks = {
      afterRatingBeforeKeyword: () => {
        throw new Error('injected');
      },
    };
    expect(() => writeStarsToCatalog(conn, '2024-06-01_x', 2, hooks)).toThrow('injected');
    conn.close();
    const ro = new Database(lrcatPath, { readonly: true });
    const rating = ro
      .prepare(
        `SELECT ai.rating FROM Adobe_images ai JOIN AgLibraryFile f ON f.id_local = ai.rootFile WHERE f.baseName = 'x'`,
      )
      .get() as { rating: number | null };
    expect(rating.rating).toBeNull();
    ro.close();
  });
});

describe('stars clear updates state', () => {
  it('clears written state when re-decide removes stars from catalog', async () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'filtered-photo', pick: 0, rating: 3 }]);
    const conn = connectCatalog(lrcatPath);
    conn.prepare('UPDATE Adobe_images SET rating = 3 WHERE id_local = 900001').run();
    conn.close();
    const db = openLibraryDb(fx.dbPath);
    seedCullingDefaults(db);
    patchLrWritebackSettings(db, { write_stars: true });
    upsertWritebackState(db, {
      image_key: '2024-06-01_filtered-photo',
      kind: 'stars',
      status: 'written',
      before_pick: null,
      before_rating: null,
      written_pick: null,
      written_rating: 3,
      stars_profile_version_id: 1,
      written_at: '2026-01-01T00:00:00Z',
    });
    await reconcileLrWriteback(db, {
      trigger: 'redecide_complete',
      catalogPath: lrcatPath,
      imageKeys: ['2024-06-01_filtered-photo'],
    });
    const state = getWritebackState(db, '2024-06-01_filtered-photo', 'stars');
    expect(state?.status).not.toBe('written');
    db.close();
  });
});

describe('undo reject restores before_pick', () => {
  it('restores pick from before_pick not always 0', () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'p', pick: -1, rating: null }]);
    const db = openLibraryDb(fx.dbPath);
    upsertWritebackState(db, {
      image_key: '2024-06-01_p',
      kind: 'reject',
      status: 'written',
      before_pick: 1,
      before_rating: null,
      written_pick: -1,
      written_rating: null,
      stars_profile_version_id: null,
      written_at: '2026-01-01T00:00:00Z',
    });
    const r = undoWritebackKind(db, lrcatPath, '2024-06-01_p', 'reject');
    expect(r.ok).toBe(true);
    db.close();
    const cat = new Database(lrcatPath, { readonly: true });
    const pick = cat
      .prepare(
        `SELECT ai.pick FROM Adobe_images ai JOIN AgLibraryFile f ON f.id_local = ai.rootFile WHERE f.baseName = 'p'`,
      )
      .get() as { pick: number };
    expect(Number(pick.pick)).toBe(1);
    cat.close();
  });
});

describe('sent_by_hand reconcile errors', () => {
  it('returns 200 when reconcile fails after action persisted', async () => {
    const app = createApp();
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 's', pick: -1 }]);
    writeFileSync(join(dir, 'Test.lrcat-lock'), '');
    const db = openLibraryDb(fx.dbPath);
    seedCullingDefaults(db);
    patchLrWritebackSettings(db, { write_reject: true });
    upsertCullVerdict(db, {
      imageKey: '2024-06-01_s',
      verdict: 'filtered',
      filteredBy: 'culling_profile',
      filteredByStageKey: 'x',
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
    const res = await app.request('/api/cull/photos/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_keys: ['2024-06-01_s'] }),
    });
    expect(res.status).toBe(200);
  });
});

describe('image_not_found', () => {
  it('marks skipped and counts when photo missing from lrcat', async () => {
    makeFakeCatalog(lrcatPath, []);
    const db = openLibraryDb(fx.dbPath);
    seedCullingDefaults(db);
    patchLrWritebackSettings(db, { write_reject: true });
    upsertCullVerdict(db, {
      imageKey: '2024-06-01_missing',
      verdict: 'filtered',
      filteredBy: 'culling_profile',
      filteredByStageKey: 'x',
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
    const result = await reconcileLrWriteback(db, { trigger: 'write_pending', catalogPath: lrcatPath });
    expect(result.reject.image_not_found).toBeGreaterThan(0);
    expect(getWritebackState(db, '2024-06-01_missing', 'reject')?.status).toBe('skipped');
    db.close();
  });
});

describe('per-photo lock stops run', () => {
  it('leaves remaining photos pending when lock appears mid-run', async () => {
    makeFakeCatalog(lrcatPath, [
      { id: 1, baseName: 'a', pick: 0 },
      { id: 2, baseName: 'b', pick: 0 },
    ]);
    const db = openLibraryDb(fx.dbPath);
    seedCullingDefaults(db);
    patchLrWritebackSettings(db, { write_reject: true });
    for (const key of ['2024-06-01_a', '2024-06-01_b']) {
      upsertCullVerdict(db, {
        imageKey: key,
        verdict: 'filtered',
        filteredBy: 'culling_profile',
        filteredByStageKey: 'x',
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
    }
    const writer = await import('../src/lightroom/writer.js');
    let n = 0;
    vi.spyOn(writer, 'isCatalogLocked').mockImplementation(() => {
      n += 1;
      return n > 1;
    });
    await reconcileLrWriteback(db, { trigger: 'write_pending', catalogPath: lrcatPath });
    expect(getWritebackState(db, '2024-06-01_b', 'reject')?.status).toBe('pending');
    db.close();
    vi.restoreAllMocks();
  });
});
