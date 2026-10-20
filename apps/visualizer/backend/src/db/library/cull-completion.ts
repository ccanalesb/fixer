/**
 * Batch describe/score completion for cull review rows (active perspectives only).
 */
import { computePromptVersion } from '../../vision/scoring-service.js';
export type DescribeScoreCompletion = 'none' | 'some' | 'all';
import type { Db } from '../connection.js';
import { listPerspectives } from './scores.js';

const KEYS_PER_QUERY = 500;

function chunkKeys(keys: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += KEYS_PER_QUERY) {
    chunks.push(keys.slice(i, i + KEYS_PER_QUERY) as string[]);
  }
  return chunks;
}

/** Non-stale catalog descriptions for the given keys. */
function loadDescribedCatalogKeys(db: Db, keys: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const chunk of chunkKeys(keys)) {
    const rows = db
      .prepare(
        `SELECT DISTINCT d.image_key FROM image_descriptions d
         WHERE d.image_key IN (${chunk.map(() => '?').join(',')})
           AND d.image_type = 'catalog'
           AND NOT EXISTS (
             SELECT 1 FROM vision_stale vs
             WHERE vs.image_key = d.image_key AND vs.output = 'description'
           )`,
      )
      .all(...chunk) as { image_key: string }[];
    for (const r of rows) out.add(r.image_key);
  }
  return out;
}

type ScoreRow = { image_key: string; perspective_slug: string; prompt_version: string };

function loadCurrentScoreRows(db: Db, keys: readonly string[], slugs: readonly string[]): ScoreRow[] {
  if (keys.length === 0 || slugs.length === 0) return [];
  const out: ScoreRow[] = [];
  for (const chunk of chunkKeys(keys)) {
    const rows = db
      .prepare(
        `SELECT image_key, perspective_slug, prompt_version FROM image_scores
         WHERE image_key IN (${chunk.map(() => '?').join(',')})
           AND image_type = 'catalog'
           AND perspective_slug IN (${slugs.map(() => '?').join(',')})
           AND is_current = 1`,
      )
      .all(...chunk, ...slugs) as ScoreRow[];
    out.push(...rows);
  }
  return out;
}

export function batchDescribeScoreCompletion(
  db: Db,
  keys: readonly string[],
): Map<string, DescribeScoreCompletion> {
  const result = new Map<string, DescribeScoreCompletion>();
  for (const k of keys) result.set(k, 'none');
  if (keys.length === 0) return result;

  const active = listPerspectives(db, { activeOnly: true });
  const described = loadDescribedCatalogKeys(db, keys);

  if (active.length === 0) {
    for (const k of keys) result.set(k, described.has(k) ? 'all' : 'none');
    return result;
  }

  const expectedVersion = new Map<string, string>();
  for (const p of active) {
    expectedVersion.set(p.slug, computePromptVersion({ slug: p.slug, prompt_markdown: p.prompt_markdown }));
  }

  const scoredCount = new Map<string, number>();
  for (const k of keys) scoredCount.set(k, 0);

  for (const row of loadCurrentScoreRows(db, keys, active.map((p) => p.slug))) {
    if (expectedVersion.get(row.perspective_slug) !== row.prompt_version) continue;
    scoredCount.set(row.image_key, (scoredCount.get(row.image_key) ?? 0) + 1);
  }

  for (const k of keys) {
    const d = described.has(k);
    const scored = scoredCount.get(k) ?? 0;
    if (!d && scored === 0) result.set(k, 'none');
    else if (d && scored === active.length) result.set(k, 'all');
    else result.set(k, 'some');
  }
  return result;
}
