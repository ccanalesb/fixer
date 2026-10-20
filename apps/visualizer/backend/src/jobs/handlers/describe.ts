/**
 * Describe job handlers.
 *
 * `describeMatchedImage` already reports `written` / `skipped` / `failed`, but a
 * skip carries no reason a user could act on — the service does not care *why* an
 * image was not describable, and the job does. `diagnoseDescribeSkip` re-walks the
 * same preconditions after the fact to turn "skipped" into "the NAS is not
 * mounted" or "that key is not in the catalog", which is the difference between a
 * log line worth reading and one worth ignoring.
 */
import { extname } from 'node:path';
import { existsSync } from 'node:fs';
import type { Db } from '../../db/connection.js';
import { getImage } from '../../db/library/catalog.js';
import { getImageDescription } from '../../db/library/descriptions.js';
import { isDescriptionStale } from '../../db/library/vision-stale.js';
import { VIDEO_EXTENSIONS } from '../../imaging/raw-decode.js';
import type { CancelCheck } from '../../providers/retry.js';
import { resolveFilepath } from '../../utils/path-resolve.js';
import {
  describeMatchedImage,
  describeRefusal,
  type DescribeTelemetry,
} from '../../vision/description-service.js';
import {
  CHECKPOINT_MAX_ENTRIES,
  buildAnalyzeStagePayload,
  buildBatchDescribeCheckpointBody,
  fingerprintBatchDescribe,
  loadResumeState,
  persistAnalyzeStageCheckpoint,
  readDescribeScoreCullSubObject,
} from '../checkpoint.js';
import type { JobRunner } from '../runner.js';
import {
  asMetadata,
  cullStep,
  failureSeverityFromError,
  mapPassProgress,
  OWN_JOB,
  readIntOrNull,
  resolveDateWindow,
  resolveLibraryDbOrFail,
  selectCatalogKeys,
  selectCatalogKeysMissingVisualTags,
  withLibraryDb,
  type PassContext,
} from './common.js';
import { cullStageJobResultFields, runCullStageBeforeDescribeAndScore, type CullHeldBackCounts } from './cull-stage.js';
import { filterPairsWithDescribeWork } from './work-keys.js';
import { selectKeysWithDescribeWork } from './work-keys.js';
import type { BatchCullResult } from './cull-pass.js';
import { performance } from 'node:perf_hooks';
import { PathSkipDiagnostics, emptySkipReasonCounts } from './path-diagnostics.js';

/** What a describe attempt did, in the vocabulary the job result reports. */
export type DescribeStatus = 'described' | 'skipped' | 'failed';

export interface DescribeAttempt {
  status: DescribeStatus;
  success: boolean;
  error: string | null;
}

/** A specific reason `describeMatchedImage` declined, for the job log. */
export function diagnoseDescribeSkip(db: Db, key: string, force: boolean): string {
  try {
    if (!force && getImageDescription(db, key) && !isDescriptionStale(db, key)) {
      return 'Already described (use force to regenerate)';
    }
    const image = getImage(db, key);
    if (!image) return 'Image key not found in catalog';
    const refused = describeRefusal(db, key);
    if (refused !== null) return refused;
    const filepath = typeof image['filepath'] === 'string' ? image['filepath'] : '';
    if (!filepath) return 'No filepath in catalog record';

    const resolved = resolveFilepath(filepath);
    if (VIDEO_EXTENSIONS.has(extname(resolved).toLowerCase())) {
      return `Video file not describable: ${resolved.split('/').pop() ?? resolved}`;
    }
    if (!existsSync(resolved)) return `File not found: ${resolved}`;
    return 'Model returned empty or invalid response';
  } catch (e) {
    return `No description generated (${e instanceof Error ? e.message : String(e)})`;
  }
}

