/**
 * Mirror signature and exemplars from within-perspective percentile ranks.
 *
 * One subtlety that must not be tidied away: the Mirror's scan cells hold **raw**
 * percentiles, while `percentiles.ts` rounds its cells to six decimals. The Mirror
 * ranks and takes argmax on full precision — rounding first would create ties that
 * suppress votes — and only rounds on the way out.
 */
import type { Db } from '../db/connection.js';
import { tokenizeRationale, truncateRationale } from './aggregates.js';
import { round6 } from './percentiles.js';
import { buildCatalogScoreIndex, type CatalogScoreCell, type CatalogScoreIndex } from './score-index.js';
import { imageMetaMap, stackFieldsForImageKeys, stackNonRepresentativeKeys } from './ranking.js';
import {
  computeSignatureStats,
  CROWN_ALPHA,
  LOW_COVERAGE_THRESHOLD,
  MIN_VOTING_LENSES,
  round1,
  round4,
  type SignatureStat,
} from './signature.js';

export const EXEMPLAR_INITIAL_LIMIT = 24;
export const EXEMPLAR_PAGE_SIZE = 12;
export const DESCRIPTOR_MIN_COUNT = 5;
export const DESCRIPTOR_LIMIT = 15;

/** How the strength of a lens is described to the user. */
function strengthLabel(args: {
  zScore: number;
  crowned: boolean;
  leadingNotDistinctive: boolean;
}): string {
  if (args.leadingNotDistinctive) return 'Leading, but not strongly distinctive';
  if (args.zScore >= 6) return 'A defining strength';
  if (args.zScore >= 3) return 'A clear strength';
  if (args.crowned) return 'A strength';
  return 'Leading, but not strongly distinctive';
}

export interface MirrorDescriptor {
  token: string;
  log_odds: number;
  count: number;
}

export interface TokenCounts {
  counts: Map<string, number>;
  total: number;
}

/** Tokenize and count a body of rationale text. */
export function countTokens(texts: readonly string[]): TokenCounts {
  const counts = new Map<string, number>();
  let total = 0;
  for (const text of texts) {
    for (const token of tokenizeRationale(text)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
      total += 1;
    }
  }
  return { counts, total };
}

/**
 * Words this lens's rationales use far more than the corpus does.
 *
 * Log-odds against the whole rationale corpus, not raw frequency: the point is what
 * makes the lens *distinctive*, and raw counts would just surface whichever words
 * the model says most often everywhere. Unseen corpus tokens are floored at half a
 * count so the ratio stays finite.
 *
 * The corpus may be passed pre-counted; `buildMirror` shares one count across sections.
 */
