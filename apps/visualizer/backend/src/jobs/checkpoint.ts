/**
 * Resume checkpoints, stored in `jobs.metadata.checkpoint`.
 *
 * A batch job describes tens of thousands of images through a paid API, so a
 * restart must not re-run the work already paid for. The checkpoint records which
 * units are done, and a fingerprint of the inputs that produced them — resuming
 * against a *different* selection would silently skip images the user just asked
 * for, so a fingerprint mismatch discards the checkpoint and says so in the log.
 *
 * `batch_describe` — `job_type`, `fingerprint`, `processed_pairs` (`"key|itype"`),
 * `total_at_start`.
 *
 * `batch_score` — the same shape under `processed_triplets`, whose units carry a
 * perspective slug as well: `"key|itype|slug"`.
 *
 * `batch_embed_image` — the same shape, with `processed_pairs` holding bare
 * catalog keys. Field name is legacy; renaming would strand existing checkpoints.
 *
 * `batch_stack_detect` — bare catalog keys under `processed_image_keys`. Same
 * legacy field name.
 *
 * `batch_cull_photos_before_scoring` — `fingerprint`, `done_by_stage` (stage key → photos answered
 * for it so far), `failed_keys` (photos Laya failed on, left pending; a resumed run skips them, a
 * fresh job retries them), `total_at_start`. No list of finished photos: their stored answers are
 * what a restart skips.
 *
 * `batch_analyze` — the composite, and the one that is not flat: `stage` names the
 * pass that is running, and `describe` / `score` each hold a body of the shape
 * above. Two fingerprints rather than one because the stages are resumable
 * independently — a run interrupted during scoring must not re-describe.
 */
import { CLIP_EMBED_DIM, CLIP_EMBED_MODEL_ID } from '../imaging/clip-embed.js';
import { canonicalJson } from '../utils/canonical-json.js';

export const CHECKPOINT_VERSION = 1;

/** Refuse to grow a checkpoint past this; `jobs.metadata` is one JSON column. */
export const CHECKPOINT_MAX_ENTRIES = 100_000;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Coerce a metadata value to an int, or `null` when it is not one. */
function asIntOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Sorted `perspective_slugs`, or `null` when the list is absent or empty. */
function perspectiveSlugsFingerprint(metadata: Record<string, unknown>): string[] | null {
  const raw = metadata['perspective_slugs'];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw.map((x) => String(x)).sort();
}

/** Identity of a `batch_describe` run: its knobs plus the ordered work list. */
export function fingerprintBatchDescribe(
  metadata: Record<string, unknown>,
  orderedPairs: readonly (readonly [string, string])[],
): Promise<string> {
  return sha256Hex(
    canonicalJson({
      backfill_visual_tags: Boolean(metadata['backfill_visual_tags']),
      date_filter: metadata['date_filter'] ?? 'all',
      force: Boolean(metadata['force']),
      image_type: metadata['image_type'] ?? 'catalog',
      max_workers: asIntOrNull(metadata['max_workers'] ?? 4) ?? 4,
      min_rating: asIntOrNull(metadata['min_rating']),
      pairs: orderedPairs.map(([key, itype]) => `${key}|${itype}`),
      perspective_slugs: perspectiveSlugsFingerprint(metadata),
      provider_id: metadata['provider_id'] ?? null,
      provider_model: metadata['provider_model'] ?? null,
    }),
  );
}

/**
 * Identity of a `batch_score` run: its knobs plus the sorted work triples.
 *
 * The unit is `key|itype|slug`, not `key|itype`, because one image is scored once
 * per perspective and each of those is separately resumable. Activating a
 * perspective mid-run therefore changes the fingerprint, which is the point: the
 * checkpoint's "done" set says nothing about the rubric that just appeared.
 */
export function fingerprintBatchScore(
  metadata: Record<string, unknown>,
  workTriples: readonly (readonly [string, string, string])[],
): Promise<string> {
  return sha256Hex(
    canonicalJson({
      date_filter: metadata['date_filter'] ?? 'all',
      force: Boolean(metadata['force']),
      image_type: metadata['image_type'] ?? 'catalog',
      max_workers: asIntOrNull(metadata['max_workers'] ?? 4) ?? 4,
      min_rating: asIntOrNull(metadata['min_rating']),
      perspective_slugs: perspectiveSlugsFingerprint(metadata),
      provider_id: metadata['provider_id'] ?? null,
      provider_model: metadata['provider_model'] ?? null,
      triples: workTriples.map(([key, itype, slug]) => `${key}|${itype}|${slug}`).sort(),
    }),
  );
}

