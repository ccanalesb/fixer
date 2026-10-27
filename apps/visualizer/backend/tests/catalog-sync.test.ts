/**
 * Lightroom reader, incremental sync driver, and `catalog_sync` job — against a
 * real `.lrcat` SQLite fixture.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { makeFakeCatalog, type CatalogFile } from './helpers/fake-catalog.js';
import { LibraryFixture } from './helpers/library-fixture.js';
import { openLibraryDb, type Db } from '../src/db/connection.js';
import { createJob, getJob, initJobsDb } from '../src/db/jobs/jobs.js';
import {
  getLibraryMeta,
  setLibraryMeta,
  SYNCED_CATALOG_META_KEY,
} from '../src/db/library/bootstrap.js';
import { libraryWrite } from '../src/db/library/write.js';
import { JobRunner } from '../src/jobs/runner.js';
import { tick } from '../src/jobs/processor.js';
import {
  CATALOG_LOCKED_MSG,
  CatalogSyncError,
  catalogSyncErrorMessage,
  listLibraryCatalogIds,
  syncCatalog,
} from '../src/lightroom/catalog-sync.js';
import {
  connectCatalogReadOnly,
  generateRecordKey,
  getImageById,
  listCatalogFileIds,
  parseCatalogDate,
  parseGps,
  resolveCatalogLockingMode,
} from '../src/lightroom/reader.js';

let fx: LibraryFixture;
let dir: string;
let lrcatPath: string;
let cfgPath: string;
let jobsDbPath: string;

function withCatalog<T>(fn: (conn: Db) => T): T {
  const conn = connectCatalogReadOnly(lrcatPath);
  try {
    return fn(conn);
  } finally {
    conn.close();
  }
}

function withLibrary<T>(fn: (db: Db) => T): T {
  const db = openLibraryDb(fx.dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function withLibraryAsync<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const db = openLibraryDb(fx.dbPath);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/** A library row carrying an explicit `images.id`, the column the diff reads. */
const seedLibraryImage = (key: string, catalogId: string | null) =>
  fx.addImage({ key, id: catalogId });

const syncedImages = () =>
  fx.query<{ key: string; id: string; filepath: string; keywords: string }>(
    'SELECT key, id, filepath, keywords FROM images ORDER BY key',
  );

beforeEach(() => {
  fx = new LibraryFixture().activate();
  dir = mkdtempSync(join(tmpdir(), 'lt-sync-'));
  lrcatPath = join(dir, 'Test Catalog.lrcat');
  cfgPath = join(dir, 'config.yaml');
  jobsDbPath = join(dir, 'visualizer.db');
  process.env.LT_CONFIG_YAML = cfgPath;
  writeFileSync(cfgPath, stringifyYaml({ catalog_path: lrcatPath }));
});

