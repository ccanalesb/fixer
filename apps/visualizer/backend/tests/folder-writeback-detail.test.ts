/**
 * Folder-catalog write-back readout and undo from live XMP (image modal XMP tab).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { syncFolderCatalog } from '../src/folder/sync.js';
import {
  buildWritebackPhotoDetail,
  reconcileLrWriteback,
  undoWritebackKind,
} from '../src/lightroom/writeback.js';
import { AUTO_REJECT_KEYWORD } from '../src/lightroom/writeback-catalog-writer.js';
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

      const undo = await undoWritebackKind(db, root, imageKey, 'reject');
      expect(undo.ok).toBe(true);

      const tags = await tool.read(join(root, 'shot.jpg'));
      expect(Number(tags.Rating ?? 0)).toBe(0);
      const subjects = tags.Subject;
      const kwList = subjects == null ? [] : Array.isArray(subjects) ? subjects : [subjects];
      expect(kwList.map(String)).not.toContain(AUTO_REJECT_KEYWORD);

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
    } finally {
      db.close();
    }
  });
});
