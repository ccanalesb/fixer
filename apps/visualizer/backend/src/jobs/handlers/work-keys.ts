/**
 * Which catalog keys would actually be sent to kimi in a describe or score job — the
 * in-job cull step and the autopilot's scoped cull job use the same pre-filters as
 * `runDescribePass` / `runScorePass`.
 */
import type { Db } from '../../db/connection.js';
import { getPerspectiveBySlug } from '../../db/library/scores.js';
import { staleDescriptionKeys, staleScoreLabels } from '../../db/library/vision-stale.js';
import { computePromptVersion } from '../../vision/scoring-service.js';
import { resolveScoreSlugs } from './score.js';

const pairLabel = (key: string, itype: string): string => `${key}|${itype}`;
const tripletLabel = (key: string, itype: string, slug: string): string => `${key}|${itype}|${slug}`;

/** Pairs from `selection` that `runDescribePass` would still describe. */
export function filterPairsWithDescribeWork(
  db: Db,
  metadata: Record<string, unknown>,
  selection: readonly (readonly [string, string])[],
): (readonly [string, string])[] {
  const force = Boolean(metadata['force']);
  const redoUnlessModel = String(metadata['redo_unless_model'] ?? '').trim() || null;
  const backfillVisualTags = Boolean(metadata['backfill_visual_tags']);

  let pending = [...selection];
  const stale = staleDescriptionKeys(db);

  if (!backfillVisualTags && !force && redoUnlessModel === null && pending.length > 0) {
    const described = new Set(
      (db.prepare('SELECT image_key FROM image_descriptions').all() as { image_key: string }[]).map(
        (r) => r.image_key,
      ),
    );
    pending = pending.filter(([k]) => !described.has(k) || stale.has(k));
  }

  if (redoUnlessModel !== null && pending.length > 0) {
    const rows = db
      .prepare('SELECT image_key, image_type FROM image_descriptions WHERE model_used = ?')
      .all(redoUnlessModel) as { image_key: string; image_type: string }[];
    const doneByTarget = new Set(rows.map((r) => pairLabel(r.image_key, r.image_type)));
    pending = pending.filter(([k, t]) => !doneByTarget.has(pairLabel(k, t)) || stale.has(k));
  }

  return pending;
}

/** Keys from `selection` that `runDescribePass` would still describe. */
export function selectKeysWithDescribeWork(
  db: Db,
  metadata: Record<string, unknown>,
  selection: readonly (readonly [string, string])[],
): string[] {
  return [...new Set(filterPairsWithDescribeWork(db, metadata, selection).map(([k]) => k))];
}

/** Every `key|itype|slug` with a current score at the live rubric (optional model filter). */
export function currentScoreLabels(
  db: Db,
  promptVersions: ReadonlyMap<string, string>,
  modelUsed: string | null,
): Set<string> {
  const stmt = db.prepare(
    'SELECT image_key, image_type FROM image_scores ' +
      'WHERE perspective_slug = ? AND prompt_version = ? AND is_current = 1' +
      (modelUsed === null ? '' : ' AND model_used = ?'),
  );
  const labels = new Set<string>();
  for (const [slug, version] of promptVersions) {
    const params = modelUsed === null ? [slug, version] : [slug, version, modelUsed];
    const rows = stmt.all(...(params as never[])) as { image_key: string; image_type: string }[];
    for (const r of rows) labels.add(tripletLabel(r.image_key, r.image_type, slug));
  }
  return labels;
}

function scorePromptVersions(db: Db, slugs: readonly string[]): Map<string, string> {
  const promptVersions = new Map<string, string>();
  for (const slug of slugs) {
    const row = getPerspectiveBySlug(db, slug);
    if (row) promptVersions.set(slug, computePromptVersion(row));
  }
  return promptVersions;
}

/** Triples from `workTriples` that `runScorePass` would still score. */
export function filterTriplesWithScoreWork(
  db: Db,
  metadata: Record<string, unknown>,
  workTriples: readonly (readonly [string, string, string])[],
): [string, string, string][] {
  const redoUnlessModel = String(metadata['redo_unless_model'] ?? '').trim() || null;
  const force = Boolean(metadata['force']) || redoUnlessModel !== null;
  const slugs = resolveScoreSlugs(db, metadata);
  let pending = [...workTriples];

  const promptVersions = scorePromptVersions(db, slugs);
  const stale = staleScoreLabels(db);
  const isDone = (done: Set<string>, triple: readonly [string, string, string]): boolean =>
    done.has(tripletLabel(triple[0], triple[1], triple[2])) && !stale.has(`${triple[0]}|${triple[2]}`);

  if (!force && pending.length > 0 && promptVersions.size > 0) {
    const done = currentScoreLabels(db, promptVersions, null);
    pending = pending.filter((triple) => !isDone(done, triple));
  }
  if (redoUnlessModel !== null && pending.length > 0 && promptVersions.size > 0) {
    const done = currentScoreLabels(db, promptVersions, redoUnlessModel);
    pending = pending.filter((triple) => !isDone(done, triple));
  }

  return pending.map((t): [string, string, string] => [t[0], t[1], t[2]]);
}

/** Keys from `selection` that `runScorePass` would still score (any perspective). */
export function selectKeysWithScoreWork(
  db: Db,
  metadata: Record<string, unknown>,
  selection: readonly (readonly [string, string])[],
): string[] {
  const slugs = resolveScoreSlugs(db, metadata);
  const workTriples: [string, string, string][] = selection.flatMap(([key, itype]) =>
    slugs.map((slug): [string, string, string] => [key, itype, slug]),
  );
  return [...new Set(filterTriplesWithScoreWork(db, metadata, workTriples).map(([k]) => k))];
}

/** Keys that `POST /cull/photos/send` would enqueue (describe and/or score work). */
export function batchKeysWithSendWork(db: Db, imageKeys: readonly string[]): Set<string> {
  if (imageKeys.length === 0) return new Set();
  const selection = imageKeys.map((k) => [k, 'catalog'] as const);
  const meta = { image_type: 'catalog', force: false, image_keys: [...imageKeys] };
  return new Set([
    ...selectKeysWithDescribeWork(db, meta, selection),
    ...selectKeysWithScoreWork(db, meta, selection),
  ]);
}