afterEach(() => {
  fx.cleanup();
  delete process.env.LT_CONFIG_YAML;
  delete process.env.LIGHTROOM_CATALOG_LOCKING_MODE;
  delete process.env.LIGHTROOM_CATALOG_READONLY_URI;
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('lightroom reader', () => {
  it('builds the record the library stores, key and path included', () => {
    makeFakeCatalog(lrcatPath, [
      { id: 100, baseName: 'L1007168', extension: 'DNG', keywords: ['sunset', 'maine'] },
    ]);

    const record = withCatalog((conn) => getImageById(conn, 100))!;

    expect(record).toMatchObject({
      id: 100,
      key: '2024-06-01_L1007168',
      filename: 'L1007168',
      // Root and folder both carry their own trailing slash; the reader concatenates.
      filepath: '/Volumes/photos/2024/L1007168.DNG',
      date_taken: '2024-06-01T12:00:00',
      color_label: 'blue',
      caption: '',
      iso: 400,
      width: 6000,
      height: 4000,
      gps_latitude: 42.36,
      gps_longitude: -70.65,
    });
  });

  it('reads keywords through Adobe_images.rootFile, not the file id directly', () => {
    makeFakeCatalog(lrcatPath, [
      { id: 100, baseName: 'L1007168', keywords: ['sunset', 'maine'] },
    ]);
    expect(withCatalog((conn) => getImageById(conn, 100))!.keywords).toEqual([
      'sunset',
      'maine',
    ]);
  });

  it('coalesces on falsiness for pick, rating, focal length, and GPS', () => {
    makeFakeCatalog(lrcatPath, [
      { id: 100, baseName: 'zeroes', rating: 0, pick: -1, focalLength: 0, gpsLatitude: 0 },
    ]);

    const record = withCatalog((conn) => getImageById(conn, 100))!;

    // A rejected pick is -1 in the catalog, and `bool(-1)` is true.
    expect(record.pick).toBe(true);
    expect(record.rating).toBe(0);
    // Zero focal length is falsy and becomes empty text.
    expect(record.focal_length).toBe('');
    // Not 0 either: Null Island reads as "no coordinate".
    expect(record.gps_latitude).toBeNull();
  });

  it('returns null for a file id the catalog does not have', () => {
    makeFakeCatalog(lrcatPath, [{ id: 100, baseName: 'a' }]);
    expect(withCatalog((conn) => getImageById(conn, 999))).toBeNull();
  });

  it('lists every file id', () => {
    makeFakeCatalog(lrcatPath, [
      { id: 100, baseName: 'a' },
      { id: 38887, baseName: 'b' },
    ]);
    expect(withCatalog(listCatalogFileIds).sort((a, b) => a - b)).toEqual([100, 38887]);
  });

  it('opens the catalog read-only', () => {
    makeFakeCatalog(lrcatPath, [{ id: 100, baseName: 'a' }]);
    expect(() =>
      withCatalog((conn) => conn.prepare('DELETE FROM AgLibraryFile').run()),
    ).toThrow(/readonly/i);
  });

  it('defaults locking mode by open mode, and honours the override', () => {
    expect(resolveCatalogLockingMode(true)).toBe('NORMAL');
    expect(resolveCatalogLockingMode(false)).toBe('EXCLUSIVE');
    process.env.LIGHTROOM_CATALOG_LOCKING_MODE = 'exclusive';
    expect(resolveCatalogLockingMode(true)).toBe('EXCLUSIVE');
  });

  it('zero-pads a capture time in record keys', () => {
    expect(parseCatalogDate('2024-1-5T9:07:00')).toBe('2024-01-05T09:07:00');
    expect(parseCatalogDate('2024-06-01T12:00:00')).toBe('2024-06-01T12:00:00');
    // Anything the format cannot read comes back untouched, as strptime's caller does.
    expect(parseCatalogDate('sometime in June')).toBe('sometime in June');
    expect(parseCatalogDate(null)).toBeNull();
  });

  it('keys an undated image under "unknown"', () => {
    expect(generateRecordKey({ date_taken: '', filename: 'a' })).toBe('unknown_a');
    expect(parseGps('not a number')).toBeNull();
  });
});

describe('listLibraryCatalogIds', () => {
  it('skips empty and non-numeric ids', () => {
    seedLibraryImage('a', '100');
    seedLibraryImage('b', '');
    seedLibraryImage('c', null);
    seedLibraryImage('d', 'not-a-number');
    seedLibraryImage('e', '9999');

    expect(withLibrary(listLibraryCatalogIds)).toEqual(new Set([100, 9999]));
  });
});

describe('syncCatalog', () => {
  it('fetches only the ids the library is missing', async () => {
    makeFakeCatalog(
      lrcatPath,
      [1, 2, 3, 5, 99999].map((id) => ({ id, baseName: `img${id}` })),
    );
    seedLibraryImage('existing', '1');
    seedLibraryImage('gap', '5');

    const { result } = await withLibraryAsync((db) => syncCatalog(lrcatPath, db));

    expect(result).toMatchObject({
      added: 3,
      stale: 0,
      missing_ids_count: 3,
      catalog_total: 5,
      library_total: 2,
    });
    expect(syncedImages().map((r) => r.key)).toEqual([
      '2024-06-01_img2',
      '2024-06-01_img3',
      '2024-06-01_img99999',
      'existing',
      'gap',
    ]);
  });

  it('reports stale library rows without deleting them', async () => {
    makeFakeCatalog(lrcatPath, []);
    seedLibraryImage('gone', '42');

    const { result } = await withLibraryAsync((db) => syncCatalog(lrcatPath, db));

    expect(result).toMatchObject({ added: 0, stale: 1 });
    expect(syncedImages()).toHaveLength(1);
  });

  it('diffs ids numerically, not lexicographically', async () => {
    makeFakeCatalog(lrcatPath, [
      { id: 38887, baseName: 'have' },
      { id: 99999, baseName: 'new' },
    ]);
    seedLibraryImage('high', '38887');

    const { result } = await withLibraryAsync((db) => syncCatalog(lrcatPath, db));

    expect(result).toMatchObject({ added: 1, missing_ids_count: 1 });
    expect(syncedImages().map((r) => r.key)).toContain('2024-06-01_new');
  });

  it('stores the catalog id as an integer, not as a REAL bind', async () => {
    makeFakeCatalog(lrcatPath, [{ id: 100, baseName: 'a' }]);

    await withLibraryAsync((db) => syncCatalog(lrcatPath, db));

    // `'100.0'` here would parse back as no id at all, so the next sync would
    // re-fetch the whole catalog, forever.
    expect(syncedImages()[0]!.id).toBe('100');
  });

  it('does not re-fetch an image it already has', async () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'once' }]);
    await withLibraryAsync((db) => syncCatalog(lrcatPath, db));

    // Same id, so the second run sees nothing missing and writes nothing.
    const { result } = await withLibraryAsync((db) => syncCatalog(lrcatPath, db));

    expect(result).toMatchObject({
      added: 0,
      missing_ids_count: 0,
      library_total: 1,
      keywords_backfilled: 0,
    });
    expect(syncedImages()).toHaveLength(1);
  });

  it('backfills keywords for rows already in the library on the first sync', async () => {
    makeFakeCatalog(lrcatPath, [
      { id: 1, baseName: 'old', keywords: ['legacy'] },
      { id: 2, baseName: 'new', keywords: ['fresh'] },
    ]);
    seedLibraryImage('old', '1');

    const { result } = await withLibraryAsync((db) => syncCatalog(lrcatPath, db));

    expect(result).toMatchObject({ added: 1, keywords_backfilled: 2 });
    expect(syncedImages()).toEqual([
      {
        key: '2024-06-01_new',
        id: '2',
        filepath: '/Volumes/photos/2024/new.jpg',
        keywords: '["fresh"]',
      },
      {
        key: 'old',
        id: '1',
        filepath: expect.any(String),
        keywords: '["legacy"]',
      },
    ]);
  });

  it('can force keyword backfill after the one-time auto pass', async () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'once', keywords: ['first'] }]);
    await withLibraryAsync((db) => syncCatalog(lrcatPath, db));

    rmSync(lrcatPath);
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'once', keywords: ['renamed'] }]);
    const { result } = await withLibraryAsync((db) =>
      syncCatalog(lrcatPath, db, { backfillKeywords: true }),
    );

    expect(result).toMatchObject({ added: 0, keywords_backfilled: 1 });
    expect(syncedImages()[0]!.keywords).toBe('["renamed"]');
  });

  it('raises an actionable error when the catalog cannot be opened', async () => {
    await expect(
      withLibraryAsync((db) => syncCatalog(join(dir, 'absent.lrcat'), db)),
    ).rejects.toThrow(CatalogSyncError);
  });

  it('translates the three failures the user can act on', () => {
    expect(catalogSyncErrorMessage(new Error('database is locked'))).toBe(CATALOG_LOCKED_MSG);
    expect(catalogSyncErrorMessage(new Error('unable to open database file'))).toContain(
      'LIGHTROOM_CATALOG_LOCKING_MODE=EXCLUSIVE',
    );
    expect(catalogSyncErrorMessage(new Error('file is not a database'))).toBe(
      'Cannot read Lightroom Classic catalog: file is not a database',
    );
  });

  it('reports progress and logs the set-difference summary', async () => {
    makeFakeCatalog(lrcatPath, [
      { id: 1, baseName: 'a' },
      { id: 2, baseName: 'b' },
    ]);
    const progress: [number, string][] = [];
    const logs: string[] = [];

    await withLibraryAsync((db) =>
      syncCatalog(lrcatPath, db, {
        progress: (pct, msg) => progress.push([pct, msg]),
        log: (_level, msg) => logs.push(msg),
      }),
    );

    expect(progress).toEqual([
      [50, 'Fetching catalog metadata 1/2'],
      [95, 'Fetching catalog metadata 2/2'],
      [97, 'Backfilling keywords 1/2'],
      [99, 'Backfilling keywords 2/2'],
      [100, 'Catalog sync complete'],
    ]);
    expect(logs[0]).toContain('catalog_total=2 library_total=0 missing=2 stale=0');
    expect(logs[1]).toContain('orientation updated=0 stale=0');
    expect(logs[2]).toContain('keyword_backfill mode=auto rows=2');
    expect(logs[3]).toContain('complete added=2 stale=0 keywords_backfilled=2');
  });

  it('stops on cancellation and keeps what it already fetched', async () => {
    makeFakeCatalog(
      lrcatPath,
      [1, 2, 3, 4].map((id) => ({ id, baseName: `img${id}` })),
    );
    let seen = 0;

    const { result, cancelled } = await withLibraryAsync((db) =>
      syncCatalog(lrcatPath, db, {
        isCancelled: () => {
          seen += 1;
          return seen > 2;
        },
      }),
    );

    expect(cancelled).toBe(true);
    expect(result.added).toBe(2);
    expect(syncedImages()).toHaveLength(2);
  });

  it('records the catalog it read, so the settings row can spot a changed one', async () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'img1' }]);
    await withLibraryAsync((db) => syncCatalog(lrcatPath, db));
    expect(withLibrary((db) => getLibraryMeta(db, SYNCED_CATALOG_META_KEY))).toBe(lrcatPath);
  });

  it('leaves the previous catalog recorded when the run is cancelled', async () => {
    // A half-finished run did not make the library mirror the new catalog, so
    // claiming it did would silence the very warning the user needs.
    makeFakeCatalog(
      lrcatPath,
      [1, 2, 3, 4].map((id) => ({ id, baseName: `img${id}` })),
    );
    withLibrary((db) =>
      libraryWrite(db, () => setLibraryMeta(db, SYNCED_CATALOG_META_KEY, '/old.lrcat')),
    );

    let seen = 0;
    await withLibraryAsync((db) =>
      syncCatalog(lrcatPath, db, {
        isCancelled: () => {
          seen += 1;
          return seen > 2;
        },
      }),
    );

    expect(withLibrary((db) => getLibraryMeta(db, SYNCED_CATALOG_META_KEY))).toBe('/old.lrcat');
  });
});

