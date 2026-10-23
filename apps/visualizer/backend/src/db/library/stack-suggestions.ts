/**
 * Catalog similarity pairs reframed as stack suggestions.
 */
import type { Db } from '../connection.js';
import { prepareCached } from '../prepare-cached.js';
import { flaggedExistsSql } from './frame-substance-sql.js';
import {
  selectStackRepresentativeKeyForKeys,
  stackIdForImageKey,
  stackMergeInto,
  stackMetadataForApi,
  StackMutationError,
  type MergeResult,
  type StackMetadata,
} from './stacks.js';
import { nowIsoLocal } from '../../utils/datetime.js';

/**
 * Pending pairs: every similarity candidate that has not been rejected, is not
 * already inside one shared stack, and does not involve a condemned frame.
 *
 * `key_a`/`key_b` are the normalized (sorted) pair, which is what the rejection
 * table is keyed on — so a user who rejected (b, a) does not see (a, b) come back.
 */
const PENDING_PAIRS_SQL = `
WITH pairs AS (
    SELECT
        g.group_id,
        g.seed_key,
        c.candidate_key,
        c.similarity,
        c.why_matched,
        CASE WHEN g.seed_key < c.candidate_key THEN g.seed_key ELSE c.candidate_key END AS key_a,
        CASE WHEN g.seed_key < c.candidate_key THEN c.candidate_key ELSE g.seed_key END AS key_b
    FROM catalog_similarity_groups g
    INNER JOIN catalog_similarity_candidates c ON c.group_id = g.group_id
)
SELECT
    p.group_id,
    p.seed_key,
    p.candidate_key,
    p.similarity,
    p.why_matched,
    p.key_a,
    p.key_b,
    i1.date_taken AS seed_date_taken,
    i2.date_taken AS candidate_date_taken,
    m1.stack_id AS seed_stack_id,
    m2.stack_id AS candidate_stack_id,
    CASE
        WHEN m1.stack_id IS NULL AND m2.stack_id IS NULL THEN 0
        WHEN m1.stack_id IS NULL OR m2.stack_id IS NULL THEN 1
        ELSE 2
    END AS stack_status_rank,
    ABS(
        COALESCE(strftime('%s', i1.date_taken), 0)
        - COALESCE(strftime('%s', i2.date_taken), 0)
    ) AS time_gap_seconds
FROM pairs p
INNER JOIN images i1 ON i1.key = p.seed_key
INNER JOIN images i2 ON i2.key = p.candidate_key
LEFT JOIN image_stack_members m1 ON m1.image_key = p.seed_key
LEFT JOIN image_stack_members m2 ON m2.image_key = p.candidate_key
LEFT JOIN catalog_similarity_rejections r
    ON r.key_a = p.key_a AND r.key_b = p.key_b
WHERE r.key_a IS NULL
  AND NOT (
      m1.stack_id IS NOT NULL
      AND m2.stack_id IS NOT NULL
      AND m1.stack_id = m2.stack_id
  )
  AND NOT ${flaggedExistsSql('p.seed_key', 'p.candidate_key')}
`;

export interface PendingSuggestionRow {
  group_id: number;
  seed_key: string;
  candidate_key: string;
  similarity: number | null;
  why_matched: string | null;
  key_a: string;
  key_b: string;
  stack_status_rank: number;
  time_gap_seconds: number | null;
}

/**
 * Lexicographically ordered pair, so `(a, b)` and `(b, a)` collide on one row.
 *
 * `catalog_similarity_rejections` enforces `CHECK (key_a < key_b)`, so normalizing
 * here is not merely tidy — an unnormalized insert is rejected by the database.
 */
export function normalizeImagePair(keyA: string, keyB: string): [string, string] {
  const a = String(keyA);
  const b = String(keyB);
  if (a === b) throw new RangeError('image keys must differ');
  return a < b ? [a, b] : [b, a];
}

export function isCatalogSimilarityPairRejected(db: Db, keyA: string, keyB: string): boolean {
  const [a, b] = normalizeImagePair(keyA, keyB);
  const row = prepareCached(
    db,
    `
        SELECT 1 AS o FROM catalog_similarity_rejections
        WHERE key_a = ? AND key_b = ?
        LIMIT 1
        `,
  ).get(a, b);
  return row !== undefined;
}

/**
 * Persist a user rejection for a normalized image-key pair.
 *
 * Does not commit — caller's `libraryWrite` owns the transaction.
 */
export function rejectCatalogSimilarityPair(db: Db, keyA: string, keyB: string): void {
  const [a, b] = normalizeImagePair(keyA, keyB);
  db.prepare(
    `
        INSERT OR IGNORE INTO catalog_similarity_rejections (key_a, key_b, rejected_at)
        VALUES (?, ?, ?)
        `,
  ).run(a, b, nowIsoLocal());
}

