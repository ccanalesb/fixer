/**
 * Folder-catalog write-back readout and undo from live XMP (image modal XMP tab).
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { ExifTool } from 'exiftool-vendored';
import { stringify as stringifyYaml } from 'yaml';
import { initLibraryDb, setLibraryMeta } from '../src/db/library/bootstrap.js';
import { CATALOG_KIND_META_KEY, CATALOG_PATH_META_KEY } from '../src/catalog-library.js';
import { patchLrWritebackSettings, getLrWritebackSettings } from '../src/db/library/lr-writeback-settings.js';
import { upsertCullVerdict } from '../src/db/library/cull-verdicts.js';
import { getWritebackState, upsertWritebackState } from '../src/db/library/lr-writeback-state.js';
import { libraryWrite } from '../src/db/library/write.js';
import { syncFolderCatalog } from '../src/folder/sync.js';
import { openFolderWritebackWriterSession } from '../src/folder/xmp-writeback-writer.js';
import {
  buildWritebackPhotoDetail,
  reconcileLrWriteback,
  undoWritebackKind,
} from '../src/lightroom/writeback.js';
import { AUTO_REJECT_KEYWORD, AUTO_STARS_KEYWORD } from '../src/lightroom/writeback-catalog-writer.js';
import { nowIsoUtc } from '../src/utils/datetime.js';
import { seedCullingStagesOn } from './helpers/culling-stages.js';

let dir: string;
let root: string;
let cfgPath: string;
let tool: ExifTool;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lt-folder-wb-detail-'));
  root = join(dir, 'photos');
  mkdirSync(root, { recursive: true });
  cfgPath = join(dir, 'config.yaml');
  process.env.LT_CONFIG_YAML = cfgPath;
  writeFileSync(cfgPath, stringifyYaml({ workers: 4, catalog_path: root }));
  tool = new ExifTool({ maxProcs: 1 });
  await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })
    .jpeg()
    .toFile(join(root, 'shot.jpg'));
});

afterEach(async () => {
  await tool.end();
  delete process.env.LT_CONFIG_YAML;
  rmSync(dir, { recursive: true, force: true });
});

async function seedFilteredPhoto(): Promise<{ db: ReturnType<typeof initLibraryDb>; imageKey: string }> {
  const dbPath = join(dir, 'library.db');
  const db = initLibraryDb(dbPath);
  setLibraryMeta(db, CATALOG_KIND_META_KEY, 'folder');
  setLibraryMeta(db, CATALOG_PATH_META_KEY, root);
  await syncFolderCatalog(root, db, {});
  const imageKey = (db.prepare('SELECT key FROM images LIMIT 1').get() as { key: string }).key;
  seedCullingStagesOn(db);
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
  return { db, imageKey };
}

describe('folder write-back detail and undo', () => {
  it('reads live reject and offers undo after write-back', async () => {
    const { db, imageKey } = await seedFilteredPhoto();
    try {
      await reconcileLrWriteback(db, { trigger: 'write_pending', catalogPath: root });
      const settings = getLrWritebackSettings(db);
      const detail = await buildWritebackPhotoDetail(db, root, imageKey, settings);
      expect(detail.flag.app_wrote_reject).toBe(true);
      expect(detail.flag.undo_available).toBe(true);
      expect(detail.flag.live_pick).toBe(-1);
      expect(detail.keywords).toContain(AUTO_REJECT_KEYWORD);
      expect(detail.written_file_label).toBe('embedded in shot.jpg');

      const undo = await undoWritebackKind(db, root, imageKey, 'reject');
      expect(undo.ok).toBe(true);

      const tags = await tool.read(join(root, 'shot.jpg'));
      expect(Number(tags.Rating ?? 0)).toBe(0);
      const subjects = tags.Subject;
      const kwList = subjects == null ? [] : Array.isArray(subjects) ? subjects : [subjects];
      expect(kwList.map(String)).not.toContain(AUTO_REJECT_KEYWORD);

      const row = db.prepare('SELECT rating, pick FROM images WHERE key = ?').get(imageKey) as {
        rating: number | null;
        pick: number;
      };
      expect(row.rating).toBe(0);
      expect(row.pick).toBe(0);

      const after = await buildWritebackPhotoDetail(db, root, imageKey, settings);
      expect(after.flag.undo_available).toBe(false);
      expect(after.flag.app_wrote_reject).toBe(false);
    } finally {
      db.close();
    }
  });

  it('treats a user edit after write as undone in the file', async () => {
    const { db, imageKey } = await seedFilteredPhoto();
    try {
      await reconcileLrWriteback(db, { trigger: 'write_pending', catalogPath: root });
      const settings = getLrWritebackSettings(db);
      await tool.write(join(root, 'shot.jpg'), { Rating: 3 }, ['-overwrite_original']);

      const detail = await buildWritebackPhotoDetail(db, root, imageKey, settings);
      expect(detail.flag.user_changed).toBe(true);
      expect(detail.flag.undo_available).toBe(false);
      expect(detail.user_changed_message).toContain('shot.jpg');
    } finally {
      db.close();
    }
  });

  it('undo of embedded stars round-trips to the before rating', async () => {
    const path = join(root, 'embed.jpg');
    await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 4, g: 5, b: 6 } },
    })
      .jpeg()
      .toFile(path);
    const dbPath = join(dir, 'lib-embed-undo.db');
    const db = initLibraryDb(dbPath);
    setLibraryMeta(db, CATALOG_KIND_META_KEY, 'folder');
    setLibraryMeta(db, CATALOG_PATH_META_KEY, root);
    await syncFolderCatalog(root, db, {});
    const imageKey = (db.prepare('SELECT key FROM images WHERE filename = ?').get('embed') as {
      key: string;
    }).key;
    try {
      const session = await openFolderWritebackWriterSession(root, db);
      try {
        expect(await session.writer.writeStars(imageKey, 2)).toBe('updated');
      } finally {
        await session.close();
      }
      libraryWrite(db, () =>
        upsertWritebackState(db, {
          image_key: imageKey,
          kind: 'stars',
          status: 'written',
          before_pick: null,
          before_rating: 3,
          written_pick: null,
          written_rating: 2,
          stars_profile_version_id: null,
          written_at: nowIsoUtc(),
        }),
      );
      await tool.write(path, { Rating: 2, Subject: [AUTO_STARS_KEYWORD] }, ['-overwrite_original']);

      const undo = await undoWritebackKind(db, root, imageKey, 'stars');
      expect(undo.ok).toBe(true);
      const tags = await tool.read(path);
      expect(Number(tags.Rating)).toBe(3);
      const row = db.prepare('SELECT rating FROM images WHERE key = ?').get(imageKey) as { rating: number };
      expect(row.rating).toBe(3);
      expect(getWritebackState(db, imageKey, 'stars')?.status).toBe('undone');
    } finally {
      db.close();
    }
  });

  it('undo of stars in a sidecar round-trips to the before value', async () => {
    const rawPath = join(root, 'frame.cr2');
    writeFileSync(rawPath, 'raw bytes');
    const sidecar = join(root, 'frame.xmp');
    const dbPath = join(dir, 'lib-side-undo.db');
    const db = initLibraryDb(dbPath);
    setLibraryMeta(db, CATALOG_KIND_META_KEY, 'folder');
    setLibraryMeta(db, CATALOG_PATH_META_KEY, root);
    await syncFolderCatalog(root, db, {});
    const imageKey = (db.prepare('SELECT key FROM images LIMIT 1').get() as { key: string }).key;
    try {
      await tool.write(sidecar, { Rating: 2, Subject: [AUTO_STARS_KEYWORD] });
      libraryWrite(db, () =>
        upsertWritebackState(db, {
          image_key: imageKey,
          kind: 'stars',
          status: 'written',
          before_pick: null,
          before_rating: 1,
          written_pick: null,
          written_rating: 2,
          stars_profile_version_id: null,
          written_at: nowIsoUtc(),
        }),
      );

      const undo = await undoWritebackKind(db, root, imageKey, 'stars');
      expect(undo.ok).toBe(true);
      const tags = await tool.read(sidecar);
      expect(Number(tags.Rating)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('refuses undo when the file no longer matches what the app wrote', async () => {
    const { db, imageKey } = await seedFilteredPhoto();
    try {
      await reconcileLrWriteback(db, { trigger: 'write_pending', catalogPath: root });
      await tool.write(join(root, 'shot.jpg'), { Rating: 4 }, ['-overwrite_original']);
      const undo = await undoWritebackKind(db, root, imageKey, 'reject');
      expect(undo.ok).toBe(false);
      expect(undo.reason).toContain('no longer holds');
      expect(getWritebackState(db, imageKey, 'reject')?.status).toBe('written');
    } finally {
      db.close();
    }
  });

  it('reports a read-only file on undo and leaves write-back state', async () => {
    const { db, imageKey } = await seedFilteredPhoto();
    const path = join(root, 'shot.jpg');
    try {
      await reconcileLrWriteback(db, { trigger: 'write_pending', catalogPath: root });
      chmodSync(path, 0o444);
      chmodSync(root, 0o555);
      const undo = await undoWritebackKind(db, root, imageKey, 'reject');
      expect(undo.ok).toBe(false);
      expect(undo.reason).toMatch(/read-only/i);
      expect(getWritebackState(db, imageKey, 'reject')?.status).toBe('written');
    } finally {
      chmodSync(root, 0o755);
      chmodSync(path, 0o644);
      db.close();
    }
  });
});
