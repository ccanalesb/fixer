/**
 * Per-image aggregate scores over active critique perspectives.
 */
import type { Db } from '../db/connection.js';
import { flaggedExistsSql } from '../db/library/frame-substance-sql.js';
import { EN_STOPWORDS } from '../constants/text.js';

/**
 * Current catalog scores on active perspectives only.
 *
 * Four conditions carry weight and none is incidental: `is_current = 1` keeps
 * superseded scores out, `image_type = 'catalog'` excludes the retired Instagram
 * scope (D-40), `not_attempted = 0` drops the excusable-dimension placeholders so
 * they cannot drag a mean down, and the frame-substance clause removes condemned
 * frames from identity entirely.
 */
export const SCORES_BASE_SQL = `
    SELECT
        s.image_key,
        s.image_type,
        s.perspective_slug,
        s.score,
        s.rationale,
        s.model_used,
        s.prompt_version,
        s.scored_at,
        p.display_name AS perspective_display_name
    FROM image_scores s
    INNER JOIN perspectives p
        ON p.slug = s.perspective_slug AND p.active = 1
    WHERE s.is_current = 1
        AND s.image_type = 'catalog'
        AND s.not_attempted = 0
        AND NOT ${flaggedExistsSql('s.image_key')}
`;

export const RATIONALE_PREVIEW_MAX = 240;

export interface IdentityPerPerspective {
  perspective_slug: string;
  display_name: string;
  score: number;
  prompt_version: string;
  model_used: string;
  scored_at: string;
  rationale_preview: string;
}

export interface IdentityAggregate {
  image_key: string;
  aggregate_score: number;
  perspectives_covered: number;
  eligible: boolean;
  per_perspective: IdentityPerPerspective[];
}

export function activePerspectiveSlugs(db: Db): string[] {
  const rows = db
    .prepare('SELECT slug FROM perspectives WHERE active = 1 ORDER BY slug ASC')
    .all() as { slug: string }[];
  return rows.map((r) => String(r.slug));
}

/**
 * Minimum perspectives required for eligibility.
 *
 * Currently 1 regardless of active count. Kept as a function because the
 * threshold is the knob most likely to change.
 */
export function defaultMinPerspectives(_activeCount: number): number {
  return 1;
}

/**
 * Round to 4 decimals.
 *
 * Only ever rounds a mean of integer scores; repeating decimals never land exactly
 * on a half at the fourth decimal.
 */
export function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/**
 * Trim a rationale to a preview length, appending an ellipsis when cut.
 *
 * Slices by code point so an emoji cannot be cut through a surrogate pair.
 */
export function truncateRationale(
  text: string | null | undefined,
  maxChars = RATIONALE_PREVIEW_MAX,
): string {
  if (!text) return '';
  const t = text.trim();
  const chars = [...t];
  if (chars.length <= maxChars) return t;
  return `${chars.slice(0, maxChars - 1).join('').replace(/\s+$/u, '')}…`;
}

/** One row of `SCORES_BASE_SQL`. */
export interface ScoreRow {
  image_key: string;
  perspective_slug: string;
  perspective_display_name: string | null;
  score: number;
  rationale: string | null;
  model_used: string | null;
  prompt_version: string | null;
  scored_at: string | null;
}

/**
 * Lowercase word tokens of length >= 3, minimal English stopwords dropped (D-43).
 *
 * Uses Unicode property escapes because JavaScript's `\w` is ASCII-only. Leading
 * and trailing apostrophes are stripped.
 */
export function tokenizeRationale(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}\p{M}_']+/gu)) {
    const w = match[0].replace(/^'+|'+$/gu, '');
    if (w.length < 3 || EN_STOPWORDS.has(w)) continue;
    out.push(w);
  }
  return out;
}

/**
 * Aggregate identity scores for a single catalog image, or `null` when it has no
 * current catalog scores on active perspectives.
 *
 * Perspectives are equally weighted — the aggregate is a plain mean, so adding a
 * perspective changes every image's score, which is why the count is reported
 * alongside it.
 */
export function computeSingleImageAggregateScores(
  db: Db,
  imageKey: string,
): IdentityAggregate | null {
  const activeSlugs = activePerspectiveSlugs(db);
  if (activeSlugs.length === 0) return null;
  const slugSet = new Set(activeSlugs);
  const minUsed = defaultMinPerspectives(activeSlugs.length);

  const rows = db
    .prepare(`${SCORES_BASE_SQL}\n        AND s.image_key = ?`)
    .all(imageKey) as ScoreRow[];

  // The SQL already joins active perspectives, so this filter is redundant today.
  // It is kept because it is the guarantee the aggregate depends on, and it costs
  // nothing to state twice.
  const perspectives = rows
    .filter((r) => slugSet.has(String(r.perspective_slug)))
    .map((r) => ({
      perspective_slug: String(r.perspective_slug),
      display_name: r.perspective_display_name || String(r.perspective_slug),
      score: Math.trunc(r.score),
      rationale: r.rationale ?? '',
      model_used: r.model_used ?? '',
      prompt_version: r.prompt_version ?? '',
      scored_at: r.scored_at ?? '',
    }));

  if (perspectives.length === 0) return null;

  const n = perspectives.length;
  const agg = perspectives.reduce((sum, p) => sum + p.score, 0) / n;

  const perOut = [...perspectives]
    .sort((a, b) => (a.perspective_slug < b.perspective_slug ? -1 : a.perspective_slug > b.perspective_slug ? 1 : 0))
    .map((p) => ({
      perspective_slug: p.perspective_slug,
      display_name: p.display_name,
      score: p.score,
      prompt_version: p.prompt_version,
      model_used: p.model_used,
      scored_at: p.scored_at,
      rationale_preview: truncateRationale(p.rationale),
    }));

  return {
    image_key: String(imageKey),
    aggregate_score: round4(agg),
    perspectives_covered: n,
    eligible: n >= minUsed,
    per_perspective: perOut,
  };
}
