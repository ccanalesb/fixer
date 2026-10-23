/**
 * Frame substance route tests. The panel and its override read and write only
 * `library.db`; nothing here touches a Lightroom catalog.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createApp } from '../src/app.js';
import { LibraryFixture } from './helpers/library-fixture.js';
import { nowIsoLocal, storedInstantMs } from '../src/utils/datetime.js';

let fx: LibraryFixture;
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
  instrument: { kind: string; verdict: string | null; tier: string | null; advisory: boolean } | null;
  restore_tier: string | null;
}

beforeEach(() => {
  fx = new LibraryFixture().activate();
});

afterEach(() => {
  fx.cleanup();
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
    });
  });

  it('says nothing about the Lightroom catalog: no keyword to mark, no catalog to check', async () => {
    fx.addImages('a');
    const body = await json<Record<string, unknown>>(await app.request('/api/images/catalog/a/frame-substance'));
    expect(Object.keys(body)).not.toContain('has_cull_keyword');
    expect(Object.keys(body)).not.toContain('catalog_write_available');
    expect((await app.request('/api/images/catalog/a/cull-keyword', { method: 'POST' })).status).toBe(404);
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
