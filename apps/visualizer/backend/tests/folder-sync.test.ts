/**
 * Folder catalog import and re-sync into library.db.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tags } from 'exiftool-vendored';
import sharp from 'sharp';
import { initLibraryDb, getLibraryMeta } from '../src/db/library/bootstrap.js';
import { getImageCount } from '../src/db/library/statistics.js';
import { isDescriptionStale } from '../src/db/library/vision-stale.js';
import {
  buildFolderCatalogRecords,
  captureDateFromTags,
  createFolderExifSession,
} from '../src/folder/exif-read.js';
import { FOLDER_CATALOG_SYNCED_META_KEY, syncFolderCatalog } from '../src/folder/sync.js';
import { hasChangedSinceRanking } from '../src/db/library/ranking-stale.js';
import type { ResolvedFolderPhoto } from '../src/folder/walk.js';
import { getOrCreateCachedImage } from '../src/vision/vision-cache.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const sampleHeic = join(fixtureDir, 'example.heic');

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

  it('when cancelled mid-import keeps batches already read and does not mark gone or synced', async () => {
    for (let i = 0; i < 65; i += 1) {
      writeFileSync(join(root, `batch-${i}.jpg`), 'fake-jpeg');
    }
    const db = initLibraryDb(dbPath);
    try {
      let progressCalls = 0;
      const { cancelled, result } = await syncFolderCatalog(root, db, {
        progress: () => {
          progressCalls += 1;
        },
        isCancelled: () => progressCalls >= 1,
      });
      expect(cancelled).toBe(true);
      expect(result.added).toBe(64);
      expect(result.newly_gone).toBe(0);
      expect(getImageCount(db)).toBe(64);
      expect(getLibraryMeta(db, FOLDER_CATALOG_SYNCED_META_KEY)).toBeNull();
    } finally {
      db.close();
    }
  }, 60_000);

  it('records a key collision when a new path shares an existing key', async () => {
    const fixed = new Date('2018-08-08T08:08:08Z');
    mkdirSync(join(root, 'a'), { recursive: true });
    mkdirSync(join(root, 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'dup.jpg'), 'bytes');
    writeFileSync(join(root, 'b', 'dup.jpg'), 'bytes');
    utimesSync(join(root, 'a', 'dup.jpg'), fixed, fixed);
    utimesSync(join(root, 'b', 'dup.jpg'), fixed, fixed);
    const db = initLibraryDb(dbPath);
    try {
      await syncFolderCatalog(root, db, {});
      expect(getImageCount(db)).toBe(1);

      rmSync(join(root, 'a', 'dup.jpg'));
      writeFileSync(join(root, 'a', 'dup.jpg'), 'bytes');
      utimesSync(join(root, 'a', 'dup.jpg'), fixed, fixed);

      const { result } = await syncFolderCatalog(root, db, {});
      expect(result.collisions).toBeGreaterThanOrEqual(1);
      expect(getImageCount(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('treats a RAW+JPEG pair forming and breaking as in-place edits', async () => {
    mkdirSync(join(root, 'pair'), { recursive: true });
    const rawPath = join(root, 'pair', 'img.cr2');
    const jpegPath = join(root, 'pair', 'img.jpg');
    writeFileSync(rawPath, 'raw-bytes');
    const touch = new Date('2017-07-07T07:07:07Z');
    utimesSync(rawPath, touch, touch);
    const db = initLibraryDb(dbPath);
    try {
      await syncFolderCatalog(root, db, {});
      writeFileSync(jpegPath, 'jpeg-bytes');
      utimesSync(rawPath, new Date('2017-07-08T07:07:07Z'), new Date('2017-07-08T07:07:07Z'));
      const paired = await syncFolderCatalog(root, db, {});
      expect(paired.result.changed).toBe(1);
      expect(getImageCount(db)).toBe(1);

      rmSync(jpegPath);
      utimesSync(rawPath, new Date('2017-07-09T07:07:07Z'), new Date('2017-07-09T07:07:07Z'));
      const alone = await syncFolderCatalog(root, db, {});
      expect(alone.result.changed).toBe(1);
    } finally {
      db.close();
    }
  });

  it('marks vision outputs stale when pixels change but not for a metadata-only touch', async () => {
    const path = join(root, 'meta.jpg');
    await sharp({ create: { width: 32, height: 32, channels: 3, background: '#111111' } })
      .jpeg()
      .toFile(path);
    const db = initLibraryDb(dbPath);
    try {
      await syncFolderCatalog(root, db, {});
      const key = (db.prepare('SELECT key FROM images').get() as { key: string }).key;
      db.prepare(
        "INSERT INTO image_descriptions (image_key, image_type, summary, best_perspective) VALUES (?, 'catalog', 'desc', 'street')",
      ).run(key);
      process.env.LT_CONFIG_YAML = join(dir, 'cfg.yaml');
      writeFileSync(
        join(dir, 'cfg.yaml'),
        `vision_cache_dir: ${join(dir, 'vc')}\nmount_point: ${dir}\n`,
      );
      await getOrCreateCachedImage(db, key, path);

      utimesSync(path, new Date('2030-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'));
      await syncFolderCatalog(root, db, {});
      expect(isDescriptionStale(db, key)).toBe(false);

      await sharp({ create: { width: 32, height: 32, channels: 3, background: '#eeeeee' } })
        .jpeg()
        .toFile(path);
      writeFileSync(path, Buffer.from(await sharp(path).toBuffer())); // force size change
      await syncFolderCatalog(root, db, {});
      expect(isDescriptionStale(db, key)).toBe(true);
    } finally {
      delete process.env.LT_CONFIG_YAML;
      db.close();
    }
  });

  it('keeps descriptions and culling rows when a photo is moved or edited', async () => {
    const path = join(root, 'keep-work.jpg');
    writeFileSync(path, 'v1');
    const db = initLibraryDb(dbPath);
    try {
      await syncFolderCatalog(root, db, {});
      const key = (db.prepare('SELECT key FROM images').get() as { key: string }).key;
      db.prepare(
        "INSERT INTO image_descriptions (image_key, image_type, summary, best_perspective) VALUES (?, 'catalog', 'hello', 'street')",
      ).run(key);
      db.prepare(
        `INSERT INTO cull_verdicts (image_key, verdict, culling_profile_verdict, pipeline_setting_version, decided_at)
         VALUES (?, 'passed', 'passed', 1, '2020-01-01T00:00:00')`,
      ).run(key);

      const movedPath = join(root, 'renamed.jpg');
      writeFileSync(movedPath, 'v1');
      rmSync(path);
      await syncFolderCatalog(root, db, {});
      expect(
        db.prepare('SELECT summary FROM image_descriptions WHERE image_key = ?').get(key),
      ).toEqual({ summary: 'hello' });
      expect(
        db.prepare('SELECT verdict FROM cull_verdicts WHERE image_key = ?').get(key),
      ).toEqual({ verdict: 'passed' });

      writeFileSync(movedPath, 'v2-edited');
      await syncFolderCatalog(root, db, {});
      expect(
        db.prepare('SELECT summary FROM image_descriptions WHERE image_key = ?').get(key),
      ).toEqual({ summary: 'hello' });
    } finally {
      db.close();
    }
  });

  it('keeps the original key when an in-place edit changes capture-derived key fields', async () => {
    const path = join(root, 'key-lock.jpg');
    writeFileSync(path, 'v1');
    const db = initLibraryDb(dbPath);
    try {
      await syncFolderCatalog(root, db, {});
      const before = db.prepare('SELECT key FROM images').get() as { key: string };

      writeFileSync(path, 'v2');
      utimesSync(path, new Date('1999-12-31T23:59:59Z'), new Date('1999-12-31T23:59:59Z'));
      await syncFolderCatalog(root, db, {});
      const after = db.prepare('SELECT key FROM images').get() as { key: string };
      expect(after.key).toBe(before.key);
    } finally {
      db.close();
    }
  });

  it('re-reads only the photo whose sidecar changed', async () => {
    const path = join(root, 'rated.jpg');
    writeFileSync(path, 'fake-jpeg');
    writeFileSync(join(root, 'other.jpg'), 'fake-jpeg-2');
    const db = initLibraryDb(dbPath);
    try {
      await syncFolderCatalog(root, db, {});
      const sidecar = join(root, 'rated.jpg.xmp');
      writeFileSync(
        sidecar,
        `<?xml version='1.0'?><x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#' xmlns:xmp='http://ns.adobe.com/xap/1.0/'><rdf:Description rdf:about='' xmp:Rating='4'/></rdf:RDF></x:xmpmeta>`,
      );
      utimesSync(sidecar, new Date('2031-01-01T00:00:00Z'), new Date('2031-01-01T00:00:00Z'));

      const { result } = await syncFolderCatalog(root, db, {});
      expect(result.changed).toBe(0);
      expect(result.metadata_changed).toBe(1);
      const rated = db.prepare('SELECT rating FROM images WHERE id = ?').get('rated.jpg') as {
        rating: number;
      };
      const other = db.prepare('SELECT rating FROM images WHERE id = ?').get('other.jpg') as {
        rating: number;
      };
      expect(rated.rating).toBe(4);
      expect(other.rating).toBe(0);
    } finally {
      db.close();
    }
  });

  it('sets the changed-since-ranking mark when only a rating changes in XMP', async () => {
    const path = join(root, 'star.jpg');
    writeFileSync(path, 'fake-jpeg');
    const db = initLibraryDb(dbPath);
    try {
      await syncFolderCatalog(root, db, {});
      expect(hasChangedSinceRanking(db)).toBe(true);
      const { libraryWrite } = await import('../src/db/library/write.js');
      const { clearChangedSinceRanking } = await import('../src/db/library/ranking-stale.js');
      libraryWrite(db, () => clearChangedSinceRanking(db));

      writeFileSync(
        join(root, 'star.jpg.xmp'),
        `<?xml version='1.0'?><x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#' xmlns:xmp='http://ns.adobe.com/xap/1.0/'><rdf:Description rdf:about='' xmp:Rating='2'/></rdf:RDF></x:xmpmeta>`,
      );
      utimesSync(
        join(root, 'star.jpg.xmp'),
        new Date('2032-01-01T00:00:00Z'),
        new Date('2032-01-01T00:00:00Z'),
      );
      await syncFolderCatalog(root, db, {});
      expect(hasChangedSinceRanking(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('completes when a corrupt HEIC is present and keeps the other photos', async () => {
    writeFileSync(join(root, 'bad.heic'), 'not-a-heic');
    writeFileSync(join(root, 'good.jpg'), 'fake-jpeg');
    copyFileSync(sampleHeic, join(root, 'fine.heic'));
    const db = initLibraryDb(dbPath);
    const logs: string[] = [];
    try {
      const { cancelled, result } = await syncFolderCatalog(root, db, {
        log: (_level, msg) => logs.push(msg),
      });
      expect(cancelled).toBe(false);
      expect(result.added).toBe(3);
      expect(getImageCount(db)).toBe(3);
      expect(
        db.prepare("SELECT COUNT(*) AS c FROM images WHERE id IN ('good.jpg', 'fine.heic')").get() as {
          c: number;
        },
      ).toEqual({ c: 2 });
    } finally {
      db.close();
    }
  });
});
