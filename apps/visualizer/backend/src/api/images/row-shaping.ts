/**
 * Turn `queryCatalogImages` rows into API image objects.
 *
 * Shared by the catalog list, visual similarity, similarity groups, stack
 * suggestions and stack members, so the shaping lives here or the endpoints drift.
 */
import type { Row } from '../../db/library/catalog.js';
import type { CatalogImage } from '../schemas/catalog.js';

/** The `thumbnail_url` every catalog consumer builds for a key. */
export function catalogThumbnailUrl(key: string): string {
  return `/api/images/catalog/${key}/thumbnail`;
}

/** Only an all-digits `id` becomes a number; anything else becomes null. */
function numericId(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return /^[0-9]+$/.test(s) ? Number.parseInt(s, 10) : null;
}

function intOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Math.trunc(Number(value));
}

/** Rows in, `CatalogImage`s out. Keys come from `SELECT i.*`, so the cast is intentional. */
export function rowsToCatalogApiImages(rows: readonly Row[]): CatalogImage[] {
  return rows.map((row) => {
    const out: Row = { ...row };

    const descSummary = out.description_summary ?? null;
    const descBest = out.description_best_perspective ?? null;

    const cps = out.catalog_perspective_score ?? null;
    out.catalog_perspective_score = cps === null ? null : Math.trunc(Number(cps));
    const csp = out.catalog_score_perspective ?? null;
    // Deliberately gated on the *score*, not the slug: a slug without a score is
    // meaningless, so both fields drop together.
    out.catalog_score_perspective = cps !== null && csp !== null ? String(csp) : null;

    // "Analyzed" means a description row exists, which the LEFT JOIN reports as a
    // non-null summary. An empty summary still counts as analyzed, hence the
    // null-check rather than a truthiness test.
    const aiAnalyzed = descSummary !== null;
    out.ai_analyzed = aiAnalyzed;
    out.description_summary = aiAnalyzed ? descSummary || '' : null;
    out.description_best_perspective = aiAnalyzed ? descBest || '' : null;

    out.id = numericId(out.id);
    out.stack_id = intOrNull(out.stack_id);
    out.stack_member_count = intOrNull(out.stack_member_count);
    out.is_stack_representative =
      out.is_stack_representative === null || out.is_stack_representative === undefined
        ? false
        : Boolean(out.is_stack_representative);

    return out as unknown as CatalogImage;
  });
}

/** `Visual match (87%)` — the similarity line shown under a CLIP neighbour. */
export function clipSimilarityWhyMatchedLine(similarity: number): string {
  const pct = Math.max(0, Math.min(100, Math.round(Number(similarity) * 100)));
  return `Visual match (${pct}%)`;
}
