/**
 * What the user said about a cull verdict: sent by hand, agrees with the cut, should have been cut,
 * agrees with the pass. The latest of the last two is the user's answer on a passed photo.
 * Append-only, each with the summary it answered — the labels a future retraining reads.
 *
 * Sent by hand sticks across stage and pipeline versions: the history, not the summary, is the
 * record, so no re-decide or new version can cut the photo automatically again.
 */
import { nowIsoUtc } from '../../utils/datetime.js';
import type { Db } from '../connection.js';
import { getCullVerdict } from './cull-verdicts.js';
import { libraryWrite } from './write.js';

export type CullUserAction = 'sent_by_hand' | 'agrees_with_cut' | 'should_have_been_cut' | 'agrees_with_pass';

export interface CullUserActionRow {
  id: number;
  image_key: string;
  action: CullUserAction;
  acted_at: string;
  answered_verdict: string;
  answered_cut_by: string | null;
  answered_pipeline_setting_version: number | null;
  answered_stage_version_ids: number[];
}

export function recordCullUserAction(db: Db, imageKey: string, action: CullUserAction, actedAt = nowIsoUtc()): void {
  libraryWrite(db, () => {
    const summary = getCullVerdict(db, imageKey);
    db.prepare(
      `INSERT INTO cull_user_actions
         (image_key, action, acted_at, answered_verdict, answered_cut_by,
          answered_pipeline_setting_version, answered_stage_version_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      imageKey,
      action,
      actedAt,
      summary?.verdict ?? 'none',
      summary?.cut_by ?? null,
      summary?.pipeline_setting_version ?? null,
      JSON.stringify(summary?.stage_version_ids ?? []),
    );
    if (action !== 'sent_by_hand') return;
    if (summary) {
      db.prepare(
        "UPDATE cull_verdicts SET verdict = 'sent', cut_by = NULL, cut_by_stage_key = NULL, sent_by_hand = 1, decided_at = ? WHERE image_key = ?",
      ).run(nowIsoUtc(), imageKey);
    } else {
      const current = db.prepare('SELECT version FROM cull_pipeline_settings WHERE is_current = 1').get() as
        | { version: number }
        | undefined;
      db.prepare(
        `INSERT INTO cull_verdicts (image_key, verdict, sent_by_hand, pipeline_setting_version, decided_at)
         VALUES (?, 'sent', 1, ?, ?)`,
      ).run(imageKey, current?.version ?? 0, nowIsoUtc());
    }
  });
}

export function listCullUserActions(db: Db, imageKey: string): CullUserActionRow[] {
  const rows = db
    .prepare('SELECT * FROM cull_user_actions WHERE image_key = ? ORDER BY acted_at, id')
    .all(imageKey) as (Omit<CullUserActionRow, 'answered_stage_version_ids'> & { answered_stage_version_ids: string })[];
  return rows.map((r) => ({ ...r, answered_stage_version_ids: JSON.parse(r.answered_stage_version_ids) as number[] }));
}

export function isSentByHand(db: Db, imageKey: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM cull_user_actions WHERE image_key = ? AND action = 'sent_by_hand' LIMIT 1")
      .get(imageKey) !== undefined
  );
}

/** Every photo the user sent by hand. */
export function listSentByHandKeys(db: Db): Set<string> {
  const rows = db
    .prepare("SELECT DISTINCT image_key FROM cull_user_actions WHERE action = 'sent_by_hand'")
    .all() as { image_key: string }[];
  return new Set(rows.map((r) => r.image_key));
}
