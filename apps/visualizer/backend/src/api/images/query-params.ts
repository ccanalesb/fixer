/**
 * Query-string parsing for the catalog routes.
 *
 * Kept in one module because the catalog list and the visual-similarity endpoint
 * read *almost* the same filters, and the differences are deliberate rather than
 * accidental:
 *
 *   - the list supports `sort_by_score`, `sort_by_date`, `min_score_on_active`,
 *     `burst_stack` and `flagged`
 *   - similarity rejects both sort parameters outright (results are ordered by CLIP
 *     distance, so honouring a sort would silently discard the ranking) and instead
 *     supports `dominant_colors`, `mood_tags` and `has_repetition`
 *
 * `min_rating` silently becomes null when unparseable; `min_score` returns 400.
 */
import type { CatalogImageFilters } from '../../db/library/catalog-query.js';
import type { SortByDate, SortByScore } from '../../db/library/catalog-query.js';

/** A 400 the caller should return verbatim. */
export interface ParamError {
  error: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Any value other than `"true"` / `"false"` reads as "filter not applied".
 */
export function boolTriState(raw: string | undefined): boolean | null {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

/** An integer query param, or null when absent or unparseable. */
export function intOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) return null;
  return Number.parseInt(raw.trim(), 10);
}

/**
 * A 1–10 score bound that reports its own errors.
 *
 * Present-but-empty reads as absent; present-and-unparseable is a 400. `label`
 * appears in the message, which the frontend surfaces directly.
 */
function scoreBound(raw: string | undefined, label: string): Parsed<number | null> {
  if (raw === undefined) return { ok: true, value: null };
  if (raw.trim() === '') return { ok: true, value: null };
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) return { ok: false, error: `${label} must be an integer` };
  const n = Number.parseInt(raw.trim(), 10);
  if (n < 1 || n > 10) return { ok: false, error: `${label} must be between 1 and 10` };
  return { ok: true, value: n };
}

/** `description_search`, where a blank value means "no search" rather than "match nothing". */
function descriptionSearch(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (raw.trim() === '') return null;
  return raw.trim();
}

/** Trim and drop blanks from a repeated query parameter; `null` when nothing remains. */
function stringList(values: string[] | undefined): string[] | null {
  if (!values) return null;
  const out = values.map((v) => String(v).trim()).filter((v) => v.length > 0);
  return out.length > 0 ? out : null;
}

/** The subset of query readers both parsers need. */
interface QuerySource {
  query(name: string): string | undefined;
  queries(name: string): string[] | undefined;
}

/**
 * Filters shared by the list and similarity endpoints.
 *
 * `scorePerspective` is returned raw (trimmed) — existence has to be validated
 * against the database, which is the caller's job.
 */
function commonFilters(q: QuerySource): {
  filters: CatalogImageFilters;
  scorePerspectiveRaw: string;
} {
  return {
    filters: {
      posted: boolTriState(q.query('posted')),
      month: q.query('month') ?? null,
      keyword: (q.query('keyword') ?? '').trim() || null,
      minRating: intOrNull(q.query('min_rating')),
      dateFrom: (q.query('date_from') ?? '') || null,
      dateTo: (q.query('date_to') ?? '') || null,
      colorLabel: (q.query('color_label') ?? '').trim() || null,
      analyzed: boolTriState(q.query('analyzed')),
      descriptionSearch: descriptionSearch(q.query('description_search')),
    },
    scorePerspectiveRaw: (q.query('score_perspective') ?? '').trim(),
  };
}

export interface CatalogListParams {
  filters: CatalogImageFilters;
  scorePerspectiveRaw: string;
  sortByScore: SortByScore | null;
  sortByDate: SortByDate | null;
  limitRaw: string | undefined;
  offsetRaw: string | undefined;
}

/** Parse `GET /api/images/catalog` query parameters. */
export function parseCatalogListParams(q: QuerySource): Parsed<CatalogListParams> {
  const { filters, scorePerspectiveRaw } = commonFilters(q);

  const sortRaw = (q.query('sort_by_score') ?? '').trim().toLowerCase();
  let sortByScore: SortByScore | null = null;
  if (sortRaw) {
    if (sortRaw !== 'asc' && sortRaw !== 'desc') {
      return { ok: false, error: 'sort_by_score must be asc or desc' };
    }
    sortByScore = sortRaw;
  }

  const sortDateRaw = (q.query('sort_by_date') ?? '').trim().toLowerCase();
  let sortByDate: SortByDate | null = null;
  if (sortDateRaw) {
    if (sortDateRaw !== 'newest' && sortDateRaw !== 'oldest') {
      return { ok: false, error: 'sort_by_date must be newest or oldest' };
    }
    sortByDate = sortDateRaw;
  }

  const minScore = scoreBound(q.query('min_score'), 'min_score');
  if (!minScore.ok) return minScore;
  const minScoreOnActive = scoreBound(q.query('min_score_on_active'), 'min_score_on_active');
  if (!minScoreOnActive.ok) return minScoreOnActive;

  return {
    ok: true,
    value: {
      filters: {
        ...filters,
        cullCatalog: boolTriState(q.query('cull_catalog')),
        minScore: minScore.value,
        minScoreOnActive: minScoreOnActive.value,
        burstStack: boolTriState(q.query('burst_stack')),
        flagged: boolTriState(q.query('flagged')),
      },
      scorePerspectiveRaw,
      sortByScore,
      sortByDate,
      limitRaw: q.query('limit'),
      offsetRaw: q.query('offset'),
    },
  };
}

export interface CatalogSimilarParams {
  filters: CatalogImageFilters;
  scorePerspectiveRaw: string;
  limitRaw: string | undefined;
  offsetRaw: string | undefined;
}

/**
 * Parse `GET /api/images/catalog/{image_key}/similar` query parameters.
 *
 * Both sort parameters are rejected rather than ignored: results are ordered by
 * CLIP distance, and quietly re-sorting them would discard the ranking the endpoint
 * exists to produce.
 */
export function parseCatalogSimilarParams(q: QuerySource): Parsed<CatalogSimilarParams> {
  const { filters, scorePerspectiveRaw } = commonFilters(q);

  if ((q.query('sort_by_score') ?? '').trim()) {
    return {
      ok: false,
      error:
        'sort_by_score is not supported for visual similarity — results are ordered by CLIP distance',
    };
  }
  if ((q.query('sort_by_date') ?? '').trim()) {
    return {
      ok: false,
      error:
        'sort_by_date is not supported for visual similarity — results are ordered by CLIP distance',
    };
  }

  const minScore = scoreBound(q.query('min_score'), 'min_score');
  if (!minScore.ok) return minScore;

  // Unlike the list endpoint, an unrecognized `has_repetition` is a 400 here.
  const hasRepRaw = q.query('has_repetition');
  let hasRepetition: boolean | null = null;
  if (hasRepRaw !== undefined && hasRepRaw !== '') {
    const lowered = hasRepRaw.toLowerCase();
    if (['true', '1', 'yes'].includes(lowered)) hasRepetition = true;
    else if (['false', '0', 'no'].includes(lowered)) hasRepetition = false;
    else return { ok: false, error: 'has_repetition must be true or false' };
  }

  return {
    ok: true,
    value: {
      filters: {
        ...filters,
        minScore: minScore.value,
        dominantColors: stringList(q.queries('dominant_colors')),
        moodTags: stringList(q.queries('mood_tags')),
        hasRepetition: hasRepetition,
      },
      scorePerspectiveRaw,
      limitRaw: q.query('limit'),
      offsetRaw: q.query('offset'),
    },
  };
}
