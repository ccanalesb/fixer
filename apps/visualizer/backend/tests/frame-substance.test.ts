/**
 * Frame substance route tests.
 *
 * The cull-keyword routes write to a live Lightroom `.lrcat`, so every test here
 * builds a **fake catalog** with the three tables the writer touches and points
 * `config.yaml` at it. Nothing in this file can reach the user's real catalog: the
 * config path is overridden per test, and a test that forgot to would get the
 * "No Lightroom catalog configured." branch rather than a real write.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { createApp } from '../src/app.js';
import { LibraryFixture } from './helpers/library-fixture.js';
import { nowIsoLocal, storedInstantMs } from '../src/utils/datetime.js';

let fx: LibraryFixture;
let dir: string;
let cfgPath: string;
let lrcatPath: string;
const app = createApp();
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

interface FrameSubstanceBody {
  image_key: string;
  has_detection_run: boolean;
  verdict: string | null;
  unknown_reason: string | null;
  detector_version: string | null;
  judged_at: string | null;
  is_stale: boolean;
  has_override: boolean;
  flagged: boolean;
  has_cull_keyword: boolean | null;
  instrument: { kind: string; verdict: string | null; tier: string | null; advisory: boolean } | null;
  restore_tier: string | null;
  catalog_write_available: boolean;
  catalog_write_unavailable_reason: string | null;
}

/**
 * The minimum Lightroom schema the keyword writer touches. `Adobe_images.rootFile`
 * pointing at `AgLibraryFile.id_local` is the join the writer depends on, and using
 * the file id directly would attach keywords to the wrong photo.
 */
function makeFakeCatalog(path: string, baseNames: string[]): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE AgLibraryFile (id_local INTEGER PRIMARY KEY, baseName TEXT);
    CREATE TABLE Adobe_images (id_local INTEGER PRIMARY KEY, rootFile INTEGER);
    CREATE TABLE AgLibraryKeyword (
      id_local INTEGER PRIMARY KEY AUTOINCREMENT,
      id_global TEXT, name TEXT, lc_name TEXT, dateCreated TEXT, keywordType INTEGER
    );
    CREATE TABLE AgLibraryKeywordImage (image INTEGER, tag INTEGER);
  `);
  const file = db.prepare('INSERT INTO AgLibraryFile (id_local, baseName) VALUES (?, ?)');
  const image = db.prepare('INSERT INTO Adobe_images (id_local, rootFile) VALUES (?, ?)');
  baseNames.forEach((name, i) => {
    // Deliberately different id ranges so a file-vs-image id mix-up cannot pass.
    file.run(100 + i, name);
    image.run(900 + i, 100 + i);
  });
  db.close();
}

function writeConfig(overrides: Record<string, unknown> = {}): void {
  writeFileSync(cfgPath, stringifyYaml({ workers: 4, ...overrides }));
}

const catalogKeywords = (): { image: number; name: string }[] => {
  const db = new Database(lrcatPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT ki.image AS image, k.name AS name
         FROM AgLibraryKeywordImage ki
         JOIN AgLibraryKeyword k ON k.id_local = ki.tag`,
      )
      .all() as { image: number; name: string }[];
  } finally {
    db.close();
  }
};

beforeEach(() => {
  fx = new LibraryFixture().activate();
  dir = mkdtempSync(join(tmpdir(), 'lt-fs-'));
  cfgPath = join(dir, 'config.yaml');
  lrcatPath = join(dir, 'Test Catalog.lrcat');
  process.env.LT_CONFIG_YAML = cfgPath;
  writeConfig();
});

