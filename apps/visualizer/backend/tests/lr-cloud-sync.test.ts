/**
 * Stars and flags reach Lightroom's cloud: write-back appends a revision to the sync docstore.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { openLibraryDb } from '../src/db/connection.js';
import { upsertCullVerdict } from '../src/db/library/cull-verdicts.js';
import { seedCullingDefaults } from '../src/db/library/cull-profiles.js';
import { patchLrWritebackSettings } from '../src/db/library/lr-writeback-settings.js';
import { upsertWritebackState } from '../src/db/library/lr-writeback-state.js';
import { closeCloudDocstore, openCloudDocstore, pushPhotoToCloud } from '../src/lightroom/cloud-sync/docstore.js';
import { decodeMsgpack, encodeMsgpack, MsgFloat, type MsgValue } from '../src/lightroom/cloud-sync/msgpack.js';
import { reconcileLrWriteback, undoWritebackKind } from '../src/lightroom/writeback.js';
import { connectCatalog, writeRejectToCatalog } from '../src/lightroom/writer.js';
import { makeFakeCatalog } from './helpers/fake-catalog.js';
import { addCloudSync, assetDoc, readCloudRevs, SYNC_USER_ID, userValue } from './helpers/fake-sync-docstore.js';
import { LibraryFixture } from './helpers/library-fixture.js';

const IMAGE = 900_001;
const ASSET = 'f0bc8d177e7543b6829c22575623b5c4';
const NOW = new Date('2026-10-21T13:49:37.468Z');

let dir: string;
let lrcatPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-cloud-'));
  lrcatPath = join(dir, 'Test.lrcat');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function push(fields: { rating: boolean; flag: boolean }, now = NOW) {
  const conn = connectCatalog(lrcatPath);
  const store = openCloudDocstore(conn, lrcatPath);
  try {
    return pushPhotoToCloud(store!, conn, IMAGE, fields, now);
  } finally {
    closeCloudDocstore(store);
    conn.close();
  }
}

describe('msgpack codec', () => {
  it('writes a float as float32 when float32 holds it, float64 otherwise', () => {
    expect(hex(encodeMsgpack(new MsgFloat(1)))).toBe('ca3f800000');
    expect(hex(encodeMsgpack(new MsgFloat(0.1)))).toBe('cb3fb999999999999a');
    expect(hex(encodeMsgpack(1))).toBe('01');
  });

  it('re-encodes a decoded document to the same bytes', () => {
    const doc: MsgValue = new Map<MsgValue, MsgValue>([
      ['zeta', 1],
      ['2560', new Map<MsgValue, MsgValue>([['size', 978408]])],
      ['10', -3],
      ['aesthetics', new Map<MsgValue, MsgValue>([['score', new MsgFloat(70)], ['rot', new MsgFloat(0.123)]])],
      ['ratio', [new MsgFloat(7643856), 1000000, -40000, 2 ** 40]],
      ['flags', [true, false, null]],
      ['blob', new Uint8Array([1, 2, 3])],
      ['long', 'x'.repeat(300)],
      ['device', 'ccanales’s Mac mini'],
    ]);
    const bytes = encodeMsgpack(doc);
    const back = decodeMsgpack(bytes);
    expect(hex(encodeMsgpack(back))).toBe(hex(bytes));
    expect([...(back as Map<MsgValue, MsgValue>).keys()]).toEqual([
      'zeta', '2560', '10', 'aesthetics', 'ratio', 'flags', 'blob', 'long', 'device',
    ]);
  });
});

describe('pushPhotoToCloud', () => {
  it('appends a revision carrying the catalog stars, the way Classic does', () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'R0005364', rating: 2, pick: 0 }]);
    const mcat = addCloudSync(lrcatPath, [{ imageId: IMAGE, ozAssetId: ASSET }]);

    expect(push({ rating: true, flag: false })).toBe('pushed');

    const { winning, oz, revs } = readCloudRevs(mcat, ASSET);
    expect(revs).toHaveLength(2);
    const [base, rev] = revs as [(typeof revs)[0], (typeof revs)[0]];
    expect(winning).toBe(rev.sequence);
    expect(oz).toBe(base.sequence);
    expect(rev.parent).toBe(base.sequence);
    expect([base.current, rev.current]).toEqual([0, 1]);
    expect(rev.revId).toMatch(/^[0-9a-f]{12}4[0-9a-f]{19}$/);
    expect(rev.contentType).toBe('text');
    expect(userValue(rev.doc, 'ratings', 'rating')).toBe(2);
    expect(userValue(rev.doc, 'ratings', 'date')).toBe('2026-10-21T13:49:37Z');
    expect(rev.doc.get('userUpdated')).toBe('2026-10-21T13:49:37.468Z');
    expect(rev.doc.get('captureDate')).toBe('2026-10-04T16:47:07');

    const cat = new Database(lrcatPath, { readonly: true });
    expect(cat.prepare('SELECT currRevId FROM AgOzDocRevIds WHERE localId = ?').get(IMAGE)).toEqual({
      currRevId: rev.revId,
    });
    expect(
      cat.prepare('SELECT changeCounter, lastSyncedChangeCounter FROM AgLibraryImageChangeCounter WHERE image = ?').get(IMAGE),
    ).toEqual({ changeCounter: 50, lastSyncedChangeCounter: 50 });
    cat.close();
  });

  it('writes nothing when the document already holds the catalog values', () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'p', rating: 2, pick: -1 }]);
    const mcat = addCloudSync(lrcatPath, [{ imageId: IMAGE, ozAssetId: ASSET }]);
    expect(push({ rating: true, flag: true })).toBe('pushed');
    expect(push({ rating: true, flag: true })).toBe('unchanged');
    expect(readCloudRevs(mcat, ASSET).revs).toHaveLength(2);
  });

  it('carries the reject flag, and clears the way Lightroom does', () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'p', rating: null, pick: -1 }]);
    const mcat = addCloudSync(lrcatPath, [
      {
        imageId: IMAGE,
        ozAssetId: ASSET,
        doc: assetDoc([
          ['ratings', new Map([[SYNC_USER_ID, new Map<MsgValue, MsgValue>([['date', '2023-04-09T13:57:06Z'], ['rating', 3]])]])],
        ]),
      },
    ]);
    expect(push({ rating: true, flag: true })).toBe('pushed');
    let doc = readCloudRevs(mcat, ASSET).revs.at(-1)!.doc;
    expect(userValue(doc, 'reviews', 'flag')).toBe('reject');
    expect(userValue(doc, 'ratings', 'rating')).toBe(0);

    const conn = connectCatalog(lrcatPath);
    conn.prepare('UPDATE Adobe_images SET pick = 0 WHERE id_local = ?').run(IMAGE);
    conn.close();
    expect(push({ rating: false, flag: true })).toBe('pushed');
    doc = readCloudRevs(mcat, ASSET).revs.at(-1)!.doc;
    expect(userValue(doc, 'reviews', 'flag')).toBe('unflagged');
  });

  it('leaves a photo with no stars or flag alone when the cloud never had any', () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'p', rating: null, pick: 0 }]);
    addCloudSync(lrcatPath, [{ imageId: IMAGE, ozAssetId: ASSET }]);
    expect(push({ rating: true, flag: true })).toBe('unchanged');
  });

  it('chains on a Classic edit that has not uploaded yet', () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'p', rating: 4, pick: 0 }]);
    const mcat = addCloudSync(lrcatPath, [{ imageId: IMAGE, ozAssetId: ASSET }]);
    const m = new Database(mcat);
    m.prepare('UPDATE revs SET current = 0').run();
    const local = Number(
      m
        .prepare(
          "INSERT INTO revs (localDocId, revId, parentRevSequence, current, content) VALUES (1000, 'local', 1, 1, CAST(? AS TEXT))",
        )
        .run(Buffer.from(encodeMsgpack(assetDoc([['title', 'edited in Classic']])))).lastInsertRowid,
    );
    m.prepare('UPDATE docs SET winningRevSequence = ?, mostRecentRevSequence = ?').run(local, local);
    m.close();

    expect(push({ rating: true, flag: false })).toBe('pushed');
    const { revs, oz } = readCloudRevs(mcat, ASSET);
    const rev = revs.at(-1)!;
    expect(rev.parent).toBe(local);
    expect(rev.doc.get('title')).toBe('edited in Classic');
    expect(userValue(rev.doc, 'ratings', 'rating')).toBe(4);
    expect(oz).toBe(1);
  });

  it('reports photos that are not in the cloud', () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'p', rating: 2, pick: 0 }]);
    addCloudSync(lrcatPath, []);
    expect(push({ rating: true, flag: false })).toBe('not_synced');
  });

  it('is off for a catalog that does not sync', () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'p', rating: 2, pick: 0 }]);
    const conn = connectCatalog(lrcatPath);
    expect(openCloudDocstore(conn, lrcatPath)).toBeNull();
    conn.close();
  });

  it('backs the docstore up next to the catalog, not inside Sync.lrdata', () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'p', rating: 2, pick: 0 }]);
    addCloudSync(lrcatPath, [{ imageId: IMAGE, ozAssetId: ASSET }]);
    push({ rating: true, flag: false });
    expect(readdirSync(dir).filter((f) => f.startsWith('Managed Catalog.mcat.backup-'))).toHaveLength(1);
  });
});

describe('write-back carries stars and flags to the cloud', () => {
  let fx: LibraryFixture;

  beforeEach(() => {
    fx = new LibraryFixture()
      .addImage({ key: '2024-06-01_filtered-photo', id: '1' })
      .addImage({ key: '2024-06-01_p', id: '1' })
      .activate();
    const cfgPath = join(dir, 'config.yaml');
    process.env.LT_CONFIG_YAML = cfgPath;
    writeFileSync(cfgPath, stringifyYaml({ workers: 4, catalog_path: lrcatPath }));
  });

  afterEach(() => {
    fx.cleanup();
    delete process.env.LT_CONFIG_YAML;
  });

  function filteredByProfile(db: ReturnType<typeof openLibraryDb>, imageKey: string) {
    upsertCullVerdict(db, {
      imageKey,
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
  }

  it('pushes the reject it writes to the catalog', async () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'filtered-photo', pick: 0, rating: null }]);
    const mcat = addCloudSync(lrcatPath, [{ imageId: IMAGE, ozAssetId: ASSET }]);
    const db = openLibraryDb(fx.dbPath);
    seedCullingDefaults(db);
    patchLrWritebackSettings(db, { write_reject: true });
    filteredByProfile(db, '2024-06-01_filtered-photo');

    const result = await reconcileLrWriteback(db, { trigger: 'write_pending', catalogPath: lrcatPath });
    db.close();

    expect(result.catalog_updated_reject).toBe(1);
    expect(result.cloud).toEqual({ pushed: 1, not_synced: 0, unreadable: 0 });
    expect(userValue(readCloudRevs(mcat, ASSET).revs.at(-1)!.doc, 'reviews', 'flag')).toBe('reject');
  });

  it('catches up a photo written to the catalog before cloud sync existed', async () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'filtered-photo', pick: 0, rating: null }]);
    const conn = connectCatalog(lrcatPath);
    writeRejectToCatalog(conn, '2024-06-01_filtered-photo');
    conn.close();
    const mcat = addCloudSync(lrcatPath, [{ imageId: IMAGE, ozAssetId: ASSET }]);
    const db = openLibraryDb(fx.dbPath);
    seedCullingDefaults(db);
    patchLrWritebackSettings(db, { write_reject: true });
    filteredByProfile(db, '2024-06-01_filtered-photo');
    upsertWritebackState(db, {
      image_key: '2024-06-01_filtered-photo',
      kind: 'reject',
      status: 'written',
      before_pick: 0,
      before_rating: null,
      written_pick: -1,
      written_rating: null,
      stars_profile_version_id: null,
      written_at: '2026-10-20T19:42:54.074Z',
    });

    const first = await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    const second = await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    db.close();

    expect(first.catalog_updated_reject).toBe(0);
    expect(first.cloud.pushed).toBe(1);
    expect(second.cloud.pushed).toBe(0);
    expect(readCloudRevs(mcat, ASSET).revs).toHaveLength(2);
  });

  it('pushes nothing while Lightroom holds the catalog', async () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'filtered-photo', pick: 0, rating: null }]);
    const mcat = addCloudSync(lrcatPath, [{ imageId: IMAGE, ozAssetId: ASSET }]);
    writeFileSync(join(dir, 'Test.lrcat-lock'), '');
    const db = openLibraryDb(fx.dbPath);
    seedCullingDefaults(db);
    patchLrWritebackSettings(db, { write_reject: true });
    filteredByProfile(db, '2024-06-01_filtered-photo');

    const result = await reconcileLrWriteback(db, { trigger: 'job', catalogPath: lrcatPath });
    db.close();
    expect(result.reject.pending).toBe(1);
    expect(result.cloud.pushed).toBe(0);
    expect(readCloudRevs(mcat, ASSET).revs).toHaveLength(1);
  });

  it('pushes an undo', () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'p', pick: 0, rating: null }]);
    const conn = connectCatalog(lrcatPath);
    writeRejectToCatalog(conn, '2024-06-01_p');
    conn.close();
    const mcat = addCloudSync(lrcatPath, [
      {
        imageId: IMAGE,
        ozAssetId: ASSET,
        doc: assetDoc([
          ['reviews', new Map([[SYNC_USER_ID, new Map<MsgValue, MsgValue>([['date', '2026-10-20T19:42:54Z'], ['flag', 'reject']])]])],
        ]),
      },
    ]);
    const db = openLibraryDb(fx.dbPath);
    upsertWritebackState(db, {
      image_key: '2024-06-01_p',
      kind: 'reject',
      status: 'written',
      before_pick: 0,
      before_rating: null,
      written_pick: -1,
      written_rating: null,
      stars_profile_version_id: null,
      written_at: '2026-10-20T19:42:54.074Z',
    });

    expect(undoWritebackKind(db, lrcatPath, '2024-06-01_p', 'reject').ok).toBe(true);
    db.close();
    expect(userValue(readCloudRevs(mcat, ASSET).revs.at(-1)!.doc, 'reviews', 'flag')).toBe('unflagged');
  });
});