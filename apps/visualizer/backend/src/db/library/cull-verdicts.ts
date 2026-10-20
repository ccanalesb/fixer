/**
 * The per-photo cull summary — the row jobs and the UI read — and the cull run log.
 */
import type { CullSummaryVerdict, StageKind } from '../../cull/types.js';
import { nowIsoUtc } from '../../utils/datetime.js';
import type { Db } from '../connection.js';

export interface CullVerdictInput {
  imageKey: string;
  verdict: CullSummaryVerdict;
  cutBy: StageKind | null;
  cutByStageKey: string | null;
  sentByHand: boolean;
  pendingStages: string[];
  pendingReason: string;
  scoreForecastOff: boolean;
  scoreForecastP8: number | null;
  pipelineSettingVersion: number;
  stageVersionIds: number[];
  runId: number | null;
}

export interface CullVerdictRow {
  image_key: string;
  verdict: CullSummaryVerdict;
  cut_by: StageKind | null;
  cut_by_stage_key: string | null;
  sent_by_hand: boolean;
  pending_stages: string[];
  pending_reason: string;
  score_forecast_off: boolean;
  score_forecast_p8: number | null;
  pipeline_setting_version: number;
  stage_version_ids: number[];
  run_id: number | null;
  decided_at: string;
}

export function upsertCullVerdict(db: Db, v: CullVerdictInput): void {
  db.prepare(
    `INSERT INTO cull_verdicts
       (image_key, verdict, cut_by, cut_by_stage_key, sent_by_hand, pending_stages, pending_reason,
        score_forecast_off, score_forecast_p8, pipeline_setting_version, stage_version_ids, run_id, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (image_key) DO UPDATE SET
       verdict = excluded.verdict, cut_by = excluded.cut_by, cut_by_stage_key = excluded.cut_by_stage_key,
       sent_by_hand = excluded.sent_by_hand, pending_stages = excluded.pending_stages,
       pending_reason = excluded.pending_reason, score_forecast_off = excluded.score_forecast_off,
       score_forecast_p8 = excluded.score_forecast_p8,
       pipeline_setting_version = excluded.pipeline_setting_version,
       stage_version_ids = excluded.stage_version_ids, run_id = excluded.run_id, decided_at = excluded.decided_at`,
  ).run(
    v.imageKey,
    v.verdict,
    v.cutBy,
    v.cutByStageKey,
    v.sentByHand ? 1 : 0,
    JSON.stringify(v.pendingStages),
    v.pendingReason,
    v.scoreForecastOff ? 1 : 0,
    v.scoreForecastP8,
    v.pipelineSettingVersion,
    JSON.stringify(v.stageVersionIds),
    v.runId,
    nowIsoUtc(),
  );
}

interface RawVerdictRow extends Omit<CullVerdictRow, 'sent_by_hand' | 'pending_stages' | 'score_forecast_off' | 'stage_version_ids'> {
  sent_by_hand: number;
  pending_stages: string;
  score_forecast_off: number;
  stage_version_ids: string;
}

export function getCullVerdict(db: Db, imageKey: string): CullVerdictRow | null {
  const r = db.prepare('SELECT * FROM cull_verdicts WHERE image_key = ?').get(imageKey) as RawVerdictRow | undefined;
  if (!r) return null;
  return {
    ...r,
    sent_by_hand: r.sent_by_hand === 1,
    pending_stages: JSON.parse(r.pending_stages) as string[],
    score_forecast_off: r.score_forecast_off === 1,
    stage_version_ids: JSON.parse(r.stage_version_ids) as number[],
  };
}

export interface CullVerdictStamp {
  pipelineSettingVersion: number;
  stageVersionIds: number[];
  pendingReason: string;
}