afterEach(() => {
  fx.cleanup();
  delete process.env.LT_CONFIG_YAML;
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/images/catalog/{image_key}/frame-substance', () => {
  it('reports an unjudged image with no detection run', async () => {
    fx.addImages('a');
    const res = await app.request('/api/images/catalog/a/frame-substance');
    expect(res.status).toBe(200);
    const body = await json<FrameSubstanceBody>(res);

    expect(body).toMatchObject({
      image_key: 'a',
      has_detection_run: false,
      verdict: null,
      is_stale: false,
      has_override: false,
      flagged: false,
      instrument: null,
      restore_tier: null,
      catalog_write_available: false,
      catalog_write_unavailable_reason: 'No Lightroom catalog configured.',
    });
    // Not false: the catalog cannot be read, so the keyword state is unknown.
    expect(body.has_cull_keyword).toBeNull();
  });

  it('reports tier A for a void verdict and tier B for illegible', async () => {
    fx.addImages('void-img', 'illegible-img');
    fx.addFrameSubstance('void-img', 'void');
    fx.addFrameSubstance('illegible-img', 'illegible');

    const a = await json<FrameSubstanceBody>(
      await app.request('/api/images/catalog/void-img/frame-substance'),
    );
    expect(a.instrument).toEqual({
      kind: 'pixel_detector',
      verdict: 'void',
      tier: 'A',
      advisory: false,
    });
    expect(a.restore_tier).toBe('A');
    expect(a.flagged).toBe(true);

    const b = await json<FrameSubstanceBody>(
      await app.request('/api/images/catalog/illegible-img/frame-substance'),
    );
    expect(b.instrument?.tier).toBe('B');
    expect(b.restore_tier).toBe('B');
  });

  it('does not flag an ok verdict', async () => {
    fx.addImages('a');
    fx.addFrameSubstance('a', 'ok');
    const body = await json<FrameSubstanceBody>(
      await app.request('/api/images/catalog/a/frame-substance'),
    );
    expect(body.verdict).toBe('ok');
    expect(body.flagged).toBe(false);
    expect(body.instrument).toBeNull();
  });

  it('clears flagged once the user overrides, keeping the verdict visible', async () => {
    fx.addImages('a');
    fx.addFrameSubstance('a', 'void');
    fx.addFrameSubstanceOverride('a');

    const body = await json<FrameSubstanceBody>(
      await app.request('/api/images/catalog/a/frame-substance'),
    );
    expect(body.has_override).toBe(true);
    expect(body.flagged).toBe(false);
    // The detector's opinion is still reported — the user disagreed with it, and the
    // UI shows both.
    expect(body.verdict).toBe('void');
    expect(body.restore_tier).toBe('A');
  });

  it('reports the advisory excusal hint only when the detector is silent', async () => {
    fx.addImages('excused', 'condemned');
    fx.addPerspectives({ slug: 'optional-lens', optional: true }, { slug: 'street' });
    fx.addScores(
      {
        image_key: 'excused',
        perspective_slug: 'optional-lens',
        score: 4,
        not_attempted: true,
      },
      {
        image_key: 'condemned',
        perspective_slug: 'optional-lens',
        score: 4,
        not_attempted: true,
      },
    );
    fx.addFrameSubstance('condemned', 'void');

    const excused = await json<FrameSubstanceBody>(
      await app.request('/api/images/catalog/excused/frame-substance'),
    );
    expect(excused.instrument).toEqual({
      kind: 'excusal_channel',
      verdict: null,
      tier: null,
      advisory: true,
    });
    // Advisory only: no restore tier, because nothing was condemned.
    expect(excused.restore_tier).toBeNull();

    // The detector wins when it has an opinion; the weaker signal is not shown.
    const condemned = await json<FrameSubstanceBody>(
      await app.request('/api/images/catalog/condemned/frame-substance'),
    );
    expect(condemned.instrument?.kind).toBe('pixel_detector');
  });

  it('needs every active optional perspective excused, not just one', async () => {
    fx.addImages('a');
    fx.addPerspectives(
      { slug: 'opt-one', optional: true },
      { slug: 'opt-two', optional: true },
    );
    fx.addScores({
      image_key: 'a',
      perspective_slug: 'opt-one',
      score: 4,
      not_attempted: true,
    });

    const body = await json<FrameSubstanceBody>(
      await app.request('/api/images/catalog/a/frame-substance'),
    );
    // One of two is not a signal.
    expect(body.instrument).toBeNull();
  });

  it('marks the verdict stale when the preview was rebuilt afterwards', async () => {
    fx.addImages('a');
    fx.addFrameSubstance('a', 'ok');
    const judgedAt = fx.query<{ judged_at: string }>(
      'SELECT judged_at FROM image_frame_substance WHERE image_key = ?',
      'a',
    )[0]!.judged_at;

    const fresh = await json<FrameSubstanceBody>(
      await app.request('/api/images/catalog/a/frame-substance'),
    );
    expect(fresh.is_stale).toBe(false);

    // A cache entry newer than the verdict means the detector judged a preview that
    // no longer exists.
    const later = nowIsoLocal(new Date(storedInstantMs(judgedAt) + 60 * 60_000));
    const db = new Database(fx.dbPath);
    db.prepare(
      'INSERT INTO vision_cache (key, compressed_path, compressed_at) VALUES (?, ?, ?)',
    ).run('a', '/tmp/x.jpg', later);
    db.close();

    const stale = await json<FrameSubstanceBody>(
      await app.request('/api/images/catalog/a/frame-substance'),
    );
    expect(stale.is_stale).toBe(true);
  });

  it('reports has_detection_run only once a run has finished', async () => {
    fx.addImages('a');
    const db = new Database(fx.dbPath);
    db.prepare(
      'INSERT INTO frame_substance_runs (started_at, detector_version) VALUES (?, ?)',
    ).run('2026-01-01T00:00:00+00:00', 'v1');
    db.close();

    const running = await json<FrameSubstanceBody>(
      await app.request('/api/images/catalog/a/frame-substance'),
    );
    // An in-flight run is not a run the UI can report results from.
    expect(running.has_detection_run).toBe(false);

    const db2 = new Database(fx.dbPath);
    db2.prepare('UPDATE frame_substance_runs SET finished_at = ?').run(
      '2026-01-01T00:10:00+00:00',
    );
    db2.close();

    const finished = await json<FrameSubstanceBody>(
      await app.request('/api/images/catalog/a/frame-substance'),
    );
    expect(finished.has_detection_run).toBe(true);
  });

  it('404s for an unknown image', async () => {
    const res = await app.request('/api/images/catalog/nope/frame-substance');
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: 'Image not found' });
  });
});

