/**
 * Insights landing-page aggregates.
 *
 * All of these are whole-catalog counts, so they are written as single SQL
 * aggregates rather than loops — on 43k images the difference is a page that loads
 * and a page that does not.
 */
import type { Db } from '../connection.js';
import {
  countFrameSubstanceByUnknownReason,
  countFrameSubstanceFlaggedNetOfOverrides,
  countFrameSubstanceNeverJudged,
  getLatestFinishedFrameSubstanceRun,
} from './frame-substance.js';
import { countPendingStackSuggestions } from './stack-suggestions.js';
import { firstCatalogImportCompleted } from './bootstrap.js';

export interface PerspectiveCoverageRow {
  slug: string;
  display_name: string;
  active: boolean;
  scored_images: number;
}

export interface FrameSubstanceRunSummary {
  detector_version: string;
  finished_at: string;
  breached: boolean;
  breach_reason: string;
}

export interface InsightsSummary {
  first_catalog_import_completed: boolean;
  catalog_images: number;
  scoring_9_plus: number;
  burst_stacks: number;
  pending_stack_suggestions: number;
  unscored_on_active_perspectives: number;
  no_current_score: number;
  perspective_coverage: PerspectiveCoverageRow[];
  frame_substance_flagged: number;
  frame_substance_unknown: Record<string, number>;
  frame_substance_run: FrameSubstanceRunSummary | null;
}

function scalar(db: Db, sql: string): number {
  return Math.trunc((db.prepare(sql).get() as { c: number }).c);
}

/** Tile counts and per-perspective coverage for the Insights landing page. */
export function getInsightsSummary(db: Db): InsightsSummary {
  const catalogImages = scalar(db, 'SELECT COUNT(*) AS c FROM images');

  const scoring9Plus = scalar(
    db,
    `
      SELECT COUNT(DISTINCT s.image_key) AS c
      FROM image_scores s
      INNER JOIN perspectives p
          ON p.slug = s.perspective_slug AND p.active = 1
      WHERE s.is_current = 1
        AND s.image_type = 'catalog'
        AND s.score >= 9
      `,
  );

  const burstStacks = scalar(db, 'SELECT COUNT(*) AS c FROM image_stacks');
  const pendingStackSuggestions = countPendingStackSuggestions(db);

  const frameSubstanceFlagged = countFrameSubstanceFlaggedNetOfOverrides(db);
  const frameSubstanceUnknown = countFrameSubstanceByUnknownReason(db);
  const neverJudged = countFrameSubstanceNeverJudged(db);
  // Folded into the same map under a synthetic reason: from the tile's point of
  // view, "never looked at" is one more way a verdict is unknown.
  if (neverJudged) frameSubstanceUnknown.never_judged = neverJudged;

  const latestRun = getLatestFinishedFrameSubstanceRun(db);
  const frameSubstanceRun: FrameSubstanceRunSummary | null =
    latestRun === null
      ? null
      : {
          detector_version: String(latestRun.detector_version),
          finished_at: String(latestRun.finished_at),
          breached: Boolean(Math.trunc(latestRun.breached || 0)),
          breach_reason: String(latestRun.breach_reason || ''),
        };

  // "Missing at least one active perspective" — the cross join is intentional: one
  // row per (image, active perspective) pair, counting distinct images that have a
  // gap anywhere.
  const unscoredOnActivePerspectives = scalar(
    db,
    `
      SELECT COUNT(DISTINCT i.key) AS c
      FROM images i
      INNER JOIN perspectives p ON p.active = 1
      WHERE NOT EXISTS (
          SELECT 1 FROM image_scores s
          WHERE s.image_key = i.key
            AND s.perspective_slug = p.slug
            AND s.is_current = 1
            AND s.image_type = 'catalog'
      )
      `,
  );

  const noCurrentScore = scalar(
    db,
    `
      SELECT COUNT(*) AS c
      FROM images i
      WHERE NOT EXISTS (
          SELECT 1 FROM image_scores s
          WHERE s.image_key = i.key
            AND s.is_current = 1
            AND s.image_type = 'catalog'
      )
      `,
  );

  const coverageRows = db
    .prepare(
      `
        SELECT
            p.slug AS slug,
            p.display_name AS display_name,
            p.active AS active,
            COUNT(DISTINCT s.image_key) AS scored_images
        FROM perspectives p
        LEFT JOIN image_scores s
            ON s.perspective_slug = p.slug
           AND s.is_current = 1
           AND s.image_type = 'catalog'
        GROUP BY p.slug
        ORDER BY p.slug ASC
        `,
    )
    .all() as { slug: string; display_name: string; active: number; scored_images: number }[];

  return {
    first_catalog_import_completed: firstCatalogImportCompleted(db),
    catalog_images: catalogImages,
    scoring_9_plus: scoring9Plus,
    burst_stacks: burstStacks,
    pending_stack_suggestions: pendingStackSuggestions,
    unscored_on_active_perspectives: unscoredOnActivePerspectives,
    no_current_score: noCurrentScore,
    perspective_coverage: coverageRows.map((row) => ({
      slug: String(row.slug),
      display_name: String(row.display_name),
      active: Boolean(row.active),
      scored_images: Math.trunc(row.scored_images),
    })),
    frame_substance_flagged: frameSubstanceFlagged,
    frame_substance_unknown: frameSubstanceUnknown,
    frame_substance_run: frameSubstanceRun,
  };
}
