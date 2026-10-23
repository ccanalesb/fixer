/**
 * Within-perspective percentile ranks over the eligible identity population.
 *
 * A raw 1–10 score is not comparable across perspectives: one lens may hand out
 * 8s freely while another rarely exceeds 5. Ranking on the *percentile within each
 * perspective* is what makes "this photo's strongest lens" mean something.
 */
import type { Db } from '../db/connection.js';
import { defaultMinPerspectives, SCORES_BASE_SQL, truncateRationale, type ScoreRow } from './aggregates.js';
import type { CatalogScoreIndex } from './score-index.js';

/**
 * Round to 6 decimals.
 *
 * Half-to-even vs half-away-from-zero can differ at the seventh decimal, but fixture
 * tests verify every published percentile.
 */
export function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Map each distinct raw score to a percentile rank in [0, 1], with midrank ties.
 *
 * Midrank (rather than "fraction below") means a tied group all get the average of
 * the ranks they span, so a lens that gives half the catalog a 7 does not make
 * every one of those photos look either top or bottom of the pile.
 */
export function midrankPercentileRanks(scores: readonly number[]): Map<number, number> {
  const n = scores.length;
  if (n === 0) return new Map();
  if (n === 1) return new Map([[scores[0]!, 1]]);

  const counts = new Map<number, number>();
  for (const s of scores) counts.set(s, (counts.get(s) ?? 0) + 1);

  const out = new Map<number, number>();
  let below = 0;
  // Numeric sort: these are score values, and the default string sort would put
  // 10 before 2.
  for (const score of [...counts.keys()].sort((a, b) => a - b)) {
    const tied = counts.get(score)!;
    // 1-based average rank across the tied group.
    const midrank = below + (tied + 1) / 2;
    out.set(score, (midrank - 1) / (n - 1));
    below += tied;
  }
  return out;
}

/**
 * Compose the `(image_key, perspective_slug)` lookup key.
 *
 * The separator is an explicit NUL escape rather than a literal character: no image
 * key or slug can contain one, so the composite key is unambiguous, and writing it
 * as `\u0000` keeps it visible in the source. Exported so every caller composes the
 * key through this one function — building it inline in a second module is how a
 * mismatched separator silently turns every percentile into NaN.
 */
export function cellKey(imageKey: string, slug: string): string {
  return `${imageKey}\u0000${slug}`;
}

/**
 * Percentile rank in [0, 1] for every `(image_key, perspective_slug)` score cell.
 *
 * Computed once over the whole eligible population, because a percentile is
 * meaningless relative to a page of results.
 */
export function computeWithinPerspectivePercentileLookup(
  db: Db,
  preloadedRows?: readonly ScoreRow[],
): Map<string, number> {
  // Callers that already hold the score rows pass them in; on this catalog the
  // query returns 146,983 rows, so reading it twice is not free.
  const rows = preloadedRows ?? (db.prepare(SCORES_BASE_SQL).all() as ScoreRow[]);

  const scoresByPerspective = new Map<string, number[]>();
  const cells: [string, string, number][] = [];
  for (const r of rows) {
    const imageKey = String(r.image_key);
    const slug = String(r.perspective_slug);
    const score = Math.trunc(r.score);
    const list = scoresByPerspective.get(slug);
    if (list) list.push(score);
    else scoresByPerspective.set(slug, [score]);
    cells.push([imageKey, slug, score]);
  }

  const rankBySlug = new Map<string, Map<number, number>>();
  for (const [slug, scores] of scoresByPerspective) {
    rankBySlug.set(slug, midrankPercentileRanks(scores));
  }

  const lookup = new Map<string, number>();
  for (const [imageKey, slug, score] of cells) {
    lookup.set(cellKey(imageKey, slug), rankBySlug.get(slug)!.get(score)!);
  }
  return lookup;
}

export const CORROBORATION_RULE =
  'If any lens scored 1, rank on second-highest percentile instead of peak.';

export interface PerspectiveCell {
  perspective_slug: string;
  display_name: string;
  score: number;
  percentile: number;
  rationale: string;
  model_used: string;
  prompt_version: string;
  scored_at: string;
}

export interface CorroborationFields {
  ranking_percentile: number;
  corroboration_revoked: boolean;
  corroboration_revoked_by: string;
}

/**
 * The corroboration veto: one flattering lens cannot crown a photo.
 *
 * If any lens scored the image a 1, ranking falls back from the peak percentile to
 * the *second*-highest. The intent is that a photo another lens considers a total
 * failure should not top the list on one enthusiastic reading.
 */