describe('frame-substance override', () => {
  const call = (method: 'POST' | 'DELETE', key: string) =>
    app.request(`/api/images/catalog/${key}/frame-substance/override`, { method });

  it('adds and removes the override', async () => {
    fx.addImages('a');
    fx.addFrameSubstance('a', 'void');

    const added = await call('POST', 'a');
    expect(added.status).toBe(200);
    expect(await json(added)).toEqual({ image_key: 'a', has_override: true });
    expect(fx.query('SELECT COUNT(*) AS c FROM frame_substance_overrides')).toEqual([{ c: 1 }]);

    const removed = await call('DELETE', 'a');
    expect(removed.status).toBe(200);
    expect(await json(removed)).toEqual({ image_key: 'a', has_override: false });
    expect(fx.query('SELECT COUNT(*) AS c FROM frame_substance_overrides')).toEqual([{ c: 0 }]);
  });

  it('is idempotent in both directions', async () => {
    fx.addImages('a');
    expect((await call('POST', 'a')).status).toBe(200);
    expect((await call('POST', 'a')).status).toBe(200);
    expect(fx.query('SELECT COUNT(*) AS c FROM frame_substance_overrides')).toEqual([{ c: 1 }]);
    expect((await call('DELETE', 'a')).status).toBe(200);
    // Deleting an override that is already gone is not an error.
    expect((await call('DELETE', 'a')).status).toBe(200);
  });

  it('restores the image to the catalog grid', async () => {
    fx.addImages('void-img', 'ok-img');
    fx.addFrameSubstance('void-img', 'void');

    const before = await json<{ images: { key: string }[] }>(
      await app.request('/api/images/catalog?flagged=false'),
    );
    expect(before.images.map((i) => i.key)).toEqual(['ok-img']);

    await call('POST', 'void-img');

    const after = await json<{ images: { key: string }[] }>(
      await app.request('/api/images/catalog?flagged=false'),
    );
    // This is the point of the override: the frame comes back into consideration.
    expect(after.images.map((i) => i.key).sort()).toEqual(['ok-img', 'void-img']);
  });

  it('404s for an unknown image, without writing', async () => {
    expect((await call('POST', 'nope')).status).toBe(404);
    expect(fx.query('SELECT COUNT(*) AS c FROM frame_substance_overrides')).toEqual([{ c: 0 }]);
  });
});