describe('catalog_sync handler', () => {
  /** Enqueue, run one processor pass, and hand back the settled job. */
  async function runJob(metadata: Record<string, unknown> = {}) {
    const db = initJobsDb(jobsDbPath);
    try {
      const jobId = createJob(db, 'catalog_sync', metadata);
      await tick(db, new JobRunner(db));
      return getJob(db, jobId)!;
    } finally {
      db.close();
    }
  }

  it('completes with the sync result', async () => {
    makeFakeCatalog(lrcatPath, [
      { id: 1, baseName: 'a' },
      { id: 2, baseName: 'b' },
    ]);

    const job = await runJob();

    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({
      added: 2,
      stale: 0,
      locking_mode: 'NORMAL',
      catalog_total: 2,
      library_total: 0,
      missing_ids_count: 2,
    });
    expect(syncedImages()).toHaveLength(2);
  });

  it('takes the catalog path from the job metadata over config.yaml', async () => {
    const other = join(dir, 'Other.lrcat');
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'from-config' }]);
    makeFakeCatalog(other, [{ id: 2, baseName: 'from-metadata' }]);

    await runJob({ catalog_path: other });

    expect(syncedImages().map((r) => r.key)).toEqual(['2024-06-01_from-metadata']);
  });

  it('fails as a warning when no catalog is configured', async () => {
    writeFileSync(cfgPath, stringifyYaml({ workers: 4 }));

    const job = await runJob();

    expect(job.status).toBe('failed');
    expect(job.error).toBe('No catalog path configured. Set catalog_path in config.yaml.');
    expect(job.error_severity).toBe('warning');
  });

  it('fails as a warning when the configured catalog is not there', async () => {
    const missing = join(dir, 'absent.lrcat');
    writeFileSync(cfgPath, stringifyYaml({ catalog_path: missing }));

    const job = await runJob();

    expect(job.status).toBe('failed');
    expect(job.error).toBe(`Catalog not found: ${missing}`);
    expect(job.error_severity).toBe('warning');
  });

  it('fails on a file that is not a catalog, with SQLite\u2019s own words', async () => {
    writeFileSync(lrcatPath, 'this is not a Lightroom catalog');

    const job = await runJob();

    expect(job.status).toBe('failed');
    // Read-only open succeeds; SQLite's own error on first query, not the wrapped catalog message.
    expect(job.error).toBe('file is not a database');
    expect(job.error_severity).toBe('error');
  });
});