export function distinctiveDescriptors(
  lensRationales: readonly string[],
  corpus: readonly string[] | TokenCounts,
  opts: { minCount?: number; limit?: number } = {},
): MirrorDescriptor[] {
  const minCount = opts.minCount ?? DESCRIPTOR_MIN_COUNT;
  const limit = opts.limit ?? DESCRIPTOR_LIMIT;

  const lens = countTokens(lensRationales);
  const corpusCounted = Array.isArray(corpus) ? countTokens(corpus) : (corpus as TokenCounts);
  const lensTokens = lens.counts;
  const corpusTokens = corpusCounted.counts;
  const lensTotal = lens.total || 1;
  const corpusTotal = corpusCounted.total || 1;

  const scored: [string, number, number][] = [];
  for (const [token, lensCount] of lensTokens) {
    if (lensCount < minCount) continue;
    const corpusCount = corpusTokens.get(token) ?? 0;
    const pLens = lensCount / lensTotal;
    const pCorpus = Math.max(corpusCount, 0.5) / corpusTotal;
    if (pLens <= 0) continue;
    scored.push([token, Math.log(pLens / pCorpus), lensCount]);
  }

  // Highest log-odds first, then the more frequent token, then alphabetical.
  scored.sort((a, b) => b[1] - a[1] || b[2] - a[2] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return scored.slice(0, limit).map(([token, logOdds, c]) => ({
    token,
    log_odds: round4(logOdds),
    count: c,
  }));
}

/**
 * How far this lens's percentile leads the image's next-strongest lens, in points.
 *
 * Purity is a *separation*, not a level. An image scored on only this
 * lens has nothing to separate from, so its purity is 0 — reporting the raw
 * percentile instead would let single-lens images out-rank genuinely distinctive
 * multi-lens ones in the exemplar tiebreak.
 */
export function purity(lensPercentile: number, otherPercentiles: readonly number[]): number {
  if (otherPercentiles.length === 0) return 0;
  return round1((lensPercentile - Math.max(...otherPercentiles)) * 100);
}

interface ExemplarCandidate {
  image_key: string;
  score: number;
  percentile: number;
  purity: number;
  rationale: string;
  per_perspective: CatalogScoreCell[];
}

function lensExemplarCandidates(
  slug: string,
  byImage: Map<string, CatalogScoreCell[]>,
): ExemplarCandidate[] {
  const candidates: ExemplarCandidate[] = [];
  for (const [imageKey, perspectives] of byImage) {
    const match = perspectives.find((p) => p.perspective_slug === slug);
    if (match === undefined) continue;
    const others = perspectives
      .filter((p) => p.perspective_slug !== slug)
      .map((p) => p.percentile);
    candidates.push({
      image_key: imageKey,
      score: match.score,
      percentile: match.percentile,
      purity: purity(match.percentile, others),
      rationale: match.rationale || '',
      per_perspective: perspectives,
    });
  }
  return candidates;
}

export interface MirrorExemplar {
  image_key: string;
  score: number;
  percentile: number;
  purity: number;
  rationale_preview: string;
  per_perspective: {
    perspective_slug: string;
    display_name: string;
    score: number;
    percentile: number;
  }[];
  filename: string;
  date_taken: string;
  rating: number;
  instagram_posted: boolean;
  stack_id: number | null;
  stack_size: number | null;
}

function formatExemplarRows(db: Db, rows: readonly ExemplarCandidate[]): MirrorExemplar[] {
  if (rows.length === 0) return [];
  const keys = rows.map((row) => String(row.image_key));
  const metaMap = imageMetaMap(db, keys);
  const stackByKey = stackFieldsForImageKeys(db, keys);

  return rows.map((row) => {
    const imageKey = String(row.image_key);
    const perOut = [...row.per_perspective]
      .sort((a, b) =>
        a.perspective_slug < b.perspective_slug ? -1 : a.perspective_slug > b.perspective_slug ? 1 : 0,
      )
      .map((p) => ({
        perspective_slug: p.perspective_slug,
        display_name: p.display_name,
        score: p.score,
        percentile: round6(p.percentile),
      }));
    const im = metaMap.get(imageKey);
    const stack = stackByKey.get(imageKey);
    return {
      image_key: imageKey,
      score: row.score,
      // Exemplar percentiles are reported as points to one decimal, unlike the
      // per_perspective cells above, which stay fractions to six.
      percentile: round1(row.percentile * 100),
      purity: row.purity,
      rationale_preview: truncateRationale(row.rationale),
      per_perspective: perOut,
      filename: im?.filename || '',
      date_taken: im?.date_taken || '',
      rating: Math.trunc(im?.rating || 0),
      instagram_posted: Boolean(im?.instagram_posted),
      stack_id: stack?.stack_id ?? null,
      stack_size: stack?.stack_member_count ?? null,
    };
  });
}

/**
 * Ranked exemplars for one lens, with burst stacks collapsed to representatives.
 *
 * `limit: 0` returns the total only — that is how the "other lenses" list gets its
 * counts without formatting rows nobody will see.
 */
export function buildLensExemplars(
  db: Db,
  slug: string,
  opts: {
    offset?: number;
    limit?: number;
    scan?: CatalogScoreIndex;
    dropKeys?: Set<string>;
  } = {},
): { items: MirrorExemplar[]; total: number } {
  const scan = opts.scan ?? buildCatalogScoreIndex(db);
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? EXEMPLAR_INITIAL_LIMIT;

  if (!scan.activeSlugs.includes(slug)) {
    throw new RangeError(`unknown or inactive perspective slug: ${slug}`);
  }

  let candidates = lensExemplarCandidates(slug, scan.byImage);
  const dropKeys =
    opts.dropKeys ??
    stackNonRepresentativeKeys(db, candidates.map((c) => String(c.image_key)));
  candidates = candidates.filter((c) => !dropKeys.has(String(c.image_key)));

  candidates.sort(
    (a, b) =>
      b.percentile - a.percentile ||
      b.purity - a.purity ||
      (a.image_key < b.image_key ? -1 : a.image_key > b.image_key ? 1 : 0),
  );

  const total = candidates.length;
  const page = limit > 0 ? candidates.slice(offset, offset + limit) : [];
  return { items: formatExemplarRows(db, page), total };
}

export interface MirrorSection {
  perspective_slug: string;
  display_name: string;
  strength_label: string;
  leading_not_distinctive: boolean;
  crowned: boolean;
  win_rate: number;
  chance_rate: number;
  z_score: number;
  votes: number;
  photos_on: number;
  coverage: number;
  low_coverage: boolean;
  descriptors: MirrorDescriptor[];
  exemplars: MirrorExemplar[];
  exemplar_total: number;
}

export interface MirrorOtherLens {
  perspective_slug: string;
  display_name: string;
  strength_label: string;
  win_rate: number;
  chance_rate: number;
  z_score: number;
  coverage: number;
  low_coverage: boolean;
  votes: number;
  photos_on: number;
  exemplar_total: number;
}

export interface MirrorPayload {
  population: number;
  sections: MirrorSection[];
  other_lenses: MirrorOtherLens[];
  meta: Record<string, unknown>;
}

/** Catalog Mirror: crowned signature lenses, descriptors and exemplar rails. */
export function buildMirror(db: Db): MirrorPayload {
  const scan = buildCatalogScoreIndex(db);
  const { stats: signatureStats, votingPopulation } = computeSignatureStats(scan);

  // Counted once and shared by every section; see `distinctiveDescriptors`.
  const corpusCounts = countTokens(scan.corpusRationales);

  // Computed once over every scanned key and threaded into each per-lens call;
  // recomputing per lens would re-query the stack tables for every section.
  const dropKeys = stackNonRepresentativeKeys(db, [...scan.byImage.keys()]);

  const crownedStats = signatureStats
    .filter((s) => s.crowned)
    .sort(
      (a, b) =>
        b.z_score - a.z_score ||
        (a.perspective_slug < b.perspective_slug ? -1 : a.perspective_slug > b.perspective_slug ? 1 : 0),
    );

  // With nothing crowned, show the strongest lens anyway rather than an empty page,
  // but label it honestly as leading-not-distinctive.
  let fallback = false;
  let sectionStats: SignatureStat[] = crownedStats;
  if (sectionStats.length === 0 && signatureStats.length > 0) {
    fallback = true;
    sectionStats = [
      signatureStats.reduce((best, s) =>
        s.votes > best.votes || (s.votes === best.votes && s.z_score > best.z_score) ? s : best,
      ),
    ];
  }

  const sectionSlugs = new Set(sectionStats.map((s) => s.perspective_slug));
  const sections: MirrorSection[] = sectionStats.map((stat) => {
    const exemplarPayload = buildLensExemplars(db, stat.perspective_slug, {
      offset: 0,
      limit: EXEMPLAR_INITIAL_LIMIT,
      scan,
      dropKeys,
    });
    return {
      perspective_slug: stat.perspective_slug,
      display_name: stat.display_name,
      strength_label: strengthLabel({
        zScore: stat.z_score,
        crowned: stat.crowned,
        leadingNotDistinctive: fallback,
      }),
      leading_not_distinctive: fallback,
      crowned: stat.crowned,
      win_rate: stat.win_rate,
      chance_rate: stat.chance_rate,
      z_score: stat.z_score,
      votes: stat.votes,
      photos_on: stat.photos_on,
      coverage: stat.coverage,
      low_coverage: stat.low_coverage,
      descriptors: distinctiveDescriptors(
        scan.rationalesBySlug.get(stat.perspective_slug) ?? [],
        corpusCounts,
      ),
      exemplars: exemplarPayload.items,
      exemplar_total: exemplarPayload.total,
    };
  });

  const otherLenses: MirrorOtherLens[] = signatureStats
    .filter((stat) => !sectionSlugs.has(stat.perspective_slug))
    .map((stat) => ({
      perspective_slug: stat.perspective_slug,
      display_name: stat.display_name,
      strength_label: strengthLabel({
        zScore: stat.z_score,
        crowned: stat.crowned,
        leadingNotDistinctive: false,
      }),
      win_rate: stat.win_rate,
      chance_rate: stat.chance_rate,
      z_score: stat.z_score,
      coverage: stat.coverage,
      low_coverage: stat.low_coverage,
      votes: stat.votes,
      photos_on: stat.photos_on,
      exemplar_total: buildLensExemplars(db, stat.perspective_slug, {
        offset: 0,
        limit: 0,
        scan,
        dropKeys,
      }).total,
    }));

  return {
    population: votingPopulation,
    sections,
    other_lenses: otherLenses,
    meta: {
      active_perspectives: scan.activeSlugs,
      total_catalog_images: scan.totalCatalog,
      voting_rule:
        'strict argmax on within-perspective percentile among images scored on ' +
        `>= ${MIN_VOTING_LENSES} lenses`,
      crowning_rule: `one-sided binomial test p < ${CROWN_ALPHA} on coverage-corrected win rate`,
      low_coverage_threshold: LOW_COVERAGE_THRESHOLD,
      exemplar_initial_limit: EXEMPLAR_INITIAL_LIMIT,
      exemplar_page_size: EXEMPLAR_PAGE_SIZE,
      descriptor_min_count: DESCRIPTOR_MIN_COUNT,
      scores_are_advisory:
        'Rankings reflect model/rubric versions at time of scoring (is_current rows).',
      fallback_active: fallback,
    },
  };
}