/**
 * Identity of a `batch_embed_image` run.
 *
 * The date window arrives already resolved rather than being re-read from the
 * metadata, because the same window has several spellings — `date_filter:
 * '3months'` and `last_months: 3` mean one thing — and fingerprinting the raw
 * text would discard a checkpoint over a change of wording.
 *
 * The model id and dimension are in the payload because a re-embed under a
 * different model is a different run: resuming across that would leave the table
 * holding two incompatible vector spaces.
 */
export function fingerprintBatchEmbedImage(
  metadata: Record<string, unknown>,
  orderedKeys: readonly string[],
  window: { resolvedMonths: number | null; resolvedYear: string | null },
): Promise<string> {
  return sha256Hex(
    canonicalJson({
      embedding_dim: CLIP_EMBED_DIM,
      embedding_model_id: CLIP_EMBED_MODEL_ID,
      force: Boolean(metadata['force']),
      image_type: 'catalog',
      min_rating: asIntOrNull(metadata['min_rating']),
      pairs: [...orderedKeys].sort(),
      resolved_months: window.resolvedMonths,
      resolved_year: window.resolvedYear,
    }),
  );
}

/**
 * Identity of a `batch_stack_detect` run: the work list, the burst gap, and the
 * force mode.
 *
 * The gap and the mode arrive resolved, not read from the metadata, because both
 * have a default the metadata does not spell — `delta_ms` falls back to
 * `config.yaml` and an absent `force` means `incremental`. A run resumed after the
 * config changed is a different grouping of the same photos, so it must not match.
 */
export function fingerprintBatchStackDetect(
  imageKeys: readonly string[],
  opts: { resolvedDeltaMs: number; forceMode: string },
): Promise<string> {
  return sha256Hex(
    canonicalJson({
      delta_ms: Math.trunc(opts.resolvedDeltaMs),
      force_mode: String(opts.forceMode),
      keys: [...imageKeys].sort(),
    }),
  );
}

/**
 * Identity of a `catalog_cache_build` run: the knobs its four stages read.
 *
 * No key list, unlike every other fingerprint here, because each stage selects
 * its own and all four move with the catalog — a chain identified by them would
 * have a different identity on every run. Nothing resumes on this: the chain
 * keeps no checkpoint, and the value exists so a completed run's result says
 * which set of knobs produced it.
 */
export function fingerprintCatalogCacheBuild(
  metadata: Record<string, unknown>,
  window: { resolvedMonths: number | null; resolvedYear: string | null },
): Promise<string> {
  return sha256Hex(
    canonicalJson({
      embedding_dim: CLIP_EMBED_DIM,
      embedding_model_id: CLIP_EMBED_MODEL_ID,
      force_embed: Boolean(metadata['force_embed']),
      force_similarity: Boolean(metadata['force_similarity']),
      force_stack: Boolean(metadata['force_stack']),
      image_type: 'catalog',
      last_months: metadata['last_months'] ?? null,
      min_rating: asIntOrNull(metadata['min_rating']),
      month: metadata['month'] ?? null,
      resolved_months: window.resolvedMonths,
      resolved_year: window.resolvedYear,
      year: metadata['year'] ?? null,
    }),
  );
}

/**
 * Identity of a cull run: the stage versions and the pipeline-setting version (a change starts over,
 * ticket 16), plus the scope. Not the work list: it shrinks as answers are stored, and the stored
 * answers are what make a restart skip finished photos.
 */
export function fingerprintBatchCull(args: {
  stageVersions: Record<string, number>;
  pipelineSettingVersion: number;
  imageKeys: readonly string[] | null;
  resolvedMonths: number | null;
  resolvedYear: string | null;
  minRating: number | null;
}): Promise<string> {
  return sha256Hex(
    canonicalJson({
      image_keys: args.imageKeys ? [...args.imageKeys].sort() : null,
      min_rating: args.minRating,
      pipeline_setting_version: args.pipelineSettingVersion,
      resolved_months: args.resolvedMonths,
      resolved_year: args.resolvedYear,
      stage_versions: args.stageVersions,
    }),
  );
}

