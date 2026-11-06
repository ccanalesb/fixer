/**
 * Catalog route tests.
 *
 * The filter and sort assertions matter more than usual here: the SQL was
 * transcribed clause by clause, and clause order determines positional binding
 * order, so a subtle transposition would still return *some* rows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { LibraryFixture } from './helpers/library-fixture.js';

let fx: LibraryFixture;
let cfgDir: string;
const app = createApp();
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

interface CatalogImage extends Record<string, unknown> {
  key: string;
}
interface ListBody {
  total: number;
  images: CatalogImage[];
}

beforeEach(() => {
  fx = new LibraryFixture().activate();
  // The thumbnail route reads config.yaml for its allowed roots; point it at a
  // temp file so it can never pick up the user's real vision cache or mount point.
  cfgDir = mkdtempSync(join(tmpdir(), 'lt-cat-cfg-'));
  writeFileSync(join(cfgDir, 'config.yaml'), 'workers: 4\n');
  process.env.LT_CONFIG_YAML = join(cfgDir, 'config.yaml');
});

afterEach(() => {
  fx.cleanup();
  delete process.env.LT_CONFIG_YAML;
  rmSync(cfgDir, { recursive: true, force: true });
});

describe('GET /api/images/catalog', () => {
  it('serves the same body at both the slashed and unslashed paths', async () => {
    fx.addImages('a');
    const bare = await json<ListBody>(await app.request('/api/images/catalog'));
    const slashed = await json<ListBody>(await app.request('/api/images/catalog/'));
    // Both paths are separate contract entries, not a redirect.
    expect(bare).toEqual(slashed);
    expect(bare.total).toBe(1);
  });

  it('orders newest first, with the key as tiebreaker', async () => {
    fx.addImage({ key: 'b-old', date_taken: '2026-01-01T00:00:00' });
    fx.addImage({ key: 'a-new', date_taken: '2026-03-01T00:00:00' });
    fx.addImage({ key: 'b-new', date_taken: '2026-03-01T00:00:00' });

    const body = await json<ListBody>(await app.request('/api/images/catalog'));
    expect(body.images.map((i) => i.key)).toEqual(['a-new', 'b-new', 'b-old']);
  });

  it('sorts oldest first on request', async () => {
    fx.addImage({ key: 'old', date_taken: '2026-01-01T00:00:00' });
    fx.addImage({ key: 'new', date_taken: '2026-03-01T00:00:00' });
    const body = await json<ListBody>(
      await app.request('/api/images/catalog?sort_by_date=oldest'),
    );
    expect(body.images.map((i) => i.key)).toEqual(['old', 'new']);
  });

  it('paginates with a SQL-level limit and reports the unpaged total', async () => {
    fx.addImage({ key: 'i1', date_taken: '2026-01-05T00:00:00' });
    fx.addImage({ key: 'i2', date_taken: '2026-01-04T00:00:00' });
    fx.addImage({ key: 'i3', date_taken: '2026-01-03T00:00:00' });

    const body = await json<ListBody>(await app.request('/api/images/catalog?limit=2&offset=1'));
    expect(body.total).toBe(3);
    expect(body.images.map((i) => i.key)).toEqual(['i2', 'i3']);
  });

  it('falls back to the default limit for an unparseable value', async () => {
    fx.addImages('a');
    // `request.args.get("limit", 50, type=int)` yields 50, not an error.
    expect((await app.request('/api/images/catalog?limit=abc')).status).toBe(200);
  });

  describe('row shaping', () => {
    it('exposes pick as the raw integer wire format', async () => {
      fx.addImage({ key: 'a', pick: 1 });
      const body = await json<ListBody>(await app.request('/api/images/catalog'));
      // OpenAPI says boolean, but the wire format sends raw 0/1 integers.
      expect(body.images[0]!.pick).toBe(1);
    });

    it('exposes instagram_posted and is_stack_representative as booleans', async () => {
      fx.addImage({ key: 'a', instagram_posted: true });
      const body = await json<ListBody>(await app.request('/api/images/catalog'));
      expect(body.images[0]!.instagram_posted).toBe(true);
      // Not in a stack: false, not null.
      expect(body.images[0]!.is_stack_representative).toBe(false);
    });

    it('decodes keywords from JSON text', async () => {
      fx.addImage({ key: 'a', keywords: '["street", "night"]' });
      const body = await json<ListBody>(await app.request('/api/images/catalog'));
      expect(body.images[0]!.keywords).toEqual(['street', 'night']);
    });

    it('numbers an all-digits id and nulls anything else', async () => {
      fx.addImage({ key: 'numeric', id: '10221677', date_taken: '2026-01-02' });
      fx.addImage({ key: 'notnumeric', id: 'abc-123', date_taken: '2026-01-01' });
      const body = await json<ListBody>(await app.request('/api/images/catalog'));
      const byKey = new Map(body.images.map((i) => [i.key, i]));
      expect(byKey.get('numeric')!.id).toBe(10221677);
      expect(byKey.get('notnumeric')!.id).toBeNull();
    });

    it('reports ai_analyzed false and null description fields when undescribed', async () => {
      fx.addImages('a');
      const body = await json<ListBody>(await app.request('/api/images/catalog'));
      expect(body.images[0]!.ai_analyzed).toBe(false);
      expect(body.images[0]!.description_summary).toBeNull();
      expect(body.images[0]!.description_best_perspective).toBeNull();
    });

    it('nulls the score perspective when there is no score, even so', async () => {
      fx.addImages('a');
      const body = await json<ListBody>(await app.request('/api/images/catalog'));
      expect(body.images[0]!.catalog_perspective_score).toBeNull();
      expect(body.images[0]!.catalog_score_perspective).toBeNull();
    });

    it('does not add thumbnail_url to list rows', async () => {
      fx.addImages('a');
      const body = await json<ListBody>(await app.request('/api/images/catalog'));
      // Only similarity, groups, and stack member routes attach thumbnail_url.
      expect('thumbnail_url' in body.images[0]!).toBe(false);
    });
  });

  describe('best current score', () => {
    it('picks the highest current catalog score', async () => {
      fx.addImages('a');
      fx.addPerspectives({ slug: 'street' }, { slug: 'documentary' });
      fx.addScores(
        { image_key: 'a', perspective_slug: 'street', score: 4 },
        { image_key: 'a', perspective_slug: 'documentary', score: 8 },
      );
      const body = await json<ListBody>(await app.request('/api/images/catalog'));
      expect(body.images[0]!.catalog_perspective_score).toBe(8);
      expect(body.images[0]!.catalog_score_perspective).toBe('documentary');
    });

    it('breaks a tie toward the lexicographically smallest slug', async () => {
      fx.addImages('a');
      fx.addPerspectives({ slug: 'street' }, { slug: 'documentary' });
      fx.addScores(
        { image_key: 'a', perspective_slug: 'street', score: 7 },
        { image_key: 'a', perspective_slug: 'documentary', score: 7 },
      );
      const body = await json<ListBody>(await app.request('/api/images/catalog'));
      expect(body.images[0]!.catalog_score_perspective).toBe('documentary');
    });

    it('ignores superseded scores', async () => {
      fx.addImages('a');
      fx.addPerspectives({ slug: 'street' });
      fx.addScores(
        // The superseded row carries the older `prompt_version`, which is what
        // makes it a second row at all under `uq_image_scores_versioned`.
        { image_key: 'a', perspective_slug: 'street', score: 10, prompt_version: 'v0', is_current: false },
        { image_key: 'a', perspective_slug: 'street', score: 3 },
      );
      const body = await json<ListBody>(await app.request('/api/images/catalog'));
      expect(body.images[0]!.catalog_perspective_score).toBe(3);
    });
  });

  describe('stack collapse', () => {
    it('hides non-representative members from the grid', async () => {
      fx.addImages('rep', 'member', 'solo');
      fx.addStack(['rep', 'member'], 'rep');
      const body = await json<ListBody>(await app.request('/api/images/catalog'));
      expect(body.images.map((i) => i.key).sort()).toEqual(['rep', 'solo']);
      // The total must reflect the collapse too, or pagination overruns.
      expect(body.total).toBe(2);
    });

    it('reports stack metadata on the representative row', async () => {
      fx.addImages('rep', 'member');
      fx.addStack(['rep', 'member'], 'rep');
      const body = await json<ListBody>(await app.request('/api/images/catalog'));
      expect(body.images[0]).toMatchObject({
        key: 'rep',
        stack_member_count: 2,
        is_stack_representative: true,
      });
    });

    it('filters to burst-stack representatives only', async () => {
      fx.addImages('rep', 'member', 'solo');
      fx.addStack(['rep', 'member'], 'rep');
      const on = await json<ListBody>(await app.request('/api/images/catalog?burst_stack=true'));
      expect(on.images.map((i) => i.key)).toEqual(['rep']);
      const off = await json<ListBody>(await app.request('/api/images/catalog?burst_stack=false'));
      expect(off.images.map((i) => i.key)).toEqual(['solo']);
    });
  });

  describe('filters', () => {
    it('filters by month, ignoring a malformed value', async () => {
      fx.addImage({ key: 'jan', date_taken: '2026-01-15T00:00:00' });
      fx.addImage({ key: 'feb', date_taken: '2026-02-15T00:00:00' });

      const jan = await json<ListBody>(await app.request('/api/images/catalog?month=202601'));
      expect(jan.images.map((i) => i.key)).toEqual(['jan']);

      // Not six digits: the filter is skipped rather than rejected.
      const bad = await json<ListBody>(await app.request('/api/images/catalog?month=2026'));
      expect(bad.total).toBe(2);
    });

    it('matches a keyword case-insensitively across four columns', async () => {
      fx.addImage({ key: 'by-title', title: 'Neon Alley' });
      fx.addImage({ key: 'by-keywords', keywords: '["NEON"]' });
      fx.addImage({ key: 'by-filename', filename: 'neon-sign.jpg' });
      fx.addImage({ key: 'by-description', description: 'a neon glow' });
      fx.addImage({ key: 'unrelated', title: 'Daylight' });

      const body = await json<ListBody>(await app.request('/api/images/catalog?keyword=neon'));
      expect(body.images.map((i) => i.key).sort()).toEqual([
        'by-description',
        'by-filename',
        'by-keywords',
        'by-title',
      ]);
    });

    it('filters by rating, colour label, date range and posted flag', async () => {
      fx.addImage({ key: 'a', rating: 5, color_label: 'Red', date_taken: '2026-01-10' });
      fx.addImage({ key: 'b', rating: 1, color_label: 'blue', date_taken: '2026-02-10' });
      fx.addImage({ key: 'c', rating: 3, instagram_posted: true, date_taken: '2026-03-10' });

      const rated = await json<ListBody>(await app.request('/api/images/catalog?min_rating=3'));
      expect(rated.images.map((i) => i.key).sort()).toEqual(['a', 'c']);

      // Colour matching is case-insensitive on both sides of the comparison.
      const red = await json<ListBody>(await app.request('/api/images/catalog?color_label=red'));
      expect(red.images.map((i) => i.key)).toEqual(['a']);

      const ranged = await json<ListBody>(
        await app.request('/api/images/catalog?date_from=2026-02-01&date_to=2026-02-28'),
      );
      expect(ranged.images.map((i) => i.key)).toEqual(['b']);

      const posted = await json<ListBody>(await app.request('/api/images/catalog?posted=true'));
      expect(posted.images.map((i) => i.key)).toEqual(['c']);
    });

    it('treats an unrecognized boolean as no filter', async () => {
      fx.addImages('a', 'b');
      // Only the exact strings "true" and "false" apply the filter.
      const body = await json<ListBody>(await app.request('/api/images/catalog?posted=yes'));
      expect(body.total).toBe(2);
    });

    it('filters on flagged frames, respecting a user override', async () => {
      fx.addImages('ok', 'void', 'overridden');
      fx.addFrameSubstance('void', 'void');
      fx.addFrameSubstance('overridden', 'illegible');
      fx.addFrameSubstanceOverride('overridden');

      const flagged = await json<ListBody>(await app.request('/api/images/catalog?flagged=true'));
      expect(flagged.images.map((i) => i.key)).toEqual(['void']);

      const unflagged = await json<ListBody>(
        await app.request('/api/images/catalog?flagged=false'),
      );
      // An override un-condemns the frame, so it belongs with the unflagged rows.
      expect(unflagged.images.map((i) => i.key).sort()).toEqual(['ok', 'overridden']);
    });

    it('filters on a score for an active perspective', async () => {
      fx.addImages('high', 'low', 'inactive-high');
      fx.addPerspectives({ slug: 'street' }, { slug: 'retired', active: false });
      fx.addScores(
        { image_key: 'high', perspective_slug: 'street', score: 9 },
        { image_key: 'low', perspective_slug: 'street', score: 2 },
        { image_key: 'inactive-high', perspective_slug: 'retired', score: 10 },
      );
      const body = await json<ListBody>(
        await app.request('/api/images/catalog?min_score_on_active=8'),
      );
      // A high score on a deactivated perspective must not qualify.
      expect(body.images.map((i) => i.key)).toEqual(['high']);
    });
  });

  describe('score sorting', () => {
    beforeEach(() => {
      fx.addImages('mid', 'top', 'unscored');
      fx.addPerspectives({ slug: 'street' });
      fx.addScores(
        { image_key: 'mid', perspective_slug: 'street', score: 5 },
        { image_key: 'top', perspective_slug: 'street', score: 9 },
      );
    });

    it('sorts descending with unscored rows last', async () => {
      const body = await json<ListBody>(
        await app.request('/api/images/catalog?score_perspective=street&sort_by_score=desc'),
      );
      expect(body.images.map((i) => i.key)).toEqual(['top', 'mid', 'unscored']);
    });

    it('sorts ascending with unscored rows still last', async () => {
      const body = await json<ListBody>(
        await app.request('/api/images/catalog?score_perspective=street&sort_by_score=asc'),
      );
      // `(s.score IS NULL) ASC` comes first in both directions, so an unscored row
      // never leads an ascending sort.
      expect(body.images.map((i) => i.key)).toEqual(['mid', 'top', 'unscored']);
    });

    it('filters by min_score for the chosen perspective', async () => {
      const body = await json<ListBody>(
        await app.request('/api/images/catalog?score_perspective=street&min_score=6'),
      );
      expect(body.images.map((i) => i.key)).toEqual(['top']);
    });
  });

  describe('errors', () => {
    it.each([
      ['?sort_by_score=sideways', 'sort_by_score must be asc or desc'],
      ['?sort_by_date=sideways', 'sort_by_date must be newest or oldest'],
      ['?min_score=abc', 'min_score must be an integer'],
      ['?min_score=99', 'min_score must be between 1 and 10'],
      ['?min_score_on_active=99', 'min_score_on_active must be between 1 and 10'],
      ['?score_perspective=nope-xyz', "unknown perspective 'nope-xyz'"],
      ['?description_search=a', 'description_search must be at least 2 characters'],
    ])('400s on %s', async (query, message) => {
      const res = await app.request(`/api/images/catalog${query}`);
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ error: message });
    });

    it('400s when a score filter is given without a perspective', async () => {
      const res = await app.request('/api/images/catalog?min_score=5');
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ error: 'min_score requires score_perspective' });

      const sorted = await app.request('/api/images/catalog?sort_by_score=desc');
      expect(await json(sorted)).toEqual({ error: 'sort_by_score requires score_perspective' });
    });

    it('reports the unknown perspective before the missing-perspective rule', async () => {
      // When both fail, the unknown perspective error wins over the missing-perspective rule.
      const res = await app.request(
        '/api/images/catalog?score_perspective=nope-xyz&min_score=5',
      );
      expect(await json(res)).toEqual({ error: "unknown perspective 'nope-xyz'" });
    });

    it('accepts a perspective that exists but is deactivated', async () => {
      fx.addImages('a');
      fx.addPerspectives({ slug: 'retired', active: false });
      // Existence is satisfied by any row, so historical scores stay reachable.
      const res = await app.request('/api/images/catalog?score_perspective=retired');
      expect(res.status).toBe(200);
    });

    it('404s when the library database is missing', async () => {
      process.env.LIBRARY_DB = '/nonexistent/library.db';
      const res = await app.request('/api/images/catalog');
      expect(res.status).toBe(404);
      expect(await json(res)).toEqual({ error: 'Library database not found' });
    });
  });
});

describe('GET /api/images/catalog/months', () => {
  it('lists distinct YYYYMM values newest first, skipping null dates', async () => {
    fx.addImage({ key: 'a', date_taken: '2026-03-15T00:00:00' });
    fx.addImage({ key: 'b', date_taken: '2026-03-20T00:00:00' });
    fx.addImage({ key: 'c', date_taken: '2026-01-02T00:00:00' });
    fx.addImage({ key: 'undated', date_taken: null });

    const body = await json<{ months: string[] }>(
      await app.request('/api/images/catalog/months'),
    );
    expect(body.months).toEqual(['202603', '202601']);
  });

  it('is matched by its own route rather than as an image key', async () => {
    // `/months` is registered before `/{image_key}`; a regression here would return
    // a 404 "Image not found" instead of the month list.
    fx.addImages('a');
    expect((await app.request('/api/images/catalog/months')).status).toBe(200);
  });
});

describe('GET /api/images/catalog/{image_key}', () => {
  it('returns the detail payload with identity aggregates', async () => {
    fx.addImage({ key: 'a', id: '42', width: 6000, height: 4000 });
    fx.addPerspectives({ slug: 'street', display_name: 'Street' }, { slug: 'documentary' });
    fx.addScores(
      { image_key: 'a', perspective_slug: 'street', score: 6, rationale: 'strong light' },
      { image_key: 'a', perspective_slug: 'documentary', score: 8 },
    );

    const res = await app.request('/api/images/catalog/a');
    expect(res.status).toBe(200);
    const body = await json<Record<string, unknown>>(res);

    expect(body.image_type).toBe('catalog');
    expect(body.id).toBe(42);
    // Equal weighting across active perspectives: (6 + 8) / 2.
    expect(body.identity_aggregate_score).toBe(7);
    expect(body.identity_perspectives_covered).toBe(2);
    expect(body.identity_eligible).toBe(true);
    expect(body.catalog_perspective_score).toBe(8);
    expect(body.available_score_perspectives).toEqual(['documentary', 'street']);
  });

  it('sorts identity perspectives by slug and previews the rationale', async () => {
    fx.addImages('a');
    fx.addPerspectives({ slug: 'street' }, { slug: 'documentary' });
    fx.addScores(
      { image_key: 'a', perspective_slug: 'street', score: 6, rationale: 'x'.repeat(300) },
      { image_key: 'a', perspective_slug: 'documentary', score: 8, rationale: 'short' },
    );
    const body = await json<{
      identity_per_perspective: { perspective_slug: string; rationale_preview: string }[];
    }>(await app.request('/api/images/catalog/a'));

    expect(body.identity_per_perspective.map((p) => p.perspective_slug)).toEqual([
      'documentary',
      'street',
    ]);
    const long = body.identity_per_perspective[1]!.rationale_preview;
    expect(long).toHaveLength(240);
    expect(long.endsWith('…')).toBe(true);
  });

  it('reports no identity when scores exist only on inactive perspectives', async () => {
    fx.addImages('a');
    fx.addPerspectives({ slug: 'retired', active: false });
    fx.addScores({ image_key: 'a', perspective_slug: 'retired', score: 9 });

    const body = await json<Record<string, unknown>>(await app.request('/api/images/catalog/a'));
    expect(body.identity_aggregate_score).toBeNull();
    expect(body.identity_perspectives_covered).toBe(0);
    expect(body.identity_eligible).toBe(false);
    expect(body.identity_per_perspective).toEqual([]);
  });

  it('excludes not_attempted scores from the aggregate', async () => {
    fx.addImages('a');
    fx.addPerspectives({ slug: 'street' }, { slug: 'optional-lens', optional: true });
    fx.addScores(
      { image_key: 'a', perspective_slug: 'street', score: 4 },
      { image_key: 'a', perspective_slug: 'optional-lens', score: 4, not_attempted: true },
    );
    const body = await json<Record<string, unknown>>(await app.request('/api/images/catalog/a'));
    // A placeholder for an excusable dimension must not drag the mean to 2.
    expect(body.identity_aggregate_score).toBe(4);
    expect(body.identity_perspectives_covered).toBe(1);
  });

  it('excludes a condemned frame from identity entirely', async () => {
    fx.addImages('a');
    fx.addPerspectives({ slug: 'street' });
    fx.addScores({ image_key: 'a', perspective_slug: 'street', score: 7 });
    fx.addFrameSubstance('a', 'void');

    const body = await json<Record<string, unknown>>(await app.request('/api/images/catalog/a'));
    expect(body.identity_aggregate_score).toBeNull();
  });

  it('serves a non-representative stack member on its own detail route', async () => {
    fx.addImages('rep', 'member');
    fx.addStack(['rep', 'member'], 'rep');
    const body = await json<Record<string, unknown>>(
      await app.request('/api/images/catalog/member'),
    );
    // Collapsed out of the grid, but still directly addressable.
    expect(body.key).toBe('member');
    expect(body.is_stack_representative).toBe(false);
    expect(body.stack_member_count).toBe(2);
  });

  it('404s for an unknown key', async () => {
    const res = await app.request('/api/images/catalog/nope');
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: 'Image not found' });
  });

  it('400s an unknown score_perspective before looking the image up', async () => {
    const res = await app.request('/api/images/catalog/nope?score_perspective=bogus');
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: "unknown perspective 'bogus'" });
  });
});

describe('PATCH /api/images/catalog/{image_key}/instagram-posted', () => {
  const patch = (key: string, body: unknown) =>
    app.request(`/api/images/catalog/${key}/instagram-posted`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('sets the flag and echoes the request value', async () => {
    fx.addImages('a');
    const res = await patch('a', { posted: true });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ key: 'a', instagram_posted: true });
    expect(fx.query('SELECT instagram_posted FROM images WHERE key = ?', 'a')).toEqual([
      { instagram_posted: 1 },
    ]);
  });

  it('clears the flag', async () => {
    fx.addImage({ key: 'a', instagram_posted: true });
    expect((await patch('a', { posted: false })).status).toBe(200);
    expect(fx.query('SELECT instagram_posted FROM images WHERE key = ?', 'a')).toEqual([
      { instagram_posted: 0 },
    ]);
  });

  it('succeeds when the value is unchanged', async () => {
    fx.addImage({ key: 'a', instagram_posted: true });
    // Zero rows changed is a no-op, not a failure.
    expect((await patch('a', { posted: true })).status).toBe(200);
  });

  it('404s for an unknown key, without writing', async () => {
    const res = await patch('nope', { posted: true });
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: 'Image not found' });
  });

  it('422s a non-boolean or missing value', async () => {
    fx.addImages('a');
    // The declared body schema rejects these before the handler runs.
    expect((await patch('a', { posted: 'yes' })).status).toBe(422);
    expect((await patch('a', {})).status).toBe(422);
  });
});

describe('GET /api/images/catalog/{image_key}/thumbnail', () => {
  it('404s for an unknown key', async () => {
    const res = await app.request('/api/images/catalog/nope/thumbnail');
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: 'Image not found' });
  });

  it('404s when the file sits outside every allowed root', async () => {
    // The containment check is the security boundary of this route: the key comes
    // from the URL and the path from the database. With no vision cache and no
    // mount point configured, nothing is servable.
    const outside = join(cfgDir, 'outside.jpg');
    writeFileSync(outside, 'not really a jpeg');
    fx.addImage({ key: 'a', filepath: outside });

    const res = await app.request('/api/images/catalog/a/thumbnail');
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: 'Image file not found' });
  });

  it('404s when the original file does not exist', async () => {
    // `addImages` points filepath at /photos/<key>.jpg, which is not there.
    fx.addImages('a');
    const res = await app.request('/api/images/catalog/a/thumbnail');
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: 'Image file not found' });
  });

  it('serves the JPEG sidecar when the row filepath is a RAW', async () => {
    const photoDir = mkdtempSync(join(tmpdir(), 'lt-raw-sidecar-'));
    const rawPath = join(photoDir, 'pair.dng');
    const jpegPath = join(photoDir, 'pair.jpg');
    writeFileSync(rawPath, 'raw');
    writeFileSync(jpegPath, 'jpeg-bytes');
    writeFileSync(join(cfgDir, 'config.yaml'), `mount_point: ${JSON.stringify(photoDir)}\n`);
    fx.addImage({ key: 'pair', filepath: rawPath, filename: 'pair' });

    const res = await app.request('/api/images/catalog/pair/thumbnail');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('jpeg-bytes');
    rmSync(photoDir, { recursive: true, force: true });
  });

  it('serves a decoded JPEG for a HEIC original on a cache miss', async () => {
    const photoDir = mkdtempSync(join(tmpdir(), 'lt-heic-thumb-'));
    const heicPath = join(photoDir, 'IMG_0001.HEIC');
    const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'example.heic');
    copyFileSync(fixture, heicPath);
    writeFileSync(join(cfgDir, 'config.yaml'), `mount_point: ${JSON.stringify(photoDir)}\n`);
    fx.addImage({ key: 'heic', filepath: heicPath, filename: 'IMG_0001' });

    const res = await app.request('/api/images/catalog/heic/thumbnail');
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect((await sharp(bytes).metadata()).format).toBe('jpeg');
    rmSync(photoDir, { recursive: true, force: true });
  });

  it('is absent from the OpenAPI document', async () => {
    // Returns a file, not JSON, so it must not appear in the OpenAPI contract.
    const doc = await json<{ paths: Record<string, unknown> }>(
      await app.request('/apidoc/openapi.json'),
    );
    expect(Object.keys(doc.paths)).not.toContain(
      '/api/images/catalog/{image_key}/thumbnail',
    );
  });
});

describe('GET /api/images/catalog-similarity-groups', () => {
  it('returns groups with the seed, ranked candidates and thumbnail URLs', async () => {
    fx.addImages('seed', 'cand-a', 'cand-b');
    fx.addSimilarityGroup({
      seed_key: 'seed',
      candidates: [
        { key: 'cand-a', similarity: 0.95, why_matched: 'stored reason' },
        { key: 'cand-b', similarity: 0.8 },
      ],
      job_id: 'job-1',
    });

    const res = await app.request('/api/images/catalog-similarity-groups');
    expect(res.status).toBe(200);
    const body = await json<{
      total: number;
      items: {
        group_id: number;
        seed: { key: string; thumbnail_url: string };
        candidates: { key: string; similarity: number; why_matched: string }[];
        candidate_count: number;
        best_similarity: number;
        job_id: string;
      }[];
    }>(res);

    expect(body.total).toBe(1);
    const group = body.items[0]!;
    expect(group.seed.key).toBe('seed');
    expect(group.seed.thumbnail_url).toBe('/api/images/catalog/seed/thumbnail');
    expect(group.candidates.map((c) => c.key)).toEqual(['cand-a', 'cand-b']);
    expect(group.candidate_count).toBe(2);
    expect(group.best_similarity).toBeCloseTo(0.95);
    expect(group.job_id).toBe('job-1');
  });

  it('keeps a stored why_matched and synthesizes one when blank', async () => {
    fx.addImages('seed', 'cand-a', 'cand-b');
    fx.addSimilarityGroup({
      seed_key: 'seed',
      candidates: [
        { key: 'cand-a', similarity: 0.95, why_matched: 'stored reason' },
        { key: 'cand-b', similarity: 0.874 },
      ],
    });
    const body = await json<{
      items: { candidates: { key: string; why_matched: string }[] }[];
    }>(await app.request('/api/images/catalog-similarity-groups'));
    const byKey = new Map(body.items[0]!.candidates.map((c) => [c.key, c.why_matched]));
    expect(byKey.get('cand-a')).toBe('stored reason');
    expect(byKey.get('cand-b')).toBe('Visual match (87%)');
  });

  it('drops a group whose seed is collapsed into a stack', async () => {
    fx.addImages('rep', 'seed', 'cand');
    fx.addStack(['rep', 'seed'], 'rep');
    fx.addSimilarityGroup({ seed_key: 'seed', candidates: [{ key: 'cand', similarity: 0.9 }] });

    const body = await json<{ total: number; items: unknown[] }>(
      await app.request('/api/images/catalog-similarity-groups'),
    );
    // A group with no visible seed is not reviewable, so the item is skipped —
    // but `total` still counts the stored group.
    expect(body.items).toHaveLength(0);
    expect(body.total).toBe(1);
  });

  it('defaults to a limit of 20, not 50', async () => {
    fx.addImages('seed', 'cand');
    for (let i = 0; i < 25; i += 1) {
      fx.addSimilarityGroup({
        seed_key: 'seed',
        candidates: [{ key: 'cand', similarity: 0.9 }],
        created_at: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00`,
      });
    }
    const body = await json<{ items: unknown[]; total: number }>(
      await app.request('/api/images/catalog-similarity-groups'),
    );
    expect(body.total).toBe(25);
    expect(body.items).toHaveLength(20);
  });
});

describe('/api/images/{bad_type}/...', () => {
  it('400s with the legacy message for an unmounted family', async () => {
    const res = await app.request('/api/images/bogus/whatever');
    expect(res.status).toBe(400);
    // The error string uses a tuple repr; the frontend depends on this exact shape.
    expect(await json(res)).toEqual({
      error: "invalid image_type; expected one of ('catalog', 'instagram')",
    });
  });

  it('catches a non-numeric stack id with the legacy 400', async () => {
    // A non-numeric stack id hits the image_type catch-all (400), not stack-not-found (404).
    const res = await app.request('/api/images/stacks/abc/members');
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      error: "invalid image_type; expected one of ('catalog', 'instagram')",
    });
  });
});