export function corroborationRankingFields(
  perspectives: readonly PerspectiveCell[],
  peak: number,
): CorroborationFields {
  const unrevoked = (): CorroborationFields => ({
    ranking_percentile: round6(peak),
    corroboration_revoked: false,
    corroboration_revoked_by: '',
  });

  if (perspectives.length === 0) return unrevoked();

  const minScore = Math.min(...perspectives.map((p) => Math.trunc(p.score)));
  if (minScore > 1) return unrevoked();

  const sortedPercentiles = perspectives.map((p) => Number(p.percentile)).sort((a, b) => b - a);
  // A single-lens image that scored 1 has no second opinion to fall back to, so it
  // ranks at the bottom rather than on its own peak.
  const ranking = sortedPercentiles.length >= 2 ? sortedPercentiles[1]! : 0;

  // Lowest score first, then slug, so the reported culprit is deterministic.
  const revoking = perspectives
    .filter((p) => Math.trunc(p.score) <= 1)
    .sort((a, b) => {
      const byScore = Math.trunc(a.score) - Math.trunc(b.score);
      if (byScore !== 0) return byScore;
      return a.perspective_slug < b.perspective_slug ? -1 : a.perspective_slug > b.perspective_slug ? 1 : 0;
    });

  return {
    ranking_percentile: round6(ranking),
    corroboration_revoked: true,
    corroboration_revoked_by: revoking.length > 0 ? String(revoking[0]!.perspective_slug) : '',
  };
}

export interface PeakPercentileItem extends CorroborationFields {
  image_key: string;
  peak_percentile: number;
  perspectives_covered: number;
  eligible: boolean;
  per_perspective: {
    perspective_slug: string;
    display_name: string;
    score: number;
    percentile: number;
    prompt_version: string;
    model_used: string;
    scored_at: string;
    rationale_preview: string;
  }[];
}

export interface PeakPercentileMeta {
  active_perspectives: string[];
  weighting: string;
  ranking_key: string;
  corroboration_rule: string;
  min_perspectives_used: number;
  coverage_rule: string;
  total_catalog_images: number;
  eligible_count: number;
  scored_any_count: number;
  coverage_note?: string;
}

/**
 * Per-image peak within-perspective percentile plus per-perspective detail.
 *
 * Takes the index rather than a database: everything this needs — the live
 * slugs, the catalog size, the percentile of every cell, the cells grouped by
 * image — is already in it, and building a second copy meant a second full read
 * of a 146,983-row query.
 *
 * The percentiles are rounded here and nowhere else. The index carries them raw
 * because the Mirror ranks on full precision, so this is the one place that
 * decides what six decimals means for the best-photos view.
 */
export function computeImagePeakPercentileScores(
  index: CatalogScoreIndex,
  opts: {
    minPerspectives?: number | null;
    includeIneligible?: boolean;
  } = {},
): { items: PeakPercentileItem[]; meta: PeakPercentileMeta } {
  const includeIneligible = opts.includeIneligible ?? true;
  const { activeSlugs, totalCatalog } = index;
  const activeCount = activeSlugs.length;
  const minUsed =
    opts.minPerspectives !== null && opts.minPerspectives !== undefined
      ? Math.trunc(opts.minPerspectives)
      : defaultMinPerspectives(activeCount);

  // Insertion order matters: it becomes the pre-sort order of `items`, and the
  // callers' sorts are stable, so it is the final tiebreaker.
  const byKey = new Map<string, PerspectiveCell[]>();
  for (const [imageKey, cells] of index.byImage) {
    byKey.set(
      imageKey,
      cells.map((c) => ({ ...c, percentile: round6(c.percentile) })),
    );
  }

  const items: PeakPercentileItem[] = [];
  let eligibleCount = 0;
  for (const [imageKey, perspectives] of byKey) {
    const n = perspectives.length;
    const peak = n > 0 ? Math.max(...perspectives.map((p) => p.percentile)) : 0;
    const vetoFields = corroborationRankingFields(perspectives, peak);
    const eligible = n >= minUsed;
    if (eligible) eligibleCount += 1;

    const perOut = [...perspectives]
      .sort((a, b) =>
        a.perspective_slug < b.perspective_slug ? -1 : a.perspective_slug > b.perspective_slug ? 1 : 0,
      )
      .map((p) => ({
        perspective_slug: p.perspective_slug,
        display_name: p.display_name,
        score: p.score,
        percentile: p.percentile,
        prompt_version: p.prompt_version,
        model_used: p.model_used,
        scored_at: p.scored_at,
        rationale_preview: truncateRationale(p.rationale),
      }));

    if (includeIneligible || eligible) {
      items.push({
        image_key: imageKey,
        peak_percentile: round6(peak),
        ...vetoFields,
        perspectives_covered: n,
        eligible,
        per_perspective: perOut,
      });
    }
  }

  const meta: PeakPercentileMeta = {
    active_perspectives: activeSlugs,
    weighting: 'peak_within_perspective_percentile',
    ranking_key: 'ranking_percentile',
    corroboration_rule: CORROBORATION_RULE,
    min_perspectives_used: minUsed,
    coverage_rule: 'eligible when perspectives_covered >= min_perspectives (default 1)',
    total_catalog_images: totalCatalog,
    eligible_count: eligibleCount,
    scored_any_count: byKey.size,
  };
  if (eligibleCount === 0 && activeCount > 0) {
    meta.coverage_note =
      'No images meet the minimum perspective coverage for ranking; ' +
      'score at least one perspective per image.';
  }
  return { items, meta };
}