/** What each summary row was decided under, to tell a current one from one a version change left behind. */
export function loadCullVerdictStamps(db: Db): Map<string, CullVerdictStamp> {
  const rows = db
    .prepare('SELECT image_key, pipeline_setting_version, stage_version_ids, pending_reason FROM cull_verdicts')
    .all() as { image_key: string; pipeline_setting_version: number; stage_version_ids: string; pending_reason: string }[];
  return new Map(
    rows.map((r) => [
      r.image_key,
      {
        pipelineSettingVersion: r.pipeline_setting_version,
        stageVersionIds: JSON.parse(r.stage_version_ids) as number[],
        pendingReason: r.pending_reason,
      },
    ]),
  );
}

export function insertCullRun(
  db: Db,
  run: { kind: 'job' | 'research_import' | 'redecide'; jobId: string | null; pipelineSettingVersion: number; detail?: Record<string, unknown> },
): number {
  const info = db
    .prepare(
      'INSERT INTO cull_runs (kind, job_id, started_at, pipeline_setting_version, detail_json) VALUES (?, ?, ?, ?, ?)',
    )
    .run(run.kind, run.jobId, nowIsoUtc(), run.pipelineSettingVersion, JSON.stringify(run.detail ?? {}));
  return Number(info.lastInsertRowid);
}

export function finishCullRun(db: Db, runId: number, detail: Record<string, unknown>): void {
  db.prepare('UPDATE cull_runs SET finished_at = ?, detail_json = ? WHERE run_id = ?').run(
    nowIsoUtc(),
    JSON.stringify(detail),
    runId,
  );
}

/** Photos per query: well under SQLite's bound-parameter limit. */
const KEYS_PER_QUERY = 500;

/** A sent-by-hand action, read inline: `cull-user-actions.ts` imports this module. */
const SENT_BY_HAND_SQL =
  "(v.sent_by_hand = 1 OR EXISTS (SELECT 1 FROM cull_user_actions u WHERE u.image_key = v.image_key AND u.action = 'sent_by_hand'))";

/**
 * Cut, and the user never sent it on: the last check before a photo is described or scored. Only a
 * cut is refused — a pending or never-culled photo passes (the batch jobs hold those back themselves).
 */
export function isPhotoCutAndNotSentByHand(db: Db, imageKey: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM cull_verdicts v WHERE v.image_key = ? AND v.verdict = 'cut' AND NOT ${SENT_BY_HAND_SQL}`)
      .get(imageKey) !== undefined
  );
}

export interface CullVerdictBrief {
  verdict: CullSummaryVerdict;
  cutBy: StageKind | null;
  /** On the summary or in the user-action history. */
  sentByHand: boolean;
}

/** Each photo's verdict, for the photos that have one; one query per 500 photos. */
export function loadCullVerdictsForKeys(db: Db, imageKeys: readonly string[]): Map<string, CullVerdictBrief> {
  const out = new Map<string, CullVerdictBrief>();
  for (let i = 0; i < imageKeys.length; i += KEYS_PER_QUERY) {
    const chunk = imageKeys.slice(i, i + KEYS_PER_QUERY);
    const rows = db
      .prepare(
        `SELECT v.image_key, v.verdict, v.cut_by, ${SENT_BY_HAND_SQL} AS by_hand FROM cull_verdicts v
         WHERE v.image_key IN (${chunk.map(() => '?').join(',')})`,
      )
      .all(...chunk) as { image_key: string; verdict: CullSummaryVerdict; cut_by: StageKind | null; by_hand: number }[];
    for (const r of rows) out.set(r.image_key, { verdict: r.verdict, cutBy: r.cut_by, sentByHand: r.by_hand === 1 });
  }
  return out;
}

/** Every photo the cull has touched: a summary row or an answer under a current stage version. */
export function listCulledImageKeys(db: Db): string[] {
  const rows = db
    .prepare(
      `SELECT image_key FROM cull_verdicts
       UNION
       SELECT a.image_key FROM cull_stage_answers a
       JOIN cull_stage_versions s ON s.id = a.stage_version_id AND s.is_current = 1
       ORDER BY image_key`,
    )
    .all() as { image_key: string }[];
  return rows.map((r) => r.image_key);
}