describe('orientation refresh', () => {
  const KEY = '2024-06-01_a';

  const setCatalogOrientation = (code: string): void => {
    const conn = new Database(lrcatPath);
    conn.prepare('UPDATE Adobe_images SET orientation = ?').run(code);
    conn.close();
  };

  /** A cache row plus a described, scored and embedded image, all made from that JPEG. */
  const seedOutputs = (db: Db, cache: { path: string; orientation: string | null }): void => {
    db.prepare(
      `INSERT INTO vision_cache (key, compressed_path, phash, compressed_at, original_mtime, orientation)
       VALUES (?, ?, NULL, '2026-01-01T00:00:00', 1, ?)`,
    ).run(KEY, cache.path, cache.orientation);
    db.prepare(
      "INSERT INTO image_descriptions (image_key, image_type, summary) VALUES (?, 'catalog', 'sideways')",
    ).run(KEY);
    db.prepare(
      `INSERT INTO image_scores (image_key, perspective_slug, score, prompt_version, scored_at)
       VALUES (?, 'framing', 4, 'framing:v1', '2026-01-01T00:00:00+00:00')`,
    ).run(KEY);
    db.prepare('INSERT INTO image_clip_embeddings (embedding, image_key) VALUES (?, ?)').run(
      Buffer.from(new Float32Array(512).fill(0.1).buffer),
      KEY,
    );
  };

  const staleOutputs = (db: Db): string[] =>
    (
      db.prepare('SELECT output FROM vision_stale WHERE image_key = ? ORDER BY output').all(KEY) as {
        output: string;
      }[]
    ).map((r) => r.output);

  const embedded = (db: Db): boolean =>
    db.prepare('SELECT 1 FROM image_clip_embeddings WHERE image_key = ?').get(KEY) !== undefined;

  const writeJpeg = async (name: string, width: number, height: number): Promise<string> => {
    const path = join(dir, name);
    await sharp({ create: { width, height, channels: 3, background: '#808080' } })
      .jpeg()
      .toFile(path);
    return path;
  };

  it('stores each photo’s Lightroom code', async () => {
    makeFakeCatalog(lrcatPath, [
      { id: 1, baseName: 'a', orientation: 'BC' },
      { id: 2, baseName: 'b' },
    ]);

    const { result } = await withLibraryAsync((db) => syncCatalog(lrcatPath, db));

    expect(fx.query('SELECT key, orientation FROM images ORDER BY key')).toEqual([
      { key: '2024-06-01_a', orientation: 'BC' },
      { key: '2024-06-01_b', orientation: 'AB' },
    ]);
    // Freshly added rows carry their code already; nothing changed under them.
    expect(result.orientations_updated).toBe(0);
  });

  it('retires what was made from the old JPEG when a photo is turned in Lightroom', async () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'a' }]);
    await withLibraryAsync((db) => syncCatalog(lrcatPath, db));
    const jpeg = await writeJpeg('a.jpg', 30, 20);
    withLibrary((db) => seedOutputs(db, { path: jpeg, orientation: 'AB' }));

    setCatalogOrientation('DA');
    const { result } = await withLibraryAsync((db) => syncCatalog(lrcatPath, db));

    expect(result).toMatchObject({ orientations_updated: 1, orientation_stale: 1 });
    withLibrary((db) => {
      expect(staleOutputs(db)).toEqual(['description', 'score:framing']);
      expect(embedded(db)).toBe(false);
      // The old outputs stay on show until replaced.
      expect(db.prepare('SELECT summary FROM image_descriptions').get()).toEqual({
        summary: 'sideways',
      });
    });

    // A second run sees no change and marks nothing again.
    withLibrary((db) => db.prepare('DELETE FROM vision_stale').run());
    const again = await withLibraryAsync((db) => syncCatalog(lrcatPath, db));
    expect(again.result).toMatchObject({ orientations_updated: 0, orientation_stale: 0 });
    withLibrary((db) => expect(staleOutputs(db)).toEqual([]));
  });

  it('keeps a pre-orientation cache JPEG the decoder already turned upright', async () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'a', orientation: 'BC' }]);
    await withLibraryAsync((db) => syncCatalog(lrcatPath, db));
    // Stored pixels are 6000×4000 (the fake catalog's size); turned upright they are tall.
    const tall = await writeJpeg('a.jpg', 20, 30);
    withLibrary((db) => {
      db.prepare('UPDATE images SET orientation = NULL').run();
      seedOutputs(db, { path: tall, orientation: null });
    });

    const { result } = await withLibraryAsync((db) => syncCatalog(lrcatPath, db));

    expect(result).toMatchObject({ orientations_updated: 1, orientation_stale: 0 });
    withLibrary((db) => {
      expect(staleOutputs(db)).toEqual([]);
      expect(embedded(db)).toBe(true);
      expect(db.prepare('SELECT orientation FROM vision_cache').get()).toEqual({
        orientation: 'BC',
      });
    });
  });

  it('retires a pre-orientation cache JPEG stored sideways', async () => {
    makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'a', orientation: 'BC' }]);
    await withLibraryAsync((db) => syncCatalog(lrcatPath, db));
    const wide = await writeJpeg('a.jpg', 30, 20);
    withLibrary((db) => {
      db.prepare('UPDATE images SET orientation = NULL').run();
      seedOutputs(db, { path: wide, orientation: null });
    });

    const { result } = await withLibraryAsync((db) => syncCatalog(lrcatPath, db));

    expect(result).toMatchObject({ orientations_updated: 1, orientation_stale: 1 });
    withLibrary((db) => {
      expect(staleOutputs(db)).toEqual(['description', 'score:framing']);
      expect(embedded(db)).toBe(false);
      expect(db.prepare('SELECT orientation FROM vision_cache').get()).toEqual({
        orientation: null,
      });
    });
  });
});
