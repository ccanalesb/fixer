/**
 * Folder catalog import and re-sync into library.db.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tags } from 'exiftool-vendored';
import { initLibraryDb } from '../src/db/library/bootstrap.js';
import { getImageCount } from '../src/db/library/statistics.js';
import {
  buildFolderCatalogRecords,
  captureDateFromTags,
  createFolderExifSession,
} from '../src/folder/exif-read.js';
import { syncFolderCatalog } from '../src/folder/sync.js';
import type { ResolvedFolderPhoto } from '../src/folder/walk.js';

let dir: string;
let root: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-folder-sync-'));
  root = join(dir, 'photos');
  mkdirSync(root, { recursive: true });
  dbPath = join(dir, 'library.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createFolderExifSession', () => {
  it('configures more than one exiftool process when workers allow', () => {
    vi.stubEnv('FOLDER_EXIF_WORKERS', '4');
    const session = createFolderExifSession();
    expect(session.maxProcs).toBeGreaterThan(1);
    void session.end();
    vi.unstubAllEnvs();
  });
});

describe('captureDateFromTags', () => {
  it('prefers DateTimeOriginal, then CreateDate, then DateTimeDigitized, then mtime', () => {
    const path = join(root, 'dated.jpg');
    writeFileSync(path, 'x');
    const base = {} as Tags;
    expect(captureDateFromTags({ ...base, DateTimeOriginal: '2020:01:02 03:04:05' }, path)).toBe(
      '2020-01-02T03:04:05',
    );
    expect(captureDateFromTags({ ...base, CreateDate: '2021:02:03 04:05:06' }, path)).toBe(
      '2021-02-03T04:05:06',
    );
    expect(captureDateFromTags({ ...base, DateTimeDigitized: '2022:03:04 05:06:07' }, path)).toBe(
      '2022-03-04T05:06:07',
    );
    utimesSync(path, new Date('2019-06-01T12:00:00Z'), new Date('2019-06-01T12:00:00Z'));
    expect(captureDateFromTags(base, path)).toMatch(/^2019-06-01T/);
  });
});

describe('buildFolderCatalogRecords', () => {
  it('keeps the last sorted path when two files share a key', () => {
    const photos: ResolvedFolderPhoto[] = [
      { filepath: join(root, 'a', 'x.jpg'), relPath: 'a/x.jpg', filename: 'x', stem: 'x' },
      { filepath: join(root, 'b', 'x.jpg'), relPath: 'b/x.jpg', filename: 'x', stem: 'x' },
    ];
    const tags = new Map(photos.map((p) => [p.filepath, { DateTimeOriginal: '2024:01:01 00:00:00' } as Tags]));
    const records = buildFolderCatalogRecords(photos, tags);
    expect(records).toHaveLength(1);
    expect(records[0]!.filepath).toContain(join('b', 'x.jpg'));
  });
});

describe('syncFolderCatalog', () => {
  it('inserts walked photos with capture dates', async () => {
    writeFileSync(join(root, 'one.jpg'), 'fake-jpeg');
    const db = initLibraryDb(dbPath);
    try {
      const { result, cancelled } = await syncFolderCatalog(root, db, {});
      expect(cancelled).toBe(false);
      expect(result.added).toBe(1);
      expect(getImageCount(db)).toBe(1);
      const row = db.prepare('SELECT key, date_taken, filepath, id FROM images').get() as {
        key: string;
        date_taken: string;
        filepath: string;
        id: string;
      };
      expect(row.filepath).toContain('one.jpg');
      expect(row.id).toBe('one.jpg');
      expect(row.key).toMatch(/^\d{4}-\d{2}-\d{2}_one$/);
      expect(row.date_taken.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('re-syncs an unchanged tree without re-adding rows', async () => {
    writeFileSync(join(root, 'one.jpg'), 'fake-jpeg');
    const db = initLibraryDb(dbPath);
    try {
      await syncFolderCatalog(root, db, {});
      const { result } = await syncFolderCatalog(root, db, {});
      expect(result.added).toBe(0);
      expect(result.changed).toBe(0);
      expect(getImageCount(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('a renamed file matching one gone photo on size and capture time keeps its key', async () => {
    const fixed = new Date('2020-05-05T05:05:05Z');
    writeFileSync(join(root, 'a.jpg'), 'same-bytes');
    utimesSync(join(root, 'a.jpg'), fixed, fixed);
    const db = initLibraryDb(dbPath);
    try {
      await syncFolderCatalog(root, db, {});
      const before = db.prepare('SELECT key FROM images').get() as { key: string };

      rmSync(join(root, 'a.jpg'));
      writeFileSync(join(root, 'b.jpg'), 'same-bytes');
      utimesSync(join(root, 'b.jpg'), fixed, fixed);

      const { result } = await syncFolderCatalog(root, db, {});
      expect(result.moved).toBe(1);
      expect(result.added).toBe(0);
      expect(getImageCount(db)).toBe(1);
      const after = db.prepare('SELECT key, id, catalog_missing_since FROM images').get() as {
        key: string;
        id: string;
        catalog_missing_since: string | null;
      };
      expect(after.key).toBe(before.key);
      expect(after.id).toBe('b.jpg');
      expect(after.catalog_missing_since).toBeNull();
    } finally {
      db.close();
    }
  });

  it('a deleted file keeps its row and is marked gone, then un-gone when it returns', async () => {
    writeFileSync(join(root, 'keep.jpg'), 'fake-jpeg');
    const db = initLibraryDb(dbPath);
    try {
      await syncFolderCatalog(root, db, {});
      const key = (db.prepare('SELECT key FROM images').get() as { key: string }).key;

      rmSync(join(root, 'keep.jpg'));
      const gone = await syncFolderCatalog(root, db, {});
      expect(gone.result.newly_gone).toBe(1);
      expect(gone.result.stale).toBe(1);
      expect(getImageCount(db)).toBe(1);
      const row = db.prepare('SELECT catalog_missing_since FROM images WHERE key = ?').get(key) as {
        catalog_missing_since: string | null;
      };
      expect(row.catalog_missing_since).not.toBeNull();

      writeFileSync(join(root, 'keep.jpg'), 'fake-jpeg');
      const back = await syncFolderCatalog(root, db, {});
      expect(back.result.stale).toBe(0);
      const cleared = db
        .prepare('SELECT catalog_missing_since FROM images WHERE key = ?')
        .get(key) as { catalog_missing_since: string | null };
      expect(cleared.catalog_missing_since).toBeNull();
    } finally {
      db.close();
    }
  });

  it('a file edited in place is re-read and reported as changed', async () => {
    const path = join(root, 'edit.jpg');
    writeFileSync(path, 'first');
    utimesSync(path, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    const db = initLibraryDb(dbPath);
    try {
      await syncFolderCatalog(root, db, {});

      writeFileSync(path, 'second-contents-different-size');
      utimesSync(path, new Date('2021-01-01T00:00:00Z'), new Date('2021-01-01T00:00:00Z'));
      const { result } = await syncFolderCatalog(root, db, {});
      expect(result.changed).toBe(1);
      expect(result.added).toBe(0);
      expect(getImageCount(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('a root that is not there is treated like "catalog not found"', async () => {
    const db = initLibraryDb(dbPath);
    try {
      await expect(syncFolderCatalog(join(dir, 'missing'), db, {})).rejects.toThrow(
        /Catalog not found/,
      );
    } finally {
      db.close();
    }
  });
});
