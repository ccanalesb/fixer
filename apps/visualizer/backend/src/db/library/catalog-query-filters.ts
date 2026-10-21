/**
 * Shared WHERE-clause fragments for catalog image listing queries.
 */
import { buildDescriptionFtsQuery, DESCRIPTION_FTS_KEY_SUBQUERY } from './descriptions.js';
import { flaggedExistsSql } from './frame-substance-sql.js';

/** SQLite binding values these queries produce. */
export type Binding = string | number | null;

/**
 * Trim elements and drop blanks; `null` means "apply no filter".
 *
 * A list of only whitespace is treated as an empty list, i.e. no filter — not as a
 * filter that matches nothing.
 */
export function nonEmptyStrListForJsonArrayFilter(
  values: readonly string[] | null | undefined,
): string[] | null {
  if (values === null || values === undefined || values.length === 0) return null;
  const out = values
    .filter((v) => v !== null && v !== undefined)
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0);
  return out.length > 0 ? out : null;
}

/** Passed culling or sent-by-hand (Images → Cull catalog). */
const CULL_CATALOG_SQL =
  "EXISTS (SELECT 1 FROM cull_verdicts cv WHERE cv.image_key = i.key AND (cv.verdict = 'passed' OR cv.sent_by_hand = 1 OR EXISTS (SELECT 1 FROM cull_user_actions ua WHERE ua.image_key = cv.image_key AND ua.action = 'sent_by_hand')))";

export interface CatalogImageFilters {
  cullCatalog?: boolean | null;
  posted?: boolean | null;
  month?: string | null;
  keyword?: string | null;
  minRating?: number | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  colorLabel?: string | null;
  analyzed?: boolean | null;
  minScore?: number | null;
  minScoreOnActive?: number | null;
  burstStack?: boolean | null;
  flagged?: boolean | null;
  descriptionSearch?: string | null;
  dominantColors?: readonly string[] | null;
  moodTags?: readonly string[] | null;
  hasRepetition?: boolean | null;
}

/**
 * Append the shared catalog-list AND-clauses (including the stack collapse) to
 * `clauses` / `bindings`.
 *
 * Used by both `queryCatalogImages` and `filterOrderKeysInCatalog`, so the visual
 * similarity post-filter cannot drift from the catalog grid it filters against. The
 * caller seeds `clauses` (e.g. `['1=1']` or `i.key IN (...)`).
 *
 * Clause order matters: it is the order the bindings are pushed in, and these are
 * positional parameters.
 */
export function appendQueryCatalogImageFilters(
  clauses: string[],
  bindings: Binding[],
  f: CatalogImageFilters = {},
): void {
  if (f.cullCatalog === true) clauses.push(CULL_CATALOG_SQL);

  if (f.posted === true) clauses.push('i.instagram_posted = 1');
  else if (f.posted === false) clauses.push('i.instagram_posted = 0');

  // Malformed `month` values are ignored rather than rejected.
  if (f.month && f.month.length === 6 && /^[0-9]+$/.test(f.month)) {
    clauses.push("strftime('%Y%m', i.date_taken) = ?");
    bindings.push(f.month);
  }

  const kw = (f.keyword ?? '').trim();
  if (kw) {
    const pattern = `%${kw}%`;
    clauses.push(
      '(' +
        'i.keywords LIKE ? COLLATE NOCASE OR ' +
        'i.filename LIKE ? COLLATE NOCASE OR ' +
        'i.title LIKE ? COLLATE NOCASE OR ' +
        'i.description LIKE ? COLLATE NOCASE' +
        ')',
    );
    bindings.push(pattern, pattern, pattern, pattern);
  }

  if (f.minRating !== null && f.minRating !== undefined) {
    clauses.push('i.rating >= ?');
    bindings.push(f.minRating);
  }

  if (f.dateFrom) {
    clauses.push('i.date_taken >= ?');
    bindings.push(f.dateFrom);
  }

  if (f.dateTo) {
    clauses.push('i.date_taken <= ?');
    bindings.push(f.dateTo);
  }

  const cl = (f.colorLabel ?? '').trim();
  if (cl) {
    clauses.push('LOWER(i.color_label) = LOWER(?)');
    bindings.push(cl);
  }

  if (f.analyzed === true) clauses.push('d.image_key IS NOT NULL');
  else if (f.analyzed === false) clauses.push('d.image_key IS NULL');

  if (f.minScore !== null && f.minScore !== undefined) {
    clauses.push('s.score IS NOT NULL AND s.score >= ?');
    bindings.push(f.minScore);
  }

  if (f.minScoreOnActive !== null && f.minScoreOnActive !== undefined) {
    if (!(f.minScoreOnActive >= 1 && f.minScoreOnActive <= 10)) {
      throw new RangeError('min_score_on_active must be between 1 and 10');
    }
    clauses.push(
      'EXISTS (' +
        'SELECT 1 FROM image_scores s_active ' +
        'INNER JOIN perspectives p_active ' +
        '  ON p_active.slug = s_active.perspective_slug AND p_active.active = 1 ' +
        'WHERE s_active.image_key = i.key ' +
        "  AND s_active.image_type = 'catalog' " +
        '  AND s_active.is_current = 1 ' +
        '  AND s_active.score >= ?' +
        ')',
    );
    bindings.push(f.minScoreOnActive);
  }

  if (f.burstStack === true) {
    clauses.push(
      'st.stack_id IS NOT NULL AND st.stack_size > 1 AND i.key = st.representative_key',
    );
  } else if (f.burstStack === false) {
    clauses.push('(st.stack_id IS NULL OR st.stack_size <= 1 OR i.key != st.representative_key)');
  }

  if (f.flagged === true) clauses.push(flaggedExistsSql('i.key'));
  else if (f.flagged === false) clauses.push(`NOT ${flaggedExistsSql('i.key')}`);

  if ((f.descriptionSearch ?? '').trim()) {
    const { match, error } = buildDescriptionFtsQuery(f.descriptionSearch);
    if (error) throw new RangeError(error);
    if (match !== null) {
      clauses.push(`i.key IN (${DESCRIPTION_FTS_KEY_SUBQUERY})`);
      bindings.push(match);
    }
  }

  const dcTokens = nonEmptyStrListForJsonArrayFilter(f.dominantColors);
  if (dcTokens) {
    const ph = dcTokens.map(() => '?').join(',');
    clauses.push(
      '(' +
        "d.dominant_colors IS NOT NULL AND json_type(d.dominant_colors) = 'array' " +
        'AND EXISTS (' +
        'SELECT 1 FROM json_each(d.dominant_colors) AS jde ' +
        `WHERE jde.value IN (${ph})` +
        ')' +
        ')',
    );
    bindings.push(...dcTokens);
  }

  if (f.hasRepetition === true) clauses.push('d.has_repetition = 1');
  else if (f.hasRepetition === false) {
    clauses.push('(d.has_repetition IS NULL OR d.has_repetition = 0)');
  }

  const mtTokens = nonEmptyStrListForJsonArrayFilter(f.moodTags);
  if (mtTokens) {
    const ph = mtTokens.map(() => '?').join(',');
    clauses.push(
      '(' +
        "d.mood_tags IS NOT NULL AND json_type(d.mood_tags) = 'array' " +
        'AND EXISTS (' +
        'SELECT 1 FROM json_each(d.mood_tags) AS jme ' +
        `WHERE jme.value IN (${ph})` +
        ')' +
        ')',
    );
    bindings.push(...mtTokens);
  }

  // Primary-grid stack collapse: non-representative members are hidden. Appended last.
  clauses.push('(m_st.image_key IS NULL OR i.key = st.representative_key)');
}
