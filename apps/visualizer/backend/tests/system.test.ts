/**
 * System route tests.
 *
 * Fixtures build a real SQLite file rather than mocking the DB layer so the
 * queries actually run.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createApp } from '../src/app.js';

let tmp: string;
let dbPath: string;

/** Minimal `library.db` with just the tables the system routes read. */
function seedLibrary(path: string, opts: { images?: number; posted?: number; cached?: number } = {}) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE images (
      key TEXT PRIMARY KEY,
      filename TEXT,
      filepath TEXT,
      instagram_posted INTEGER DEFAULT 0
    );
    CREATE TABLE vision_cache (
      key TEXT PRIMARY KEY,
      compressed_path TEXT,
      phash TEXT,
      compressed_at TEXT,
      original_mtime REAL
    );
  `);
  const ins = db.prepare('INSERT INTO images (key, filename, filepath, instagram_posted) VALUES (?, ?, ?, ?)');
  const total = opts.images ?? 0;
  const posted = opts.posted ?? 0;
  for (let i = 0; i < total; i++) ins.run(`k${i}`, `f${i}.jpg`, `/p/f${i}.jpg`, i < posted ? 1 : 0);
  const cins = db.prepare('INSERT INTO vision_cache (key, compressed_path) VALUES (?, ?)');
  for (let i = 0; i < (opts.cached ?? 0); i++) cins.run(`k${i}`, join(tmp, `cache${i}.jpg`));
  db.close();
}

/** Build the app. Config reads env lazily, so a single import is enough. */
async function freshApp() {
  return createApp();
}

/** `Response.json()` is `unknown`; assert the shape once here instead of at each use. */
async function jsonOf<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lt-sys-'));
  dbPath = join(tmp, 'library.db');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.LIBRARY_DB;
});

describe('GET /api/status', () => {
  it('reports ok', async () => {
    const app = await freshApp();
    const res = await app.request('/api/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /api/clip-model', () => {
  const savedDataDir = process.env.LT_DATA_DIR;

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.LT_DATA_DIR;
    else process.env.LT_DATA_DIR = savedDataDir;
  });

  it('reports whether the CLIP weights are on disk', async () => {
    process.env.LT_DATA_DIR = tmp;
    const app = await freshApp();
    const res = await app.request('/api/clip-model');
    expect(res.status).toBe(200);
    const body = await jsonOf<{ model_on_disk: boolean; cache_dir: string }>(res);
    expect(body.model_on_disk).toBe(false);
    expect(body.cache_dir).toBe(join(tmp, 'clip'));
  });
});

describe('GET /api/stats', () => {
  it('counts catalog images and posted images', async () => {
    seedLibrary(dbPath, { images: 7, posted: 3 });
    process.env.LIBRARY_DB = dbPath;
    const app = await freshApp();

    const res = await app.request('/api/stats');
    expect(res.status).toBe(200);
    const body = await jsonOf<{ catalog_images: number; posted_to_instagram: number; db_path: string }>(res);
    expect(body.catalog_images).toBe(7);
    expect(body.posted_to_instagram).toBe(3);
    expect(body.db_path).toBe(dbPath);
  });

  it('404s when the library database is absent', async () => {
    process.env.LIBRARY_DB = join(tmp, 'nope.db');
    const app = await freshApp();

    const res = await app.request('/api/stats');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Library database not found' });
  });

  it('returns no extra keys — the schema forbids them', async () => {
    seedLibrary(dbPath, { images: 1 });
    process.env.LIBRARY_DB = dbPath;
    const app = await freshApp();

    const body = await jsonOf(await app.request('/api/stats'));
    expect(Object.keys(body).sort()).toEqual(['catalog_images', 'db_path', 'posted_to_instagram']);
  });
});

describe('GET /api/catalog/status', () => {
  it('reports cached when the vision cache has entries', async () => {
    seedLibrary(dbPath, { images: 4, cached: 2 });
    process.env.LIBRARY_DB = dbPath;
    const app = await freshApp();

    const res = await app.request('/api/catalog/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cached: true });
  });

  it('reports not cached on an empty vision cache', async () => {
    seedLibrary(dbPath, { images: 4, cached: 0 });
    process.env.LIBRARY_DB = dbPath;
    const app = await freshApp();

    expect(await (await app.request('/api/catalog/status')).json()).toEqual({ cached: false });
  });

  it('reports not cached — not an error — when the database is missing', async () => {
    process.env.LIBRARY_DB = join(tmp, 'nope.db');
    const app = await freshApp();

    const res = await app.request('/api/catalog/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cached: false });
  });

  it('surfaces a corrupt database as a 500', async () => {
    writeFileSync(dbPath, 'this is not a sqlite file');
    process.env.LIBRARY_DB = dbPath;
    const app = await freshApp();

    const res = await app.request('/api/catalog/status');
    expect(res.status).toBe(500);
    expect(await res.json()).toHaveProperty('error');
  });
});

describe('GET /api/cache/status', () => {
  it('reports cache counts, size and directory', async () => {
    seedLibrary(dbPath, { images: 5, cached: 2 });
    // Give one cached row a real file so the size is not trivially zero.
    writeFileSync(join(tmp, 'cache0.jpg'), 'x'.repeat(1024 * 512));
    process.env.LIBRARY_DB = dbPath;
    const cfgPath = join(tmp, 'config.yaml');
    writeFileSync(cfgPath, `vision_cache_dir: ${JSON.stringify(join(tmp, 'vc'))}\n`);
    process.env.LT_CONFIG_YAML = cfgPath;
    const app = await freshApp();

    const res = await app.request('/api/cache/status');
    expect(res.status).toBe(200);
    const body = await jsonOf<{
      total_images: number;
      cached_images: number;
      missing: number;
      cache_size_mb: number;
      cache_dir: string;
    }>(res);

    expect(body.total_images).toBe(5);
    expect(body.cached_images).toBe(2);
    expect(body.missing).toBe(3);
    // `cache1.jpg` was never created, so it contributes nothing rather than throwing.
    expect(body.cache_size_mb).toBe(0.5);
    expect(body.cache_dir).toBe(join(tmp, 'vc'));

    delete process.env.LT_CONFIG_YAML;
  });

  it('404s when the library database is absent', async () => {
    process.env.LIBRARY_DB = join(tmp, 'nope.db');
    const app = await freshApp();
    const res = await app.request('/api/cache/status');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Library database not found' });
  });
});

describe('GET /api/cache/pipeline-status', () => {
  /** `visualizer.db` with the jobs table — a different database from library.db. */
  function seedJobs(path: string, rows: { id: string; type: string; created_at: string; metadata?: string; status?: string }[]) {
    const db = new Database(path);
    db.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        progress INTEGER DEFAULT 0,
        current_step TEXT,
        logs TEXT DEFAULT '[]',
        result TEXT,
        error TEXT,
        error_severity TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        metadata TEXT DEFAULT '{}'
      );
    `);
    const ins = db.prepare(
      'INSERT INTO jobs (id, type, status, created_at, metadata) VALUES (?, ?, ?, ?, ?)',
    );
    for (const r of rows) {
      ins.run(r.id, r.type, r.status ?? 'completed', r.created_at, r.metadata ?? '{}');
    }
    db.close();
  }

  let jobsDb: string;

  beforeEach(() => {
    jobsDb = join(tmp, 'visualizer.db');
    process.env.DATABASE_PATH = jobsDb;
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
  });

  it('reports null for every bucket with no jobs', async () => {
    seedJobs(jobsDb, []);
    const app = await freshApp();
    const res = await app.request('/api/cache/pipeline-status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      catalog_sync: null,
      embed_catalog: null,
      stack_detect: null,
      catalog_similarity: null,
      catalog_cache_build: null,
    });
  });

  it('reports the most recent run per bucket', async () => {
    seedJobs(jobsDb, [
      { id: 'old', type: 'catalog_sync', created_at: '2026-01-01T00:00:00' },
      { id: 'new', type: 'catalog_sync', created_at: '2026-02-01T00:00:00' },
      { id: 'stack', type: 'batch_stack_detect', created_at: '2026-01-05T00:00:00' },
    ]);
    const app = await freshApp();
    const body = await jsonOf<Record<string, { job_id: string; type: string } | null>>(
      await app.request('/api/cache/pipeline-status'),
    );
    // Renamed on the way out: the column is `id`, the field is `job_id`.
    expect(body.catalog_sync?.job_id).toBe('new');
    expect(body.stack_detect?.job_id).toBe('stack');
    expect(body.catalog_similarity).toBeNull();
  });

  it('counts a legacy embed job with no image_type toward embed_catalog', async () => {
    seedJobs(jobsDb, [
      { id: 'legacy', type: 'batch_embed_image', created_at: '2026-01-01T00:00:00', metadata: '{}' },
    ]);
    const app = await freshApp();
    const body = await jsonOf<Record<string, { job_id: string } | null>>(
      await app.request('/api/cache/pipeline-status'),
    );
    // A row written before `metadata.image_type` existed was implicitly a catalog
    // embed; dropping it would make the button look like it had never run.
    expect(body.embed_catalog?.job_id).toBe('legacy');
  });

  it('excludes an embed job scoped to another image type', async () => {
    seedJobs(jobsDb, [
      {
        id: 'other',
        type: 'batch_embed_image',
        created_at: '2026-01-01T00:00:00',
        metadata: '{"image_type": "instagram"}',
      },
    ]);
    const app = await freshApp();
    const body = await jsonOf<Record<string, unknown>>(
      await app.request('/api/cache/pipeline-status'),
    );
    expect(body.embed_catalog).toBeNull();
  });

  it('prefers an explicit catalog embed over a legacy one when it is newer', async () => {
    seedJobs(jobsDb, [
      { id: 'legacy', type: 'batch_embed_image', created_at: '2026-01-01T00:00:00' },
      {
        id: 'explicit',
        type: 'batch_embed_image',
        created_at: '2026-03-01T00:00:00',
        metadata: '{"image_type": "catalog"}',
      },
    ]);
    const app = await freshApp();
    const body = await jsonOf<Record<string, { job_id: string } | null>>(
      await app.request('/api/cache/pipeline-status'),
    );
    expect(body.embed_catalog?.job_id).toBe('explicit');
  });

  it('500s when the jobs database is absent', async () => {
    process.env.DATABASE_PATH = join(tmp, 'no-such.db');
    const app = await freshApp();
    const res = await app.request('/api/cache/pipeline-status');
    expect(res.status).toBe(500);
    expect(await res.json()).toHaveProperty('error');
  });
});