/** Describe one image, mapping the outcome into `(status, success, error)`. */
export async function describeSingleImage(
  db: Db,
  key: string,
  opts: {
    force: boolean;
    providerId?: string | null;
    model?: string | null;
    cancelCheck?: CancelCheck;
    telemetry?: DescribeTelemetry | null;
  },
): Promise<DescribeAttempt> {
  try {
    const result = await describeMatchedImage(db, key, {
      force: opts.force,
      providerId: opts.providerId ?? null,
      model: opts.model ?? null,
      cancelCheck: opts.cancelCheck ?? null,
      telemetry: opts.telemetry ?? null,
    });

    if (result.status === 'written') return { status: 'described', success: true, error: null };
    if (result.status === 'failed') {
      return {
        status: 'failed',
        success: false,
        error: result.reason || 'model returned empty or invalid response',
      };
    }
    return {
      status: 'skipped',
      success: false,
      error: diagnoseDescribeSkip(db, key, opts.force),
    };
  } catch (e) {
    return { status: 'failed', success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Classify path accessibility for a skipped item, for the grouped counters. */
export async function recordPathSkipFromStatus(
  diag: PathSkipDiagnostics | null,
  key: string,
  status: DescribeStatus,
  logPrefix = '',
): Promise<void> {
  if (diag === null || status !== 'skipped') return;
  const { reason, detail } = await diag.classify(key);
  if (reason) diag.recordSkip(reason, key, { detail, logPrefix });
}

/** Generate an AI description for a single image, as an async job. */
export async function handleSingleDescribe(
  runner: JobRunner,
  jobId: string,
  rawMetadata: unknown,
): Promise<void> {
  const metadata = asMetadata(rawMetadata);
  try {
    const imageKey = metadata['image_key'];
    const imageType = (metadata['image_type'] as string | undefined) ?? 'catalog';
    const force = Boolean(metadata['force']);
    const providerId = (metadata['provider_id'] as string | null | undefined) ?? null;
    const providerModel = (metadata['provider_model'] as string | null | undefined) ?? null;

    if (typeof imageKey !== 'string' || !imageKey) {
      runner.failJob(jobId, 'image_key is required in metadata');
      return;
    }

    const dbPath = resolveLibraryDbOrFail(runner, jobId);
    if (dbPath === null) return;

    await withLibraryDb(dbPath, async (db) => {
      runner.updateProgress(jobId, 10, `Describing ${imageType} image…`);

      const diag = new PathSkipDiagnostics(runner, jobId, db, { jobLabel: 'single_describe' });
      await diag.runPreflight([imageKey]);

      const attempt = await describeSingleImage(db, imageKey, {
        force,
        providerId,
        model: providerModel,
      });

      if (attempt.success) {
        runner.completeJob(jobId, {
          image_key: imageKey,
          image_type: imageType,
          status: attempt.status,
          skip_reason_counts: diag.skipReasonCounts,
        });
        return;
      }

      await recordPathSkipFromStatus(diag, imageKey, attempt.status);
      runner.failJob(jobId, attempt.error || 'Description generation failed');
    });
  } catch (e) {
    runner.failJob(
      jobId,
      e instanceof Error ? e.message : String(e),
      failureSeverityFromError(e),
    );
  }
}

/** Logged when a resumed `batch_describe` checkpoint no longer fits the inputs. */
export const BATCH_DESCRIBE_CHECKPOINT_MISMATCH =
  'checkpoint mismatch: batch_describe fingerprint changed, starting fresh';

/** Give up once this many describes fail back to back; the provider is down. */
const CONSECUTIVE_FAILURE_LIMIT = 10;

const BACKFILL_FORCE_CONFLICT_MSG =
  'Backfill visual tags cannot be combined with force regenerate; ' +
  'force flag(s) are ignored. Only backfill image selection is used.';

export interface BatchDescribeResult {
  described: number;
  skipped: number;
  failed: number;
  total: number;
  image_type: string;
  date_filter: string;
  force: boolean;
  skip_reason_counts: Record<string, number>;
  cull?: Omit<BatchCullResult, 'total' | 'durations_s' | 'laya_seconds' | 'stage_versions'>;
  held_back?: CullHeldBackCounts;
  durations_s?: { frame_substance: number; cull: number; describe: number; score: number; total: number };
}

/** Generate AI descriptions for catalog images in bulk. */
export async function handleBatchDescribe(
  runner: JobRunner,
  jobId: string,
  rawMetadata: unknown,
): Promise<void> {
  const metadata = asMetadata(rawMetadata);
  try {
    const dbPath = resolveLibraryDbOrFail(runner, jobId);
    if (dbPath === null) return;

    await withLibraryDb(dbPath, async (db) => {
      const imageType = String(metadata['image_type'] ?? 'catalog');
      if (imageType !== 'catalog') {
        runner.failJob(jobId, 'image_type must be catalog');
        return;
      }

      const selection = selectDescribeCandidates(
        runner,
        jobId,
        db,
        metadata,
        Boolean(metadata['force']),
      );
      const tJob = performance.now();
      const workKeys = selectKeysWithDescribeWork(db, metadata, selection);
      const stage = await runCullStageBeforeDescribeAndScore(
        runner,
        jobId,
        metadata,
        db,
        workKeys,
        selection,
        cullStep([0, 30], '', 'batch_describe'),
      );
      if (stage === null) return;
      const passCtx: PassContext = { ...OWN_JOB, progressRange: [30, 100], settle: 'stage' };
      const tDescribe = performance.now();
      const summary =
        (await runDescribePass(runner, jobId, metadata, db, stage.keptPairs, passCtx)) ?? null;
      if (summary === null) return;
      const describeS = Math.round((performance.now() - tDescribe) / 10) / 100;
      runner.clearCheckpoint(jobId);
      runner.completeJob(jobId, {
        ...summary,
        ...cullStageJobResultFields(stage, { describe: describeS, score: 0 }, tJob),
      });
    });
  } catch (e) {
    runner.failJob(
      jobId,
      e instanceof Error ? e.message : String(e),
      failureSeverityFromError(e),
    );
  }
}

/**
 * The images a describe run should consider, given how hard it was told to look.
 *
 * Shared with `batch_analyze`, which selects once for both of its passes and
 * derives `force` from `force_describe` rather than `force`.
 */
export function selectDescribeCandidates(
  runner: JobRunner,
  jobId: string,
  db: Db,
  metadata: Record<string, unknown>,
  force: boolean,
): [string, string][] {
  // A model-scoped re-do has to widen the candidate set to every image, the same
  // way `force` does: rows written by an *older* model are described already, so
  // an undescribed-only selection would never surface them.
  const redoUnlessModel = String(metadata['redo_unless_model'] ?? '').trim() || null;
  const selectAll = force || redoUnlessModel !== null;
  const backfillVisualTags = Boolean(metadata['backfill_visual_tags']);

  const { months, year } = resolveDateWindow(metadata);
  const minRating = readIntOrNull(metadata['min_rating']);

  if (
    backfillVisualTags &&
    (metadata['force'] || metadata['force_describe'] || metadata['force_score'])
  ) {
    runner.log(jobId, 'warning', BACKFILL_FORCE_CONFLICT_MSG);
  }

  // Backfill uses missing visual tags; otherwise undescribed-only unless force/redo.
  const selection = backfillVisualTags
    ? selectCatalogKeysMissingVisualTags(db, { months, year, minRating })
    : selectCatalogKeys(db, { months, year, minRating, undescribedOnly: !selectAll });

  if (backfillVisualTags && selection.length === 0) {
    runner.log(
      jobId,
      'info',
      'Backfill visual tags: no images matched the current scope (no catalog rows ' +
        'with missing color/mood data in the date/rating window, or no work selected).',
    );
  }

  return selection;
}

/** Logged when a `batch_analyze` resumes onto a describe selection that moved. */
export const ANALYZE_DESCRIBE_CHECKPOINT_MISMATCH =
  'checkpoint mismatch: batch_analyze describe fingerprint changed, starting describe fresh';

/**
 * Describe every pair in `selection`, checkpointing as it goes.
 *
 * Returns the summary when running as a stage of `batch_analyze`, and `null`
 * whenever the job has already been settled — completed, cancelled or failed —
 * which is every path a standalone run takes.
 *
 * Concurrency is a bounded async pool over one connection: time is spent waiting on
 * the provider's HTTP response, not on CPU or SQLite.
 */
export async function runDescribePass(
  runner: JobRunner,
  jobId: string,
  metadata: Record<string, unknown>,
  db: Db,
  selection: readonly (readonly [string, string])[],
  ctx: PassContext,
): Promise<BatchDescribeResult | null> {
  const prefix = ctx.logPrefix;
  const log = (level: 'info' | 'warning' | 'error', message: string): void =>
    runner.log(jobId, level, `${prefix}${message}`);
  const progress = (pct: number, message: string): void =>
    runner.updateProgress(jobId, mapPassProgress(ctx, pct), `${prefix}${message}`);

  const imageType = String(metadata['image_type'] ?? 'catalog');
  const dateFilter = String(metadata['date_filter'] ?? 'all');
  const force = Boolean(metadata['force']);
  const redoUnlessModel = String(metadata['redo_unless_model'] ?? '').trim() || null;
  const backfillVisualTags = Boolean(metadata['backfill_visual_tags']);
  // Backfill and a model-scoped re-do both mean "overwrite the existing row", so
  // each implies a per-item force even when the blanket flag is off.
  const describeForce = force || backfillVisualTags || redoUnlessModel !== null;
  const providerId = (metadata['provider_id'] as string | null | undefined) ?? null;
  const providerModel = (metadata['provider_model'] as string | null | undefined) ?? null;
  const maxWorkers = Math.max(1, readIntOrNull(metadata['max_workers']) ?? 4);

  const totalAtStart = selection.length;
  const fingerprint = await fingerprintBatchDescribe(metadata, selection);
  const processedPairs = loadResumeState({
    metadata: runner.readMetadata(jobId),
    jobType: 'batch_describe',
    resumeKey: 'processed_pairs',
    fingerprint,
    mismatchMessage:
      ctx.checkpoint.mode === 'nested' ? ANALYZE_DESCRIBE_CHECKPOINT_MISMATCH : BATCH_DESCRIBE_CHECKPOINT_MISMATCH,
    log: (message) => log('info', message),
    analyzeStage: ctx.checkpoint.mode === 'nested' ? ctx.checkpoint.key : undefined,
  });

  const pairLabel = (key: string, itype: string): string => `${key}|${itype}`;
  let pending = selection.filter(([k, t]) => !processedPairs.has(pairLabel(k, t)));

  const beforeFilter = pending.length;
  pending = filterPairsWithDescribeWork(db, metadata, pending);
  const skippedByDb = beforeFilter - pending.length;
  if (skippedByDb && !backfillVisualTags && !force && redoUnlessModel === null) {
    log('info', `Skipped ${skippedByDb} already-described images (DB pre-filter)`);
  }
  if (skippedByDb && redoUnlessModel !== null) {
    log(
      'info',
      `model-scoped re-do (redo_unless_model=${redoUnlessModel}): skipped ${skippedByDb} images already described by this model; ` +
        'force-regenerating the rest',
    );
  }

  const total = pending.length;
  const alreadyDone = totalAtStart - total;
  const progressFor = (done: number): number =>
    Math.trunc(5 + (done / Math.max(totalAtStart, 1)) * 90);

  progress(progressFor(alreadyDone), `Found ${totalAtStart} images to describe (${total} remaining)`);

  if (totalAtStart === 0) {
    const empty: BatchDescribeResult = {
      described: 0,
      skipped: 0,
      failed: 0,
      total: 0,
      image_type: imageType,
      date_filter: dateFilter,
      force,
      skip_reason_counts: emptySkipReasonCounts(),
    };
    if (ctx.settle === 'stage') return empty;
    runner.clearCheckpoint(jobId);
    runner.completeJob(jobId, {
      described: 0,
      skipped: 0,
      failed: 0,
      total: 0,
      skip_reason_counts: emptySkipReasonCounts(),
    });
    return null;
  }

  const diag = new PathSkipDiagnostics(runner, jobId, db, {
    jobLabel: 'batch_describe',
    logAction: 'describe',
  });
  await diag.runPreflight(pending.map(([k]) => k));

  let described = 0;
  let skipped = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  let completed = 0;
  let stop = false;

  // Tracks how many images used an already-compressed preview instead of the original.
  const telemetry: DescribeTelemetry = { silentCompressionSkips: 0 };

  /**
   * Record a finished unit. Returns false when the checkpoint has outgrown what
   * belongs in one metadata column, which stops the run rather than letting the
   * jobs row grow without bound.
   */
  const recordDone = (key: string, itype: string): boolean => {
    processedPairs.add(pairLabel(key, itype));
    if (processedPairs.size > CHECKPOINT_MAX_ENTRIES) {
      runner.failJob(jobId, 'checkpoint too large: exceeds 100000 entries');
      return false;
    }
    const { checkpoint } = ctx;
    if (checkpoint.mode === 'flat') {
      runner.persistCheckpoint(
        jobId,
        buildBatchDescribeCheckpointBody({
          fingerprint,
          processed: processedPairs,
          totalAtStart,
          cull: readDescribeScoreCullSubObject(runner.readMetadata(jobId), 'batch_describe'),
        }),
      );
    } else if (checkpoint.mode === 'nested') {
      persistAnalyzeStageCheckpoint(
        runner,
        jobId,
        checkpoint.key,
        buildAnalyzeStagePayload({
          fingerprint,
          processed: processedPairs,
          totalAtStart,
          resumeKey: 'processed_pairs',
        }),
      );
    }
    return true;
  };

  const cancelCheck: CancelCheck = () => runner.isCancelled(jobId);

  const next = (): readonly [string, string] | undefined => (stop ? undefined : pending.shift());

  const worker = async (): Promise<void> => {
    for (let unit = next(); unit !== undefined; unit = next()) {
      const [key, itype] = unit;
      if (runner.isCancelled(jobId)) {
        // Once, not once per worker: every worker in the pool sees the same flag.
        if (!stop) log('info', 'Batch describe cancel noted; finishing already-running tasks');
        stop = true;
        return;
      }

      const attempt = await describeSingleImage(db, key, {
        force: describeForce,
        providerId,
        model: providerModel,
        cancelCheck,
        telemetry,
      });

      completed += 1;
      progress(
        progressFor(alreadyDone + completed),
        `Describing ${alreadyDone + completed}/${totalAtStart}: ${key}`,
      );

      if (attempt.status === 'described') {
        described += 1;
        consecutiveFailures = 0;
        if (!recordDone(key, itype)) {
          stop = true;
          return;
        }
      } else if (attempt.status === 'skipped') {
        skipped += 1;
        await recordPathSkipFromStatus(diag, key, attempt.status, prefix);
        log('warning', `${key}: ${attempt.error}`);
        if (!recordDone(key, itype)) {
          stop = true;
          return;
        }
      } else {
        failed += 1;
        consecutiveFailures += 1;
        log('warning', `${key}: ${attempt.error}`);
      }

      if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
        stop = true;
        log('error', `Stopping: ${consecutiveFailures} consecutive failures`);
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(maxWorkers, total) }, () => worker()));

  if (runner.isCancelled(jobId)) {
    runner.finalizeCancelled(jobId);
    return null;
  }
  // `recordDone` may already have failed the job; do not overwrite that outcome.
  if (runner.hasFailed(jobId)) return null;

  if (telemetry.silentCompressionSkips > 0) {
    log('info', `${telemetry.silentCompressionSkips} images already compressed, skipped.`);
  }

  if (described === 0 && consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
    runner.failJob(
      jobId,
      `Aborted after ${consecutiveFailures} consecutive failures with 0 successful ` +
        'descriptions — check file paths and provider connectivity',
    );
    return null;
  }

  const summary: BatchDescribeResult = {
    described,
    skipped,
    failed,
    total: totalAtStart,
    image_type: imageType,
    date_filter: dateFilter,
    force,
    skip_reason_counts: diag.skipReasonCounts,
  };
  if (ctx.settle === 'stage') return summary;
  runner.clearCheckpoint(jobId);
  runner.completeJob(jobId, summary);
  return null;
}