/** Create a new stack from `memberKeys` (at least two distinct). Call inside `libraryWrite`. */
export function stackCreateFromKeys(
  db: Db,
  memberKeys: readonly string[],
): { stack: StackMetadata } {
  const uniqueKeys = [...new Set(memberKeys.filter(Boolean).map(String))].sort();
  if (uniqueKeys.length < 2) {
    throw new StackMutationError('at least two distinct image keys required', 400);
  }
  const rep = selectStackRepresentativeKeyForKeys(db, uniqueKeys);
  if (!rep || !uniqueKeys.includes(rep)) {
    throw new StackMutationError('stack representative selection failed', 500);
  }
  const info = db
    .prepare('INSERT INTO image_stacks (representative_key, stack_size, user_modified) VALUES (?, ?, 1)')
    .run(rep, uniqueKeys.length);
  const stackId = Number(info.lastInsertRowid);
  const insertMember = db.prepare(
    'INSERT INTO image_stack_members (stack_id, image_key) VALUES (?, ?)',
  );
  for (const mkey of uniqueKeys) insertMember.run(stackId, mkey);

  const meta = stackMetadataForApi(db, stackId);
  if (!meta) throw new StackMutationError('stack creation failed', 500);
  return { stack: meta };
}

/** Add `imageKey` to an existing stack. Call inside `libraryWrite`. */
export function stackAddMember(
  db: Db,
  stackId: number,
  imageKey: string,
): { stack: StackMetadata } {
  const stackRow = db
    .prepare('SELECT stack_id FROM image_stacks WHERE stack_id = ?')
    .get(stackId);
  if (!stackRow) throw new StackMutationError('stack not found', 404);

  const existing = db
    .prepare('SELECT stack_id FROM image_stack_members WHERE image_key = ? LIMIT 1')
    .get(imageKey) as { stack_id: number } | undefined;
  if (existing) {
    const sid = Math.trunc(existing.stack_id);
    // Already in this stack: idempotent, not an error.
    if (sid === stackId) {
      const meta = stackMetadataForApi(db, stackId);
      if (!meta) throw new StackMutationError('stack not found', 404);
      return { stack: meta };
    }
    throw new StackMutationError('image_key already belongs to another stack', 400);
  }

  db.prepare('INSERT INTO image_stack_members (stack_id, image_key) VALUES (?, ?)').run(
    stackId,
    imageKey,
  );
  const keys = db
    .prepare('SELECT image_key FROM image_stack_members WHERE stack_id = ?')
    .all(stackId) as { image_key: string }[];
  db.prepare('UPDATE image_stacks SET stack_size = ?, user_modified = 1 WHERE stack_id = ?').run(
    keys.length,
    stackId,
  );

  const meta = stackMetadataForApi(db, stackId);
  if (!meta) throw new StackMutationError('stack not found', 404);
  return { stack: meta };
}

/**
 * Create, extend, or merge stacks so `keyA` and `keyB` end up in one stack.
 * Call inside `libraryWrite`.
 *
 * Returns `{ stack }` in three of the four branches and `{ stack, merged_stack_id }`
 * when two existing stacks were merged — the accept route narrows that to `{ stack }`
 * because its response model forbids extra fields.
 */
export function stackAcceptSuggestionPair(
  db: Db,
  keyA: string,
  keyB: string,
): { stack: StackMetadata } | MergeResult {
  const a = String(keyA);
  const b = String(keyB);
  if (a === b) throw new StackMutationError('image keys must differ', 400);

  const sidA = stackIdForImageKey(db, a);
  const sidB = stackIdForImageKey(db, b);

  if (sidA !== null && sidB !== null) {
    if (sidA === sidB) {
      const meta = stackMetadataForApi(db, sidA);
      if (!meta) throw new StackMutationError('stack not found', 404);
      return { stack: meta };
    }
    return stackMergeInto(db, sidA, sidB);
  }
  if (sidA !== null) return stackAddMember(db, sidA, b);
  if (sidB !== null) return stackAddMember(db, sidB, a);
  return stackCreateFromKeys(db, [a, b]);
}

/** Pending stack-to-confirm pairs after rejection, flagged-frame and stack filters. */
export function countPendingStackSuggestions(db: Db): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM (${PENDING_PAIRS_SQL}) pending`)
    .get() as { c: number } | undefined;
  return row ? Math.trunc(row.c) : 0;
}

/** A page of pending pairs, ranked by stack status then time proximity. */
export function listPendingStackSuggestions(
  db: Db,
  opts: { limit: number; offset: number },
): { rows: PendingSuggestionRow[]; total: number } {
  const total = countPendingStackSuggestions(db);
  const rows = db
    .prepare(
      `
        SELECT *
        FROM (${PENDING_PAIRS_SQL}) pending
        ORDER BY stack_status_rank ASC, time_gap_seconds ASC, group_id DESC
        LIMIT ? OFFSET ?
        `,
    )
    .all(Math.trunc(opts.limit), Math.trunc(opts.offset)) as PendingSuggestionRow[];
  return { rows, total };
}