export interface CullResumeState {
  doneByStage: Record<string, number>;
  failed: Set<string>;
  /** From the checkpoint a run resumed from; null on a fresh run. */
  totalAtStart: number | null;
}

export function buildBatchCullCheckpointBody(args: {
  fingerprint: string;
  state: CullResumeState;
  totalAtStart: number;
  log?: (message: string) => void;
}): Record<string, unknown> {
  const failed = [...args.state.failed].sort();
  if (failed.length > CHECKPOINT_MAX_ENTRIES) {
    args.log?.(`checkpoint: ${failed.length} failed photos, keeping the first ${CHECKPOINT_MAX_ENTRIES}`);
  }
  return {
    job_type: 'batch_cull_photos_before_scoring',
    fingerprint: args.fingerprint,
    done_by_stage: { ...args.state.doneByStage },
    failed_keys: failed.slice(0, CHECKPOINT_MAX_ENTRIES),
    total_at_start: args.totalAtStart,
  };
}

/** The cull's resume state, or an empty one; logs the mismatch when the fingerprint changed. */
export function loadCullResumeState(args: {
  metadata: Record<string, unknown>;
  fingerprint: string;
  mismatchMessage: string;
  log: (message: string) => void;
}): CullResumeState {
  const empty: CullResumeState = { doneByStage: {}, failed: new Set(), totalAtStart: null };
  const body = checkpointBody(args.metadata, 'batch_cull_photos_before_scoring');
  if (body === null) return empty;
  if (body['fingerprint'] !== args.fingerprint) {
    if (body['fingerprint']) args.log(args.mismatchMessage);
    return empty;
  }
  const done = asBody(body['done_by_stage']);
  const failed = body['failed_keys'];
  return {
    doneByStage: Object.fromEntries(
      Object.entries(done).map(([stage, n]) => [stage, typeof n === 'number' ? n : 0]),
    ),
    failed: new Set(Array.isArray(failed) ? failed.map((k) => String(k)) : []),
    totalAtStart: typeof body['total_at_start'] === 'number' ? body['total_at_start'] : null,
  };
}

export function buildBatchDescribeCheckpointBody(args: {
  fingerprint: string;
  processed: ReadonlySet<string>;
  totalAtStart: number;
}): Record<string, unknown> {
  return {
    job_type: 'batch_describe',
    fingerprint: args.fingerprint,
    processed_pairs: [...args.processed].sort(),
    total_at_start: args.totalAtStart,
  };
}

export function buildBatchScoreCheckpointBody(args: {
  fingerprint: string;
  processed: ReadonlySet<string>;
  totalAtStart: number;
}): Record<string, unknown> {
  return {
    job_type: 'batch_score',
    fingerprint: args.fingerprint,
    processed_triplets: [...args.processed].sort(),
    total_at_start: args.totalAtStart,
  };
}

export function buildBatchEmbedImageCheckpointBody(args: {
  fingerprint: string;
  processed: ReadonlySet<string>;
  totalAtStart: number;
}): Record<string, unknown> {
  return {
    job_type: 'batch_embed_image',
    fingerprint: args.fingerprint,
    processed_pairs: [...args.processed].sort(),
    total_at_start: args.totalAtStart,
  };
}

export function buildBatchStackDetectCheckpointBody(args: {
  fingerprint: string;
  processed: ReadonlySet<string>;
  totalAtStart: number;
}): Record<string, unknown> {
  return {
    job_type: 'batch_stack_detect',
    fingerprint: args.fingerprint,
    processed_image_keys: [...args.processed].sort(),
    total_at_start: args.totalAtStart,
  };
}

/** The two passes `batch_analyze` composes, and the two checkpoint sub-objects. */
export type AnalyzeStage = 'describe' | 'score';

export interface AnalyzeCheckpoint {
  /** The pass that was running when the checkpoint was written, if any. */
  stage: AnalyzeStage | null;
  describe: Record<string, unknown>;
  score: Record<string, unknown>;
}

