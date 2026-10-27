/**
 * `GET /api/insights-summary` tests.
 *
 * Each tile is a separate whole-catalog aggregate, and several are easy to get
 * subtly wrong — "unscored on active perspectives" means missing *any* active
 * perspective, not all of them, and the two frame-substance counts are net of user
 * overrides in one case and not the other.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createApp } from '../src/app.js';
import { LibraryFixture } from './helpers/library-fixture.js';

let fx: LibraryFixture;
const app = createApp();

interface Summary {
  first_catalog_import_completed: boolean;
  catalog_images: number;
  scoring_9_plus: number;
  burst_stacks: number;
  pending_stack_suggestions: number;
  unscored_on_active_perspectives: number;
  no_current_score: number;
  perspective_coverage: {
    slug: string;
    display_name: string;
    active: boolean;
    scored_images: number;
  }[];
  frame_substance_flagged: number;
  frame_substance_unknown: Record<string, number>;
  frame_substance_run: {
    detector_version: string;
    finished_at: string;
    breached: boolean;
    breach_reason: string;
  } | null;
}

const get = async (): Promise<Summary> =>
  (await (await app.request('/api/insights-summary')).json()) as Summary;

beforeEach(() => {
  fx = new LibraryFixture().activate();
});
afterEach(() => fx.cleanup());

describe('GET /api/insights-summary', () => {
  it('reports zeros for an empty catalog', async () => {
    const body = await get();
    expect(body).toMatchObject({
      first_catalog_import_completed: false,
      catalog_images: 0,
      scoring_9_plus: 0,
      burst_stacks: 0,
      pending_stack_suggestions: 0,
      unscored_on_active_perspectives: 0,
      no_current_score: 0,
      frame_substance_flagged: 0,
      frame_substance_run: null,
    });
    expect(body.perspective_coverage).toEqual([]);
    expect(body.frame_substance_unknown).toEqual({});
  });

  it('counts images scoring 9 or better on an active perspective only', async () => {
    fx.addImages('nine', 'ten', 'eight', 'retired-nine');
    fx.addPerspectives({ slug: 'street' }, { slug: 'retired', active: false });
    fx.addScores(
      { image_key: 'nine', perspective_slug: 'street', score: 9 },
      { image_key: 'ten', perspective_slug: 'street', score: 10 },
      { image_key: 'eight', perspective_slug: 'street', score: 8 },
      { image_key: 'retired-nine', perspective_slug: 'retired', score: 10 },
    );
    const body = await get();
    // A 10 on a deactivated perspective is not a highlight.
    expect(body.scoring_9_plus).toBe(2);
  });

  it('counts an image once even when several perspectives score it 9+', async () => {
    fx.addImages('a');
    fx.addPerspectives({ slug: 'street' }, { slug: 'documentary' });
    fx.addScores(
      { image_key: 'a', perspective_slug: 'street', score: 9 },
      { image_key: 'a', perspective_slug: 'documentary', score: 10 },
    );
    expect((await get()).scoring_9_plus).toBe(1);
  });

  it('counts an image as unscored when it is missing any one active perspective', async () => {
    fx.addImages('complete', 'partial', 'none');
    fx.addPerspectives({ slug: 'street' }, { slug: 'documentary' });
    fx.addScores(
      { image_key: 'complete', perspective_slug: 'street', score: 5 },
      { image_key: 'complete', perspective_slug: 'documentary', score: 5 },
      { image_key: 'partial', perspective_slug: 'street', score: 5 },
    );
    const body = await get();
    // `partial` has a score, just not on every active perspective.
    expect(body.unscored_on_active_perspectives).toBe(2);
    // Whereas `no_current_score` only counts images with no score at all.
    expect(body.no_current_score).toBe(1);
  });

  it('ignores superseded scores in both unscored counts', async () => {
    fx.addImages('a');
    fx.addPerspectives({ slug: 'street' });
    fx.addScores({
      image_key: 'a',
      perspective_slug: 'street',
      score: 7,
      is_current: false,
    });
    const body = await get();
    expect(body.unscored_on_active_perspectives).toBe(1);
    expect(body.no_current_score).toBe(1);
  });

  it('lists per-perspective coverage for active and inactive alike, slug-ordered', async () => {
    fx.addImages('a', 'b');
    fx.addPerspectives(
      { slug: 'street', display_name: 'Street' },
      { slug: 'documentary', display_name: 'Documentary' },
      { slug: 'archived', display_name: 'Archived', active: false },
    );
    fx.addScores(
      { image_key: 'a', perspective_slug: 'street', score: 5 },
      { image_key: 'b', perspective_slug: 'street', score: 6 },
      { image_key: 'a', perspective_slug: 'documentary', score: 4 },
    );
    const body = await get();
    expect(body.perspective_coverage).toEqual([
      { slug: 'archived', display_name: 'Archived', active: false, scored_images: 0 },
      { slug: 'documentary', display_name: 'Documentary', active: true, scored_images: 1 },
      { slug: 'street', display_name: 'Street', active: true, scored_images: 2 },
    ]);
  });

  it('counts stacks and pending suggestions', async () => {
    fx.addImages('a', 'b', 'c', 'd');
    fx.addStack(['a', 'b'], 'a');
    fx.addSimilarityGroup({ seed_key: 'c', candidates: [{ key: 'd', similarity: 0.9 }] });
    const body = await get();
    expect(body.burst_stacks).toBe(1);
    expect(body.pending_stack_suggestions).toBe(1);
  });

  it('counts flagged frames net of overrides', async () => {
    fx.addImages('void', 'illegible', 'overridden', 'ok');
    fx.addFrameSubstance('void', 'void');
    fx.addFrameSubstance('illegible', 'illegible');
    fx.addFrameSubstance('overridden', 'void');
    fx.addFrameSubstance('ok', 'ok');
    fx.addFrameSubstanceOverride('overridden');

    expect((await get()).frame_substance_flagged).toBe(2);
  });

  it('groups unknown verdicts by reason and folds in the never-judged images', async () => {
    fx.addImages('unknown-a', 'unknown-b', 'unjudged-a', 'unjudged-b', 'unjudged-c');
    const db = new Database(fx.dbPath);
    const ins = db.prepare(
      `INSERT INTO image_frame_substance (image_key, verdict, unknown_reason, detector_version, run_id)
       VALUES (?, 'unknown', ?, 'v1', 1)`,
    );
    ins.run('unknown-a', 'decode_failed');
    ins.run('unknown-b', 'decode_failed');
    db.close();

    const body = await get();
    // `never_judged` is a synthetic reason folded into the same map: from the tile's
    // point of view, "not looked at" is one more way a verdict is unknown.
    expect(body.frame_substance_unknown).toEqual({ decode_failed: 2, never_judged: 3 });
  });

  it('omits never_judged when every image has a verdict', async () => {
    fx.addImages('a');
    fx.addFrameSubstance('a', 'ok');
    expect((await get()).frame_substance_unknown).toEqual({});
  });

  it('reports the latest finished detection run, ignoring one still running', async () => {
    const db = new Database(fx.dbPath);
    const ins = db.prepare(
      `INSERT INTO frame_substance_runs
         (started_at, finished_at, detector_version, breached, breach_reason)
       VALUES (?, ?, ?, ?, ?)`,
    );
    ins.run('2026-01-01T00:00:00+00:00', '2026-01-01T00:05:00+00:00', 'v1', 0, '');
    ins.run('2026-02-01T00:00:00+00:00', '2026-02-01T00:05:00+00:00', 'v2', 1, 'too many void');
    db.prepare(
      'INSERT INTO frame_substance_runs (started_at, detector_version) VALUES (?, ?)',
    ).run('2026-03-01T00:00:00+00:00', 'v3');
    db.close();

    const body = await get();
    expect(body.frame_substance_run).toEqual({
      detector_version: 'v2',
      finished_at: '2026-02-01T00:05:00+00:00',
      breached: true,
      breach_reason: 'too many void',
    });
  });

  it('404s when the library database is missing', async () => {
    process.env.LIBRARY_DB = '/nonexistent/library.db';
    const res = await app.request('/api/insights-summary');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Library database not found' });
  });
});
