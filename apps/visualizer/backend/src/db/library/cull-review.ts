/**
 * SQL for the culling review UI: filtered photos, summary stats, last checked.
 */
import type { StageKind } from '../../cull/types.js';
import type { Db } from '../connection.js';

const SENT_BY_HAND_SQL =
  "(v.sent_by_hand = 1 OR EXISTS (SELECT 1 FROM cull_user_actions u WHERE u.image_key = v.image_key AND u.action = 'sent_by_hand'))";

const KEYS_PER_QUERY = 500;

export interface CullReviewSummary {
  not_passed_count: number;
  sent_manually_count: number;
  tab_counts: { all: number; culling_profile: number; score_forecast: number };
  last_checked_at: string | null;
}

export function getCullReviewSummary(db: Db): CullReviewSummary {
  const notPassed = db
    .prepare(
      `SELECT COUNT(*) AS n FROM cull_verdicts v WHERE v.verdict = 'filtered' AND NOT ${SENT_BY_HAND_SQL}`,
    )
    .get() as { n: number };
  const sentManual = db
    .prepare(`SELECT COUNT(*) AS n FROM cull_verdicts v WHERE ${SENT_BY_HAND_SQL}`)
    .get() as { n: number };
  const byProfile = db
    .prepare(
      `SELECT COUNT(*) AS n FROM cull_verdicts v WHERE v.verdict = 'filtered' AND v.filtered_by = 'culling_profile' AND NOT ${SENT_BY_HAND_SQL}`,
    )
    .get() as { n: number };
  const byForecast = db
    .prepare(
      `SELECT COUNT(*) AS n FROM cull_verdicts v WHERE v.verdict = 'filtered' AND v.filtered_by = 'score_forecast' AND NOT ${SENT_BY_HAND_SQL}`,
    )
    .get() as { n: number };
  const lastRun = db
    .prepare(
      "SELECT finished_at FROM cull_runs WHERE kind = 'job' AND finished_at IS NOT NULL ORDER BY run_id DESC LIMIT 1",
    )
    .get() as { finished_at: string } | undefined;
  return {
    not_passed_count: notPassed.n,
    sent_manually_count: sentManual.n,
    tab_counts: { all: notPassed.n, culling_profile: byProfile.n, score_forecast: byForecast.n },
    last_checked_at: lastRun?.finished_at ?? null,
  };
}

export interface CullReviewListRow {
  image_key: string;
  filename: string;
  date_taken: string | null;
  filtered_by: StageKind;
  filtered_by_stage_key: string | null;
  score_forecast_p8: number | null;
}

export function listCullReviewPhotos(
  db: Db,
  tab: 'all' | 'culling_profile' | 'score_forecast',
  limit: number,
  offset: number,
): { rows: CullReviewListRow[]; total: number } {
  let verdictFilter = '';
  if (tab === 'culling_profile') verdictFilter = " AND v.filtered_by = 'culling_profile'";
  else if (tab === 'score_forecast') verdictFilter = " AND v.filtered_by = 'score_forecast'";

  const baseWhere = `v.verdict = 'filtered' AND NOT ${SENT_BY_HAND_SQL}${verdictFilter}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM cull_verdicts v WHERE ${baseWhere}`).get() as { n: number }).n;

  const rows = db
    .prepare(
      `SELECT v.image_key, i.filename, i.date_taken, v.filtered_by, v.filtered_by_stage_key, v.score_forecast_p8
       FROM cull_verdicts v
       JOIN images i ON i.key = v.image_key
       WHERE ${baseWhere}
       ORDER BY v.score_forecast_p8 IS NULL, v.score_forecast_p8 DESC, v.image_key
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as CullReviewListRow[];

  return { rows, total };
}

/** Catalog keys that passed cull or were sent by hand (Images → Cull catalog). */
export function listCullCatalogImageKeys(db: Db, keys: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (keys.length === 0) return out;
  for (let i = 0; i < keys.length; i += KEYS_PER_QUERY) {
    const chunk = keys.slice(i, i + KEYS_PER_QUERY);
    const rows = db
      .prepare(
        `SELECT v.image_key FROM cull_verdicts v
         WHERE v.image_key IN (${chunk.map(() => '?').join(',')})
           AND (v.verdict = 'passed' OR ${SENT_BY_HAND_SQL})`,
      )
      .all(...chunk) as { image_key: string }[];
    for (const r of rows) out.add(r.image_key);
  }
  return out;
}

export function isCullCatalogPhoto(db: Db, imageKey: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM cull_verdicts v WHERE v.image_key = ?
         AND (v.verdict = 'passed' OR ${SENT_BY_HAND_SQL})`,
      )
      .get(imageKey) !== undefined
  );
}

export function cullManuallySent(db: Db, imageKey: string): boolean {
  return batchCullManuallySent(db, [imageKey]).has(imageKey);
}

export function batchCullManuallySent(db: Db, keys: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (keys.length === 0) return out;
  for (let i = 0; i < keys.length; i += KEYS_PER_QUERY) {
    const chunk = keys.slice(i, i + KEYS_PER_QUERY);
    const rows = db
      .prepare(
        `SELECT v.image_key FROM cull_verdicts v
         WHERE v.image_key IN (${chunk.map(() => '?').join(',')}) AND ${SENT_BY_HAND_SQL}`,
      )
      .all(...chunk) as { image_key: string }[];
    for (const r of rows) out.add(r.image_key);
  }
  return out;
}