const EMPTY_ANALYZE_CHECKPOINT: AnalyzeCheckpoint = { stage: null, describe: {}, score: {} };

/** The `batch_analyze` checkpoint, or empty sub-objects when there is none. */
export function readAnalyzeCheckpoint(metadata: Record<string, unknown>): AnalyzeCheckpoint {
  const body = checkpointBody(metadata, 'batch_analyze');
  if (body === null) return EMPTY_ANALYZE_CHECKPOINT;
  const stage = body['stage'];
  return {
    stage: stage === 'describe' || stage === 'score' ? stage : null,
    describe: asBody(body['describe']),
    score: asBody(body['score']),
  };
}

/**
 * Minimal runner surface `persistAnalyzeStageCheckpoint` needs, so this module
 * stays free of a dependency on the runner it is imported by.
 */
interface CheckpointWriter {
  readMetadata(jobId: string): Record<string, unknown>;
  persistCheckpoint(jobId: string, body: Record<string, unknown>): void;
}

/**
 * Write one stage's resume state into the composite checkpoint, preserving the
 * other stage's.
 *
 * Read-modify-write rather than a merge inside `persistCheckpoint`, which knows
 * nothing about stages. It is safe here because the passes are sequential: by the
 * time score is writing, describe's sub-object has stopped changing.
 */
export function persistAnalyzeStageCheckpoint(
  runner: CheckpointWriter,
  jobId: string,
  stage: AnalyzeStage,
  payload: Record<string, unknown>,
): void {
  const existing = readAnalyzeCheckpoint(runner.readMetadata(jobId));
  runner.persistCheckpoint(jobId, {
    job_type: 'batch_analyze',
    stage,
    describe: stage === 'describe' ? payload : existing.describe,
    score: stage === 'score' ? payload : existing.score,
  });
}

/** One stage's own body, the same shape its standalone job would checkpoint. */
export function buildAnalyzeStagePayload(args: {
  fingerprint: string;
  processed: ReadonlySet<string>;
  totalAtStart: number;
  resumeKey: ResumeKey;
}): Record<string, unknown> {
  return {
    fingerprint: args.fingerprint,
    [args.resumeKey]: [...args.processed].sort(),
    total_at_start: args.totalAtStart,
  };
}

/** Which array in a checkpoint body holds the processed units. */
export type ResumeKey = 'processed_pairs' | 'processed_triplets' | 'processed_image_keys';

export interface LoadResumeStateArgs {
  metadata: Record<string, unknown>;
  jobType: string;
  resumeKey: ResumeKey;
  fingerprint: string;
  /** Logged when a checkpoint exists but was built from different inputs. */
  mismatchMessage: string | null;
  log: (message: string) => void;
  /**
   * Read from this sub-object of a `batch_analyze` checkpoint instead of the
   * root, for a pass running as a stage rather than as its own job.
   */
  analyzeStage?: AnalyzeStage;
}

/**
 * The processed-unit set to resume from, or an empty set.
 *
 * Silent on a missing or stale-version checkpoint — there is nothing to tell the
 * user. Loud on a fingerprint mismatch, because that one means work they expected
 * to be skipped is about to be redone.
 */
export function loadResumeState(args: LoadResumeStateArgs): Set<string> {
  const body =
    args.analyzeStage === undefined
      ? checkpointBody(args.metadata, args.jobType)
      : readAnalyzeCheckpoint(args.metadata)[args.analyzeStage];
  if (body === null) return new Set();

  if (body['fingerprint'] === args.fingerprint) {
    const units = body[args.resumeKey];
    return new Set(Array.isArray(units) ? units.map((u) => String(u)) : []);
  }
  if (body['fingerprint'] && args.mismatchMessage) args.log(args.mismatchMessage);
  return new Set();
}

/** A current-version checkpoint of `jobType`, or `null`. */
function checkpointBody(
  metadata: Record<string, unknown>,
  jobType: string,
): Record<string, unknown> | null {
  const chk = metadata['checkpoint'];
  if (!chk || typeof chk !== 'object' || Array.isArray(chk)) return null;
  const body = chk as Record<string, unknown>;
  if (body['checkpoint_version'] !== CHECKPOINT_VERSION) return null;
  if (body['job_type'] !== jobType) return null;
  return body;
}

function asBody(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
