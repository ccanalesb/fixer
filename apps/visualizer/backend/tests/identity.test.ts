/**
 * Identity route tests.
 *
 * Percentile maths is worth testing at unit scale: on a real catalog every value
 * looks plausible, but here the population is small enough to compute by hand.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { midrankPercentileRanks } from '../src/identity/percentiles.js';
import { roundHalfEven } from '../src/identity/suggest-post.js';
import { binomSf } from '../src/identity/signature.js';
import { LibraryFixture } from './helpers/library-fixture.js';

let fx: LibraryFixture;
const app = createApp();
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

interface BestPhotos {
  total: number;
  items: {
    image_key: string;
    peak_percentile: number;
    ranking_percentile: number;
    corroboration_revoked: boolean;
    corroboration_revoked_by: string;
    perspectives_covered: number;
    filename: string;
    instagram_posted: boolean;
    stack_id: number | null;
    per_perspective: { perspective_slug: string; percentile: number; score: number }[];
  }[];
  meta: Record<string, unknown>;
}

beforeEach(() => {
  fx = new LibraryFixture().activate();
});
afterEach(() => fx.cleanup());

describe('midrank percentile ranks', () => {
  it('gives a lone score the top rank', () => {
    expect([...midrankPercentileRanks([7])]).toEqual([[7, 1]]);
  });

  it('spreads distinct scores evenly from 0 to 1', () => {
    const ranks = midrankPercentileRanks([1, 2, 3, 4, 5]);
    expect(ranks.get(1)).toBeCloseTo(0, 12);
    expect(ranks.get(3)).toBeCloseTo(0.5, 12);
    expect(ranks.get(5)).toBeCloseTo(1, 12);
  });

  it('averages the ranks a tied group spans', () => {
    // Four values, two of them tied at 5: ranks 1, (2+3)/2 = 2.5, 4.
    const ranks = midrankPercentileRanks([1, 5, 5, 9]);
    expect(ranks.get(1)).toBeCloseTo(0, 12);
    expect(ranks.get(5)).toBeCloseTo((2.5 - 1) / 3, 12);
    expect(ranks.get(9)).toBeCloseTo(1, 12);
  });

  it('sorts scores numerically, not as strings', () => {
    // A string sort would place 10 between 1 and 2 and invert the ranking.
    const ranks = midrankPercentileRanks([2, 10]);
    expect(ranks.get(2)).toBeCloseTo(0, 12);
    expect(ranks.get(10)).toBeCloseTo(1, 12);
  });

  it('returns nothing for an empty population', () => {
    expect(midrankPercentileRanks([]).size).toBe(0);
  });
});

describe('round half to even', () => {
  it.each([
    [4.5, 4],
    [5.5, 6],
    [22.5, 22],
    [13.5, 14],
    [3.6, 4],
    [5.4, 5],
    [0.5, 0],
  ])('round(%s) === %s', (input, expected) => {
    // Math.round would give 5, 6, 23, 14, 4, 5, 1 — differing on four of these.
    expect(roundHalfEven(input)).toBe(expected);
  });
});

describe('binomial upper tail', () => {
  it('is exact below n = 30', () => {
    // P(X >= 3) for Binomial(3, 0.5) = 1/8.
    expect(binomSf(3, 3, 0.5)).toBeCloseTo(0.125, 12);
    // P(X >= 1) for Binomial(4, 0.5) = 1 - (1/2)^4.
    expect(binomSf(1, 4, 0.5)).toBeCloseTo(0.9375, 12);
  });

  it('handles the degenerate arguments the way the caller expects', () => {
    expect(binomSf(0, 10, 0.3)).toBe(1);
    expect(binomSf(11, 10, 0.3)).toBe(0);
  });

  it('switches to the normal approximation at n = 30 and stays in range', () => {
    const p = binomSf(20, 40, 0.5);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
    // Deep in the tail it must be small but not negative.
    const deep = binomSf(39, 40, 0.5);
    expect(deep).toBeGreaterThanOrEqual(0);
    expect(deep).toBeLessThan(1e-6);
  });
});

describe('GET /api/identity/best-photos', () => {
  it('ranks by peak within-perspective percentile', async () => {
    fx.addImage({ key: 'top', filename: 'top.jpg', date_taken: '2026-01-01' });
    fx.addImage({ key: 'mid', filename: 'mid.jpg', date_taken: '2026-01-02' });
    fx.addImage({ key: 'low', filename: 'low.jpg', date_taken: '2026-01-03' });
    fx.addPerspectives({ slug: 'street' });
    fx.addScores(
      { image_key: 'top', perspective_slug: 'street', score: 9 },
      { image_key: 'mid', perspective_slug: 'street', score: 5 },
      { image_key: 'low', perspective_slug: 'street', score: 2 },
    );

    const res = await app.request('/api/identity/best-photos');
    expect(res.status).toBe(200);
    const body = await json<BestPhotos>(res);

    expect(body.total).toBe(3);
    expect(body.items.map((i) => i.image_key)).toEqual(['top', 'mid', 'low']);
    expect(body.items[0]!.peak_percentile).toBeCloseTo(1, 6);
    expect(body.items[2]!.peak_percentile).toBeCloseTo(0, 6);
    expect(body.items[0]!.filename).toBe('top.jpg');
  });

  it('normalizes within each perspective, not across them', async () => {
    // `harsh` never gives above 4; `easy` never below 7. Ranking on raw scores would
    // put every easy-lens photo on top; percentiles make them comparable.
    fx.addImages('a', 'b');
    fx.addPerspectives({ slug: 'easy' }, { slug: 'harsh' });
    fx.addScores(
      { image_key: 'a', perspective_slug: 'easy', score: 7 },
      { image_key: 'b', perspective_slug: 'easy', score: 8 },
      { image_key: 'a', perspective_slug: 'harsh', score: 4 },
      { image_key: 'b', perspective_slug: 'harsh', score: 3 },
    );

    const body = await json<BestPhotos>(await app.request('/api/identity/best-photos'));
    const byKey = new Map(body.items.map((i) => [i.image_key, i]));
    // Each image tops exactly one lens, so both peak at 1.
    expect(byKey.get('a')!.peak_percentile).toBeCloseTo(1, 6);
    expect(byKey.get('b')!.peak_percentile).toBeCloseTo(1, 6);
  });

  describe('the corroboration veto', () => {
    it('ranks on the second-highest percentile when any lens scored 1', async () => {
      fx.addImages('flattered', 'solid', 'filler-a', 'filler-b');
      fx.addPerspectives({ slug: 'easy' }, { slug: 'harsh' });
      fx.addScores(
        // `flattered` tops `easy` but is a 1 on `harsh`.
        { image_key: 'flattered', perspective_slug: 'easy', score: 10 },
        { image_key: 'flattered', perspective_slug: 'harsh', score: 1 },
        // `solid` is respectable on both.
        { image_key: 'solid', perspective_slug: 'easy', score: 8 },
        { image_key: 'solid', perspective_slug: 'harsh', score: 7 },
        { image_key: 'filler-a', perspective_slug: 'easy', score: 5 },
        { image_key: 'filler-a', perspective_slug: 'harsh', score: 5 },
        { image_key: 'filler-b', perspective_slug: 'easy', score: 3 },
        { image_key: 'filler-b', perspective_slug: 'harsh', score: 3 },
      );

      const body = await json<BestPhotos>(await app.request('/api/identity/best-photos'));
      const byKey = new Map(body.items.map((i) => [i.image_key, i]));
      const flattered = byKey.get('flattered')!;

      // Its peak is still the top of `easy` …
      expect(flattered.peak_percentile).toBeCloseTo(1, 6);
      // … but it is ranked on the second opinion, which is the bottom of `harsh`.
      expect(flattered.ranking_percentile).toBeCloseTo(0, 6);
      expect(flattered.corroboration_revoked).toBe(true);
      expect(flattered.corroboration_revoked_by).toBe('harsh');

      // And that is the point: one enthusiastic lens no longer crowns it.
      expect(body.items[0]!.image_key).toBe('solid');
      expect(body.items.at(-1)!.image_key).toBe('flattered');
    });

    it('leaves an image with no 1 alone', async () => {
      fx.addImages('a', 'b');
      fx.addPerspectives({ slug: 'street' });
      fx.addScores(
        { image_key: 'a', perspective_slug: 'street', score: 9 },
        { image_key: 'b', perspective_slug: 'street', score: 2 },
      );
      const body = await json<BestPhotos>(await app.request('/api/identity/best-photos'));
      for (const item of body.items) {
        expect(item.corroboration_revoked).toBe(false);
        expect(item.corroboration_revoked_by).toBe('');
        expect(item.ranking_percentile).toBeCloseTo(item.peak_percentile, 6);
      }
    });

    it('sends a single-lens image scored 1 to the bottom', async () => {
      fx.addImages('lonely', 'other');
      fx.addPerspectives({ slug: 'street' });
      fx.addScores(
        { image_key: 'lonely', perspective_slug: 'street', score: 1 },
        { image_key: 'other', perspective_slug: 'street', score: 1 },
      );
      const body = await json<BestPhotos>(await app.request('/api/identity/best-photos'));
      // Both scored 1 on the only lens, so both peak at 1.0 within that lens — but
      // with no second opinion to fall back to, ranking is 0.
      expect(body.items[0]!.ranking_percentile).toBe(0);
      expect(body.items[0]!.corroboration_revoked).toBe(true);
    });

    it('names the lowest-scoring lens as the revoker, then the smallest slug', async () => {
      fx.addImages('a');
      fx.addPerspectives({ slug: 'zulu' }, { slug: 'alpha' }, { slug: 'mid' });
      fx.addScores(
        { image_key: 'a', perspective_slug: 'zulu', score: 1 },
        { image_key: 'a', perspective_slug: 'alpha', score: 1 },
        { image_key: 'a', perspective_slug: 'mid', score: 5 },
      );
      const body = await json<BestPhotos>(await app.request('/api/identity/best-photos'));
      expect(body.items[0]!.corroboration_revoked_by).toBe('alpha');
    });
  });

  it('collapses burst stacks to the representative', async () => {
    fx.addImages('rep', 'member', 'solo');
    fx.addStack(['rep', 'member'], 'rep');
    fx.addPerspectives({ slug: 'street' });
    fx.addScores(
      { image_key: 'rep', perspective_slug: 'street', score: 8 },
      { image_key: 'member', perspective_slug: 'street', score: 9 },
      { image_key: 'solo', perspective_slug: 'street', score: 5 },
    );

    const body = await json<BestPhotos>(await app.request('/api/identity/best-photos'));
    // `member` scores higher but is not the representative; a burst would otherwise
    // fill the page with near-identical frames.
    expect(body.items.map((i) => i.image_key)).toEqual(['rep', 'solo']);
    expect(body.items[0]!.stack_id).not.toBeNull();
    expect(body.items[1]!.stack_id).toBeNull();
  });

  it('filters on posted state', async () => {
    fx.addImage({ key: 'posted', instagram_posted: true });
    fx.addImage({ key: 'unposted' });
    fx.addPerspectives({ slug: 'street' });
    fx.addScores(
      { image_key: 'posted', perspective_slug: 'street', score: 8 },
      { image_key: 'unposted', perspective_slug: 'street', score: 5 },
    );

    const yes = await json<BestPhotos>(await app.request('/api/identity/best-photos?posted=true'));
    expect(yes.items.map((i) => i.image_key)).toEqual(['posted']);
    const no = await json<BestPhotos>(await app.request('/api/identity/best-photos?posted=no'));
    expect(no.items.map((i) => i.image_key)).toEqual(['unposted']);
  });

  it('uses sort_by_date only as a tiebreaker', async () => {
    fx.addImage({ key: 'older', date_taken: '2026-01-01' });
    fx.addImage({ key: 'newer', date_taken: '2026-06-01' });
    fx.addImage({ key: 'best', date_taken: '2020-01-01' });
    fx.addPerspectives({ slug: 'street' });
    fx.addScores(
      // `older` and `newer` tie; `best` outranks both despite being oldest.
      { image_key: 'older', perspective_slug: 'street', score: 5 },
      { image_key: 'newer', perspective_slug: 'street', score: 5 },
      { image_key: 'best', perspective_slug: 'street', score: 9 },
    );

    const newest = await json<BestPhotos>(await app.request('/api/identity/best-photos'));
    expect(newest.items.map((i) => i.image_key)).toEqual(['best', 'newer', 'older']);

    const oldest = await json<BestPhotos>(
      await app.request('/api/identity/best-photos?sort_by_date=oldest'),
    );
    // Ranking still wins; only the tied pair swaps.
    expect(oldest.items.map((i) => i.image_key)).toEqual(['best', 'older', 'newer']);
  });

  it('honours min_perspectives for eligibility', async () => {
    fx.addImages('both', 'one');
    fx.addPerspectives({ slug: 'a-lens' }, { slug: 'b-lens' });
    fx.addScores(
      { image_key: 'both', perspective_slug: 'a-lens', score: 5 },
      { image_key: 'both', perspective_slug: 'b-lens', score: 5 },
      { image_key: 'one', perspective_slug: 'a-lens', score: 9 },
    );

    const dflt = await json<BestPhotos>(await app.request('/api/identity/best-photos'));
    expect(dflt.total).toBe(2);

    const strict = await json<BestPhotos>(
      await app.request('/api/identity/best-photos?min_perspectives=2'),
    );
    expect(strict.items.map((i) => i.image_key)).toEqual(['both']);
    expect(strict.meta.min_perspectives_used).toBe(2);
  });

  it('reports a coverage note when nothing qualifies', async () => {
    fx.addImages('a');
    fx.addPerspectives({ slug: 'street' });
    fx.addScores({ image_key: 'a', perspective_slug: 'street', score: 5 });

    const body = await json<BestPhotos>(
      await app.request('/api/identity/best-photos?min_perspectives=5'),
    );
    expect(body.total).toBe(0);
    expect(body.meta.coverage_note).toContain('No images meet the minimum perspective coverage');
  });

  it.each([
    ['?min_perspectives=0', 'min_perspectives must be at least 1'],
    ['?sort_by_date=sideways', 'sort_by_date must be newest or oldest'],
    ['?posted=maybe', 'posted must be true or false'],
  ])('400s on %s', async (query, message) => {
    const res = await app.request(`/api/identity/best-photos${query}`);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: message });
  });

  it('caps min_perspectives at 50 rather than rejecting it', async () => {
    fx.addImages('a');
    const body = await json<BestPhotos>(
      await app.request('/api/identity/best-photos?min_perspectives=999'),
    );
    expect(body.meta.min_perspectives_used).toBe(50);
  });
});

describe('GET /api/identity/mirror', () => {
  it('crowns the lens that wins the argmax more often than chance', async () => {
    fx.addPerspectives({ slug: 'signature', display_name: 'Signature' }, { slug: 'other' });
    // Constructed so the arithmetic is checkable by hand. `other` scores every image
    // the same, so every image sits at its median percentile of exactly 0.5. Ten of
    // the twelve images score 9 on `signature` and two score 2; with midrank ties
    // that puts the ten at (7.5 - 1) / 11 = 0.5909 and the two at 0.04545. So
    // `signature` takes the argmax on ten images and loses two.
    //
    // Twelve is below the exact-binomial cutoff, so the p-value is exact:
    // P(X >= 10 | Bin(12, 0.5)) = 79 / 4096 = 0.0193 < 0.05, and `other`'s
    // P(X >= 2) = 0.997 is nowhere near it.
    for (let i = 0; i < 12; i += 1) {
      const key = `img-${String(i).padStart(2, '0')}`;
      fx.addImages(key);
      fx.addScores(
        { image_key: key, perspective_slug: 'signature', score: i < 10 ? 9 : 2 },
        { image_key: key, perspective_slug: 'other', score: 5 },
      );
    }

    const res = await app.request('/api/identity/mirror');
    expect(res.status).toBe(200);
    const body = await json<{
      population: number;
      sections: { perspective_slug: string; crowned: boolean; votes: number; photos_on: number; strength_label: string }[];
      other_lenses: { perspective_slug: string; votes: number }[];
      meta: { fallback_active: boolean };
    }>(res);

    expect(body.population).toBe(12);
    expect(body.sections).toHaveLength(1);
    expect(body.sections[0]!.perspective_slug).toBe('signature');
    expect(body.sections[0]!.crowned).toBe(true);
    expect(body.sections[0]!.votes).toBe(10);
    expect(body.sections[0]!.photos_on).toBe(12);
    expect(body.meta.fallback_active).toBe(false);
    expect(body.other_lenses.map((l) => l.perspective_slug)).toEqual(['other']);
    expect(body.other_lenses[0]!.votes).toBe(2);
  });

  it('excludes single-lens images from the vote', async () => {
    fx.addImages('two-lens', 'one-lens');
    fx.addPerspectives({ slug: 'a-lens' }, { slug: 'b-lens' });
    fx.addScores(
      { image_key: 'two-lens', perspective_slug: 'a-lens', score: 8 },
      { image_key: 'two-lens', perspective_slug: 'b-lens', score: 3 },
      { image_key: 'one-lens', perspective_slug: 'a-lens', score: 9 },
    );
    const body = await json<{ population: number }>(await app.request('/api/identity/mirror'));
    // A photo scored on one lens cannot express a preference between lenses.
    expect(body.population).toBe(1);
  });

  it('falls back to the leading lens, labelled honestly, when nothing is crowned', async () => {
    fx.addImages('a', 'b');
    fx.addPerspectives({ slug: 'a-lens' }, { slug: 'b-lens' });
    fx.addScores(
      { image_key: 'a', perspective_slug: 'a-lens', score: 8 },
      { image_key: 'a', perspective_slug: 'b-lens', score: 3 },
      { image_key: 'b', perspective_slug: 'a-lens', score: 3 },
      { image_key: 'b', perspective_slug: 'b-lens', score: 8 },
    );
    const body = await json<{
      sections: { leading_not_distinctive: boolean; strength_label: string; crowned: boolean }[];
      meta: { fallback_active: boolean };
    }>(await app.request('/api/identity/mirror'));

    expect(body.meta.fallback_active).toBe(true);
    expect(body.sections).toHaveLength(1);
    expect(body.sections[0]!.crowned).toBe(false);
    expect(body.sections[0]!.leading_not_distinctive).toBe(true);
    expect(body.sections[0]!.strength_label).toBe('Leading, but not strongly distinctive');
  });

  it('returns an empty mirror for a catalog with no scores', async () => {
    fx.addImages('a');
    const body = await json<{ population: number; sections: unknown[]; other_lenses: unknown[] }>(
      await app.request('/api/identity/mirror'),
    );
    expect(body.population).toBe(0);
    expect(body.sections).toEqual([]);
    expect(body.other_lenses).toEqual([]);
  });
});

describe('GET /api/identity/mirror/lens/{slug}/exemplars', () => {
  beforeEach(() => {
    fx.addPerspectives({ slug: 'street', display_name: 'Street' }, { slug: 'other' });
    fx.addImage({ key: 'pure', filename: 'pure.jpg' });
    fx.addImage({ key: 'mixed', filename: 'mixed.jpg' });
    fx.addImage({ key: 'weak', filename: 'weak.jpg' });
    fx.addScores(
      // `pure` and `mixed` tie at the top of `street`; `pure` separates further from
      // its own second-best lens, so it should win the purity tiebreak.
      { image_key: 'pure', perspective_slug: 'street', score: 9, rationale: 'clean lines' },
      { image_key: 'pure', perspective_slug: 'other', score: 1 },
      { image_key: 'mixed', perspective_slug: 'street', score: 9 },
      { image_key: 'mixed', perspective_slug: 'other', score: 9 },
      { image_key: 'weak', perspective_slug: 'street', score: 2 },
      { image_key: 'weak', perspective_slug: 'other', score: 5 },
    );
  });

  it('ranks by percentile then purity', async () => {
    const res = await app.request('/api/identity/mirror/lens/street/exemplars');
    expect(res.status).toBe(200);
    const body = await json<{
      total: number;
      items: { image_key: string; percentile: number; purity: number; filename: string }[];
    }>(res);

    expect(body.total).toBe(3);
    expect(body.items.map((i) => i.image_key)).toEqual(['pure', 'mixed', 'weak']);
    // 75, not 100: `pure` and `mixed` tie at the top of a three-image population, so
    // midrank averages the two ranks they span — (2.5 - 1) / 2 — and reports it as
    // points to one decimal. A shared top is not a clean sweep.
    expect(body.items[0]!.percentile).toBe(75);
    // Purity separates the tie: `pure` leads its own next-best lens by 75 points,
    // `mixed` trails its own by 25.
    expect(body.items[0]!.purity).toBe(75);
    expect(body.items[1]!.purity).toBe(-25);
    expect(body.items[0]!.filename).toBe('pure.jpg');
  });

  it('paginates without changing the total', async () => {
    const body = await json<{ total: number; items: { image_key: string }[] }>(
      await app.request('/api/identity/mirror/lens/street/exemplars?limit=1&offset=1'),
    );
    expect(body.total).toBe(3);
    expect(body.items.map((i) => i.image_key)).toEqual(['mixed']);
  });

  it('400s on an unknown or inactive slug', async () => {
    fx.addPerspectives({ slug: 'retired', active: false });
    for (const slug of ['nope', 'retired']) {
      const res = await app.request(`/api/identity/mirror/lens/${slug}/exemplars`);
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({
        error: `unknown or inactive perspective slug: ${slug}`,
      });
    }
  });
});

describe('GET /api/identity/suggestions', () => {
  it('excludes posted images and explains why each one is suggested', async () => {
    fx.addImage({ key: 'unposted-top', filename: 'a.jpg' });
    fx.addImage({ key: 'posted', instagram_posted: true });
    fx.addPerspectives({ slug: 'street', display_name: 'Street' });
    fx.addScores(
      { image_key: 'unposted-top', perspective_slug: 'street', score: 9 },
      { image_key: 'posted', perspective_slug: 'street', score: 10 },
    );

    const res = await app.request('/api/identity/suggestions');
    expect(res.status).toBe(200);
    const body = await json<{
      total: number;
      candidates: {
        image_key: string;
        peak_perspective_display_name: string;
        is_signature: boolean;
        reasons: string[];
        reason_codes: string[];
      }[];
      empty_state: string | null;
    }>(res);

    expect(body.total).toBe(1);
    expect(body.candidates[0]!.image_key).toBe('unposted-top');
    expect(body.candidates[0]!.peak_perspective_display_name).toBe('Street');
    expect(body.candidates[0]!.reason_codes).toContain('high_score_unposted');
    expect(body.candidates[0]!.reasons.some((r) => r.includes('Peak lens is Street'))).toBe(true);
    expect(body.empty_state).toBeNull();
  });

  it('falls back to eligible_unposted below the p90 threshold', async () => {
    fx.addPerspectives({ slug: 'street' });
    // Twelve unposted candidates with distinct scores, so p90 sits near the top and
    // most rows fall below it.
    for (let i = 0; i < 12; i += 1) {
      const key = `img-${String(i).padStart(2, '0')}`;
      fx.addImages(key);
      fx.addScores({ image_key: key, perspective_slug: 'street', score: (i % 10) + 1 });
    }
    const body = await json<{
      candidates: { reason_codes: string[] }[];
    }>(await app.request('/api/identity/suggestions?limit=12'));

    const codes = body.candidates.map((c) => c.reason_codes.join(','));
    expect(codes.some((c) => c.includes('high_score_unposted'))).toBe(true);
    expect(codes.some((c) => c === 'eligible_unposted')).toBe(true);
  });

  it('reports an empty state when nothing qualifies', async () => {
    fx.addImage({ key: 'posted', instagram_posted: true });
    fx.addPerspectives({ slug: 'street' });
    fx.addScores({ image_key: 'posted', perspective_slug: 'street', score: 9 });

    const body = await json<{ candidates: unknown[]; total: number; empty_state: string | null }>(
      await app.request('/api/identity/suggestions'),
    );
    expect(body.candidates).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.empty_state).toBe(
      'No unposted catalog images meet perspective coverage with current scores.',
    );
  });

  it('400s on a bad sort_by_date', async () => {
    const res = await app.request('/api/identity/suggestions?sort_by_date=sideways');
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'sort_by_date must be newest or oldest' });
  });
});

describe('condemned frames and identity', () => {
  it('removes a flagged frame from every identity endpoint', async () => {
    fx.addImages('good', 'condemned');
    fx.addPerspectives({ slug: 'street' });
    fx.addScores(
      { image_key: 'good', perspective_slug: 'street', score: 5 },
      { image_key: 'condemned', perspective_slug: 'street', score: 10 },
    );
    fx.addFrameSubstance('condemned', 'void');

    const best = await json<BestPhotos>(await app.request('/api/identity/best-photos'));
    // The highest-scoring image is a void frame, so it must not lead the ranking.
    expect(best.items.map((i) => i.image_key)).toEqual(['good']);

    const suggestions = await json<{ candidates: { image_key: string }[] }>(
      await app.request('/api/identity/suggestions'),
    );
    expect(suggestions.candidates.map((c) => c.image_key)).toEqual(['good']);
  });

  it('restores it once the user overrides', async () => {
    fx.addImages('good', 'condemned');
    fx.addPerspectives({ slug: 'street' });
    fx.addScores(
      { image_key: 'good', perspective_slug: 'street', score: 5 },
      { image_key: 'condemned', perspective_slug: 'street', score: 10 },
    );
    fx.addFrameSubstance('condemned', 'void');
    fx.addFrameSubstanceOverride('condemned');

    const best = await json<BestPhotos>(await app.request('/api/identity/best-photos'));
    expect(best.items.map((i) => i.image_key)).toEqual(['condemned', 'good']);
  });
});