describe('cull keyword', () => {
  const call = (method: 'POST' | 'DELETE', key: string) =>
    app.request(`/api/images/catalog/${key}/cull-keyword`, { method });

  it('400s when no catalog is configured', async () => {
    fx.addImages('a');
    const res = await call('POST', 'a');
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'No Lightroom catalog configured.' });
  });

  it('400s when the configured catalog file is missing', async () => {
    fx.addImages('a');
    writeConfig({ catalog_path: join(dir, 'gone.lrcat') });
    const res = await call('POST', 'a');
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'Lightroom catalog file not found.' });
  });

  it('400s while Lightroom holds the catalog open', async () => {
    fx.addImages('2026-01-15_L1007168');
    makeFakeCatalog(lrcatPath, ['L1007168']);
    writeConfig({ catalog_path: lrcatPath });
    // Lightroom's lock file next to the catalog.
    writeFileSync(join(dir, 'Test Catalog.lrcat-lock'), '');

    const res = await call('POST', '2026-01-15_L1007168');
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'Close Lightroom before writing to catalog.' });
    // Nothing was written, and no backup was taken either.
    expect(catalogKeywords()).toEqual([]);
  });

  it('adds the keyword, reports already_present on a repeat, and removes it', async () => {
    fx.addImages('2026-01-15_L1007168');
    makeFakeCatalog(lrcatPath, ['L1007168']);
    writeConfig({ catalog_path: lrcatPath });

    const added = await call('POST', '2026-01-15_L1007168');
    expect(added.status).toBe(200);
    expect(await json(added)).toEqual({
      image_key: '2026-01-15_L1007168',
      result: 'added',
    });
    // Linked to the Adobe_images id (900), not the AgLibraryFile id (100).
    expect(catalogKeywords()).toEqual([{ image: 900, name: 'lrt-cull' }]);

    const again = await call('POST', '2026-01-15_L1007168');
    expect(await json(again)).toEqual({
      image_key: '2026-01-15_L1007168',
      result: 'already_present',
    });
    expect(catalogKeywords()).toHaveLength(1);

    const removed = await call('DELETE', '2026-01-15_L1007168');
    expect(await json(removed)).toEqual({
      image_key: '2026-01-15_L1007168',
      result: 'removed',
    });
    expect(catalogKeywords()).toEqual([]);
  });

  it('reports not_present when removing a keyword the image never had', async () => {
    fx.addImages('2026-01-15_L1007168');
    makeFakeCatalog(lrcatPath, ['L1007168']);
    writeConfig({ catalog_path: lrcatPath });

    const res = await call('DELETE', '2026-01-15_L1007168');
    expect(await json(res)).toEqual({
      image_key: '2026-01-15_L1007168',
      result: 'not_present',
    });
  });

  it('reports image_not_found when the key is absent from the Lightroom catalog', async () => {
    // Present in library.db but not in the .lrcat — the catalogs have drifted.
    fx.addImages('2026-01-15_MISSING');
    makeFakeCatalog(lrcatPath, ['L1007168']);
    writeConfig({ catalog_path: lrcatPath });

    const res = await call('POST', '2026-01-15_MISSING');
    expect(res.status).toBe(200);
    // A 200 with a three-way outcome, not a 404: the request was understood and the
    // answer is "that photo is not in your catalog".
    expect(await json(res)).toEqual({
      image_key: '2026-01-15_MISSING',
      result: 'image_not_found',
    });
  });

  it('backs the catalog up once, then reuses that backup', async () => {
    fx.addImages('2026-01-15_L1007168', '2026-01-16_L1007169');
    makeFakeCatalog(lrcatPath, ['L1007168', 'L1007169']);
    writeConfig({ catalog_path: lrcatPath });

    await call('POST', '2026-01-15_L1007168');
    const afterFirst = readdirSync(dir).filter((f) => f.includes('.backup-'));
    expect(afterFirst).toHaveLength(1);

    await call('POST', '2026-01-16_L1007169');
    const afterSecond = readdirSync(dir).filter((f) => f.includes('.backup-'));
    // A per-write copy would evict the only snapshot predating our writes, so
    // backing up more often would leave less to recover from.
    expect(afterSecond).toEqual(afterFirst);
  });

  it('reports the keyword state in the frame-substance panel', async () => {
    fx.addImages('2026-01-15_L1007168');
    makeFakeCatalog(lrcatPath, ['L1007168']);
    writeConfig({ catalog_path: lrcatPath });

    const before = await json<FrameSubstanceBody>(
      await app.request('/api/images/catalog/2026-01-15_L1007168/frame-substance'),
    );
    expect(before.catalog_write_available).toBe(true);
    expect(before.catalog_write_unavailable_reason).toBeNull();
    expect(before.has_cull_keyword).toBe(false);

    await call('POST', '2026-01-15_L1007168');

    const after = await json<FrameSubstanceBody>(
      await app.request('/api/images/catalog/2026-01-15_L1007168/frame-substance'),
    );
    expect(after.has_cull_keyword).toBe(true);
  });

  it('404s for an image that is not in library.db, before touching the catalog', async () => {
    makeFakeCatalog(lrcatPath, ['L1007168']);
    writeConfig({ catalog_path: lrcatPath });

    const res = await call('POST', '2026-01-15_L1007168');
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: 'Image not found' });
    // No backup, no write: the guard runs first.
    expect(readdirSync(dir).filter((f) => f.includes('.backup-'))).toEqual([]);
    expect(existsSync(lrcatPath)).toBe(true);
  });
});
