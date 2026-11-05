/**
 * Whether the user sent a photo by hand — read only from `cull_user_actions`, not `cull_verdicts.sent_by_hand`.
 */
import type { Db } from '../connection.js';

/** SQL predicate: alias is a `cull_verdicts` row (e.g. `v`, `cv`). */
export function sentByHandSql(alias: string): string {
  return `(EXISTS (SELECT 1 FROM cull_user_actions u WHERE u.image_key = ${alias}.image_key AND u.action = 'sent_by_hand'))`;
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
