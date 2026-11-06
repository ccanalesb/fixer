/**
 * FolderWritebackCatalogWriter end-to-end against real files.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { ExifTool } from 'exiftool-vendored';
import { stringify as stringifyYaml } from 'yaml';
import { initLibraryDb, setLibraryMeta } from '../src/db/library/bootstrap.js';
import { CATALOG_KIND_META_KEY, CATALOG_PATH_META_KEY } from '../src/catalog-library.js';
import { getWritebackState } from '../src/db/library/lr-writeback-state.js';
import { patchLrWritebackSettings } from '../src/db/library/lr-writeback-settings.js';
import { upsertCullVerdict } from '../src/db/library/cull-verdicts.js';
import { syncFolderCatalog } from '../src/folder/sync.js';
import {
  FolderWritebackCatalogWriter,
  openFolderWritebackWriterSession,
} from '../src/folder/xmp-writeback-writer.js';
import * as xmpAtomicWrite from '../src/folder/xmp-atomic-write.js';
import * as xmpMetadata from '../src/folder/xmp-metadata.js';
import { AUTO_REJECT_KEYWORD, AUTO_STARS_KEYWORD } from '../src/lightroom/writeback-catalog-writer.js';
import { reconcileLrWriteback } from '../src/lightroom/writeback.js';
import { seedCullingStagesOn } from './helpers/culling-stages.js';

let dir: string;
let root: string;
let cfgPath: string;
let tool: ExifTool;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-folder-wb-writer-'));
  root = join(dir, 'photos');
  mkdirSync(root, { recursive: true });
  cfgPath = join(dir, 'config.yaml');
  process.env.LT_CONFIG_YAML = cfgPath;
  writeFileSync(cfgPath, stringifyYaml({ workers: 4, catalog_path: root }));
  tool = new ExifTool({ maxProcs: 1 });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await tool.end();
  delete process.env.LT_CONFIG_YAML;
  rmSync(dir, { recursive: true, force: true });
});

async function jpegAt(rel: string, rating?: number): Promise<string> {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })
    .jpeg()
    .toFile(path);
  if (rating != null) {
    await tool.write(path, { Rating: rating }, ['-overwrite_original']);
  }
  return path;
}

async function seedLibrary(): Promise<{ db: ReturnType<typeof initLibraryDb>; imageKey: string }> {
  const dbPath = join(dir, 'library.db');
  const db = initLibraryDb(dbPath);
  setLibraryMeta(db, CATALOG_KIND_META_KEY, 'folder');
  setLibraryMeta(db, CATALOG_PATH_META_KEY, root);
  await syncFolderCatalog(root, db, {});
  const imageKey = (db.prepare('SELECT key FROM images LIMIT 1').get() as { key: string }).key;
  seedCullingStagesOn(db);
  patchLrWritebackSettings(db, { write_reject: true, write_stars: true });
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

async function rawLibrary(name: string): Promise<{ db: ReturnType<typeof initLibraryDb>; imageKey: string }> {
  const db = initLibraryDb(join(dir, `lib-${name}.db`));
  setLibraryMeta(db, CATALOG_KIND_META_KEY, 'folder');
  setLibraryMeta(db, CATALOG_PATH_META_KEY, root);
  await syncFolderCatalog(root, db, {});
  const imageKey = (db.prepare('SELECT key FROM images LIMIT 1').get() as { key: string }).key;
  return { db, imageKey };
}

async function subjectsOf(path: string): Promise<string[]> {
  const subject = (await tool.read(path)).Subject;
  if (subject == null) return [];
  return Array.isArray(subject) ? subject.map(String) : [String(subject)];
}

describe('FolderWritebackCatalogWriter', () => {
  it('creates a sidecar for a RAW with no existing sidecar', async () => {
    const rawPath = join(root, 'frame.cr2');
    writeFileSync(rawPath, 'fake raw');
    const dbPath = join(dir, 'lib-raw.db');
    const db = initLibraryDb(dbPath);
    setLibraryMeta(db, CATALOG_KIND_META_KEY, 'folder');
    setLibraryMeta(db, CATALOG_PATH_META_KEY, root);
    await syncFolderCatalog(root, db, {});
    const imageKey = (db.prepare('SELECT key FROM images LIMIT 1').get() as { key: string }).key;
    const session = await openFolderWritebackWriterSession(root, db);
    try {
      const result = await session.writer.writeReject(imageKey);
      expect(result).toBe('updated');
      const sidecar = join(root, 'frame.xmp');
      expect(existsSync(sidecar)).toBe(true);
      const tags = await tool.read(sidecar);
      expect(Number(tags.Rating)).toBe(-1);
      expect(String(tags.Subject ?? '')).toContain(AUTO_REJECT_KEYWORD);
    } finally {
      await session.close();
      db.close();
    }
  });

  it('updates an existing sidecar and preserves unrelated metadata', async () => {
    const rawPath = join(root, 'keep.cr2');
    writeFileSync(rawPath, 'raw');
    const sidecar = join(root, 'keep.xmp');
    await tool.write(sidecar, {
      Title: 'My title',
      Subject: ['vacation', 'beach'],
    });
    const dbPath = join(dir, 'lib-side.db');
    const db = initLibraryDb(dbPath);
    setLibraryMeta(db, CATALOG_KIND_META_KEY, 'folder');
    setLibraryMeta(db, CATALOG_PATH_META_KEY, root);
    await syncFolderCatalog(root, db, {});
    const imageKey = (db.prepare('SELECT key FROM images LIMIT 1').get() as { key: string }).key;
    const session = await openFolderWritebackWriterSession(root, db);
    try {
      expect(await session.writer.writeStars(imageKey, 2)).toBe('updated');
      const tags = await tool.read(sidecar);
      expect(Number(tags.Rating)).toBe(2);
      expect(String(tags.Title)).toBe('My title');
      const subjects = Array.isArray(tags.Subject) ? tags.Subject.map(String) : [String(tags.Subject)];
      expect(subjects).toContain('vacation');
      expect(subjects).toContain('beach');
      expect(subjects).toContain(AUTO_STARS_KEYWORD);
    } finally {
      await session.close();
      db.close();
    }
  });

  it('writes embedded XMP in a JPEG and records file stats in the library', async () => {
    await jpegAt('embed.jpg');
    const dbPath = join(dir, 'lib-embed.db');
    const db = initLibraryDb(dbPath);
    setLibraryMeta(db, CATALOG_KIND_META_KEY, 'folder');
    setLibraryMeta(db, CATALOG_PATH_META_KEY, root);
    await syncFolderCatalog(root, db, {});
    const row = db.prepare('SELECT key, file_size, catalog_file_mtime FROM images LIMIT 1').get() as {
      key: string;
      file_size: number;
      catalog_file_mtime: number;
    };
    const session = await openFolderWritebackWriterSession(root, db);
    try {
      expect(await session.writer.writeStars(row.key, 1)).toBe('updated');
      const after = db
        .prepare('SELECT file_size, catalog_file_mtime FROM images WHERE key = ?')
        .get(row.key) as { file_size: number; catalog_file_mtime: number };
      const disk = statSync(join(root, 'embed.jpg'));
      expect(after.file_size).toBe(disk.size);
      expect(after.catalog_file_mtime).toBe(disk.mtimeMs);
      const sync = await syncFolderCatalog(root, db, {});
      expect(sync.result.changed).toBe(0);
    } finally {
      await session.close();
      db.close();
    }
  });

  it('adds and removes ownership keywords', async () => {
    await jpegAt('kw.jpg');
    const dbPath = join(dir, 'lib-kw.db');
    const db = initLibraryDb(dbPath);
    setLibraryMeta(db, CATALOG_KIND_META_KEY, 'folder');
    setLibraryMeta(db, CATALOG_PATH_META_KEY, root);
    await syncFolderCatalog(root, db, {});
    const imageKey = (db.prepare('SELECT key FROM images LIMIT 1').get() as { key: string }).key;
    const session = await openFolderWritebackWriterSession(root, db);
    try {
      expect(await session.writer.writeStars(imageKey, 2)).toBe('updated');
      let tags = await tool.read(join(root, 'kw.jpg'));
      expect(String(tags.Subject ?? '')).toContain(AUTO_STARS_KEYWORD);
      expect(await session.writer.clearStars(imageKey, 2)).toBe('updated');
      tags = await tool.read(join(root, 'kw.jpg'));
      const subject = tags.Subject;
      if (subject != null) {
        const flat = Array.isArray(subject) ? subject.map(String) : [String(subject)];
        expect(flat).not.toContain(AUTO_STARS_KEYWORD);
      }
    } finally {
      await session.close();
      db.close();
    }
  });

  it('skips a photo the user already rated', async () => {
    await jpegAt('rated.jpg', 4);
    const { db, imageKey } = await seedLibrary();
    try {
      const session = await openFolderWritebackWriterSession(root, db);
      try {
        expect(await session.writer.writeReject(imageKey)).toBe('skipped');
      } finally {
        await session.close();
      }
      await reconcileLrWriteback(db, { trigger: 'write_pending', catalogPath: root });
      const row = getWritebackState(db, imageKey, 'reject');
      expect(row?.status).toBe('skipped');
    } finally {
      db.close();
    }
  });

  it('leaves write-back pending when mtime changes mid-write', async () => {
    await jpegAt('race.jpg');
    const { db, imageKey } = await seedLibrary();
    const realSnapshot = xmpAtomicWrite.snapshotMtime;
    vi.spyOn(xmpAtomicWrite, 'snapshotMtime').mockImplementation((path) => {
      const guard = realSnapshot(path);
      if (guard && path.endsWith('race.jpg')) {
        utimesSync(path, new Date(), new Date(Date.now() + 60_000));
      }
      return guard;
    });
    try {
      await reconcileLrWriteback(db, { trigger: 'write_pending', catalogPath: root });
      const row = getWritebackState(db, imageKey, 'reject');
      expect(row?.status).toBe('pending');
    } finally {
      db.close();
    }
  });

  it('reports a read-only file and stays pending', async () => {
    const path = await jpegAt('readonly.jpg');
    const { db, imageKey } = await seedLibrary();
    try {
      chmodSync(path, 0o444);
      chmodSync(root, 0o555);
      const result = await reconcileLrWriteback(db, { trigger: 'write_pending', catalogPath: root });
      expect(result.reject.file_error).toBeGreaterThan(0);
      const row = getWritebackState(db, imageKey, 'reject');
      expect(row?.status).toBe('pending');
    } finally {
      chmodSync(root, 0o755);
      chmodSync(path, 0o644);
      db.close();
    }
  });

  it('writes only under a symlinked catalog root', async () => {
    const realRoot = join(dir, 'real-catalog');
    mkdirSync(realRoot, { recursive: true });
    symlinkSync(realRoot, join(dir, 'link-root'));
    const linkRoot = join(dir, 'link-root');
    await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .jpeg()
      .toFile(join(linkRoot, 'via-link.jpg'));
    const dbPath = join(dir, 'lib-link.db');
    const db = initLibraryDb(dbPath);
    setLibraryMeta(db, CATALOG_KIND_META_KEY, 'folder');
    setLibraryMeta(db, CATALOG_PATH_META_KEY, linkRoot);
    await syncFolderCatalog(linkRoot, db, {});
    const imageKey = (db.prepare('SELECT key FROM images LIMIT 1').get() as { key: string }).key;
    const writer = new FolderWritebackCatalogWriter(linkRoot, db);
    try {
      expect(await writer.writeStars(imageKey, 1)).toBe('updated');
      const tags = await tool.read(join(realRoot, 'via-link.jpg'));
      expect(Number(tags.Rating)).toBe(1);
      const outside = join(dir, 'outside.jpg');
      writeFileSync(outside, 'x');
      const outcome = await xmpAtomicWrite.atomicReplaceFileAsync(linkRoot, outside, [], async () => {});
      expect(outcome).toBe('outside');
      expect(readFileSync(outside, 'utf8')).toBe('x');
    } finally {
      await writer.close();
      db.close();
    }
  });

  it('re-reads live rating after prefetch before writing', async () => {
    await jpegAt('fresh.jpg');
    const { db, imageKey } = await seedLibrary();
    try {
      const session = await openFolderWritebackWriterSession(root, db);
      try {
        await session.writer.prefetch([imageKey]);
        await tool.write(join(root, 'fresh.jpg'), { Rating: 5 }, ['-overwrite_original']);
        expect(await session.writer.writeReject(imageKey)).toBe('skipped');
      } finally {
        await session.close();
      }
    } finally {
      db.close();
    }
  });

  it('leaves only the photo and its sidecar after an update and an undo', async () => {
    writeFileSync(join(root, 'tidy.cr2'), 'raw');
    await tool.write(join(root, 'tidy.xmp'), { Subject: ['trip'] });
    const { db, imageKey } = await rawLibrary('tidy');
    const session = await openFolderWritebackWriterSession(root, db);
    try {
      expect(await session.writer.writeStars(imageKey, 2)).toBe('updated');
      expect(readdirSync(root).sort()).toEqual(['tidy.cr2', 'tidy.xmp']);
      expect(await session.writer.undoStars(imageKey, null)).toBe('updated');
      expect(readdirSync(root).sort()).toEqual(['tidy.cr2', 'tidy.xmp']);
    } finally {
      await session.close();
      db.close();
    }
  });

  it('skips and leaves the file alone when it changes while the writer reads it', async () => {
    const path = await jpegAt('edited.jpg');
    const { db, imageKey } = await seedLibrary();
    const realRead = xmpMetadata.readFolderPhotoXmpMetadata;
    let edited: Buffer | null = null;
    vi.spyOn(xmpMetadata, 'readFolderPhotoXmpMetadata').mockImplementation(async (...args) => {
      const meta = await realRead(...args);
      await tool.write(path, { Subject: ['mine'] }, ['-overwrite_original']);
      utimesSync(path, new Date(), new Date(Date.now() + 60_000));
      edited = readFileSync(path);
      return meta;
    });
    const session = await openFolderWritebackWriterSession(root, db);
    try {
      expect(await session.writer.writeReject(imageKey)).toBe('mtime_conflict');
      expect(readFileSync(path).equals(edited!)).toBe(true);
    } finally {
      await session.close();
      db.close();
    }
  });

  it('keeps each sidecar its own keywords', async () => {
    writeFileSync(join(root, 'pair.cr2'), 'raw');
    const fileSidecar = join(root, 'pair.cr2.xmp');
    const stemSidecar = join(root, 'pair.xmp');
    await tool.write(fileSidecar, { Subject: ['alpha'] });
    await tool.write(stemSidecar, { Subject: ['beta'] });
    const { db, imageKey } = await rawLibrary('pair');
    const session = await openFolderWritebackWriterSession(root, db);
    try {
      expect(await session.writer.writeStars(imageKey, 2)).toBe('updated');
      expect((await subjectsOf(fileSidecar)).sort()).toEqual(['alpha', AUTO_STARS_KEYWORD].sort());
      expect((await subjectsOf(stemSidecar)).sort()).toEqual(['beta', AUTO_STARS_KEYWORD].sort());
      expect(await session.writer.undoStars(imageKey, null)).toBe('updated');
      expect(await subjectsOf(fileSidecar)).toEqual(['alpha']);
      expect(await subjectsOf(stemSidecar)).toEqual(['beta']);
    } finally {
      await session.close();
      db.close();
    }
  });

  it('writes no sidecar when any of them cannot be written', async () => {
    writeFileSync(join(root, 'locked.cr2'), 'raw');
    const fileSidecar = join(root, 'locked.cr2.xmp');
    const stemSidecar = join(root, 'locked.xmp');
    await tool.write(fileSidecar, { Subject: ['alpha'] });
    await tool.write(stemSidecar, { Subject: ['beta'] });
    const { db, imageKey } = await rawLibrary('locked');
    const before = [readFileSync(fileSidecar), readFileSync(stemSidecar)];
    chmodSync(stemSidecar, 0o444);
    const session = await openFolderWritebackWriterSession(root, db);
    try {
      expect(await session.writer.writeStars(imageKey, 2)).toBe('readonly_error');
      expect(readFileSync(fileSidecar).equals(before[0]!)).toBe(true);
      expect(readFileSync(stemSidecar).equals(before[1]!)).toBe(true);
    } finally {
      chmodSync(stemSidecar, 0o644);
      await session.close();
      db.close();
    }
  });
});
