/**
 * Score job handlers.
 *
 * The unit of work is an image × perspective pair, and the two handlers disagree
 * on what a failure means. `single_score` stops at the first one, because a
 * partially-scored image is worse than an unscored one: the identity aggregate
 * would then average a subset of the rubric without saying so. `batch_score`
 * counts it and moves on, and only gives up after ten in a row — over a catalog,
 * one unreadable file is not evidence that the provider is down.
 */
import type { JobLogLevel } from '../../db/jobs/jobs.js';
import { getPerspectiveBySlug, listPerspectives } from '../../db/library/scores.js';
import { staleScoreLabels } from '../../db/library/vision-stale.js';
import type { CancelCheck } from '../../providers/retry.js';
import { computePromptVersion, scoreImageForPerspective } from '../../vision/scoring-service.js';
import { VisionOpOutcome } from '../../vision/vision-op.js';
import type { Db } from '../../db/connection.js';
import {
  CHECKPOINT_MAX_ENTRIES,
  buildAnalyzeStagePayload,
  buildBatchScoreCheckpointBody,
  fingerprintBatchScore,
  loadResumeState,
  persistAnalyzeStageCheckpoint,
  readDescribeScoreCullSubObject,
} from '../checkpoint.js';
import type { JobRunner } from '../runner.js';
import { performance } from 'node:perf_hooks';
import {
  asMetadata,
  cullStep,
  failureSeverityFromError,
  jobLogLevel,
  mapPassProgress,
  OWN_JOB,
  readIntOrNull,
  resolveDateWindow,
  resolveLibraryDbOrFail,
  selectCatalogKeys,
  withLibraryDb,
  type PassContext,
} from './common.js';
import { runCullStageBeforeDescribeAndScore, type CullHeldBackCounts } from './cull-stage.js';
import type { BatchCullResult } from './cull-pass.js';
import { selectKeysWithScoreWork } from './work-keys.js';
import { PathSkipDiagnostics, emptySkipReasonCounts } from './path-diagnostics.js';

/** Score one image for one perspective, turning a thrown error into an outcome. */
export async function scoreSingleImage(
  db: Db,
  key: string,
  perspectiveSlug: string,
  opts: {
    force: boolean;
    providerId?: string | null;
    model?: string | null;
    logCallback?: (level: string, message: string) => void;
    cancelCheck?: CancelCheck;
  },
): Promise<VisionOpOutcome> {
  try {
    return await scoreImageForPerspective(db, key, perspectiveSlug, {
      force: opts.force,
      providerId: opts.providerId ?? null,
      model: opts.model ?? null,
      logCallback: opts.logCallback ?? null,
      cancelCheck: opts.cancelCheck ?? null,
    });
  } catch (e) {
    return new VisionOpOutcome('failed', e instanceof Error ? e.message : String(e));
  }
}

/**
 * Read the perspectives a job should score.
 *
 * An explicit list is taken as given — including perspectives that are inactive,
 * which `scoreImageForPerspective` then rejects — while the default is every
 * active one. Asking for nothing is an error rather than a no-op success, because
 * "scored 0 perspectives" reported as done looks identical to a scored image.
 */
export function resolveScoreSlugs(db: Db, metadata: Record<string, unknown>): string[] {
  const raw = metadata['perspective_slugs'];
  if (Array.isArray(raw) && raw.length > 0) return raw.map((x) => String(x));
  return listPerspectives(db, { activeOnly: true }).map((p) => p.slug);
}

/** Score a single image for one or more perspectives, as an async job. */
export async function handleSingleScore(
  runner: JobRunner,
  jobId: string,
  rawMetadata: unknown,
): Promise<void> {
  const metadata = asMetadata(rawMetadata);
  try {
    const imageKey = metadata['image_key'];
    const imageType = String(metadata['image_type'] ?? 'catalog');
    const force = Boolean(metadata['force']);
    const providerId = (metadata['provider_id'] as string | null | undefined) ?? null;
    const providerModel = (metadata['provider_model'] as string | null | undefined) ?? null;

    if (typeof imageKey !== 'string' || !imageKey) {
      runner.failJob(jobId, 'image_key is required in metadata');
      return;
    }
    if (imageType !== 'catalog') {
      runner.failJob(jobId, 'image_type must be catalog');
      return;
    }

    const dbPath = resolveLibraryDbOrFail(runner, jobId);
    if (dbPath === null) return;

    await withLibraryDb(dbPath, async (db) => {
      const slugs = resolveScoreSlugs(db, metadata);
      if (slugs.length === 0) {
        runner.failJob(
          jobId,
          'No perspectives to score (provide perspective_slugs or activate perspectives)',
        );
        return;
      }

      runner.updateProgress(jobId, 10, `Scoring ${imageType} image…`);

      const diag = new PathSkipDiagnostics(runner, jobId, db, { jobLabel: 'single_score' });
      await diag.runPreflight([imageKey]);

      let scored = 0;
      let skipped = 0;

      for (const slug of slugs) {
        const outcome = await scoreSingleImage(db, imageKey, slug, {
          force,
          providerId,
          model: providerModel,
          logCallback: (level, message) => runner.log(jobId, jobLogLevel(level), message),
        });

        if (outcome.wrote) {
          scored += 1;
        } else if (outcome.status === 'skipped') {
          skipped += 1;
        } else {
          runner.failJob(jobId, outcome.reason || `Scoring failed for perspective '${slug}'`);
          return;
        }
      }

      runner.completeJob(jobId, {
        image_key: imageKey,
        image_type: imageType,
        scored,
        skipped,
        // Always zero on this path: a failure returns above. The key stays in the
        // payload because the UI reads it.
        failed: 0,
        skip_reason_counts: diag.skipReasonCounts,
      });
    });
  } catch (e) {
    runner.failJob(jobId, e instanceof Error ? e.message : String(e), failureSeverityFromError(e));
  }
}

/** Logged when a resumed `batch_score` checkpoint no longer fits the inputs. */
export const BATCH_SCORE_CHECKPOINT_MISMATCH =
  'checkpoint mismatch: batch_score fingerprint changed, starting fresh';

/** Give up once this many scores fail back to back; the provider is down. */
const CONSECUTIVE_FAILURE_LIMIT = 10;

export interface BatchScoreResult {
  scored: number;
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

/** Score catalog images in bulk: one vision call per image × perspective. */
export async function handleBatchScore(
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

      const { months, year } = resolveDateWindow(metadata);
      const minRating = readIntOrNull(metadata['min_rating']);

      // Every image in the window, `force` or not — where describe narrows to the
      // undescribed ones. A score is per rubric version, so whether an image is
      // already done depends on perspectives this query knows nothing about; the
      // pre-filter in `runScorePass` decides it once the triples exist.
      const selection = selectCatalogKeys(db, {
        months,
        year,
        minRating,
        undescribedOnly: false,
        excludeVoidSubstance: true,
      });

      const tJob = performance.now();
      const workKeys = selectKeysWithScoreWork(db, metadata, selection);
      const stage = await runCullStageBeforeDescribeAndScore(
        runner,
        jobId,
        metadata,
        db,
        workKeys,
        selection,
        cullStep([0, 30], '', 'batch_score'),
      );
      if (stage === null) return;
      const passCtx: PassContext = { ...OWN_JOB, progressRange: [30, 100], settle: 'stage' };
      const tScore = performance.now();
      const summary = (await runScorePass(runner, jobId, metadata, db, stage.keptPairs, passCtx)) ?? null;
      if (summary === null) return;
      const scoreS = Math.round((performance.now() - tScore) / 10) / 100;
      runner.clearCheckpoint(jobId);
      runner.completeJob(jobId, {
        ...summary,
        cull: {
          culled: stage.cullStep.culled,
          redecided: stage.cullStep.redecided,
          failed: stage.cullStep.failed,
          cut_by_culling_recipe: stage.cullStep.cut_by_culling_recipe,
          cut_by_score_forecast: stage.cullStep.cut_by_score_forecast,
          pending: stage.cullStep.pending,
          sent: stage.cullStep.sent,
          sent_by_hand_passed: stage.cullStep.sent_by_hand_passed,
          score_forecast: stage.cullStep.score_forecast,
          pipeline_setting_version: stage.cullStep.pipeline_setting_version,
          seconds_per_photo: stage.cullStep.seconds_per_photo,
          laya_started: stage.cullStep.laya_started,
        },
        held_back: stage.heldBack,
        durations_s: {
          frame_substance: stage.durations.frame_substance,
          cull: stage.durations.cull,
          describe: 0,
          score: scoreS,
          total: Math.round((performance.now() - tJob) / 10) / 100,
        },
      });
    });
  } catch (e) {
    runner.failJob(jobId, e instanceof Error ? e.message : String(e), failureSeverityFromError(e));
  }
}

/**
 * `key|itype|slug` for every current score standing at its slug's live rubric.
 *
 * Matching on `prompt_version` is what makes an edited perspective re-score: the
 * old rows stay current under the old hash and simply stop matching.
 */
function currentScoreLabels(
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
    for (const r of rows) labels.add(`${r.image_key}|${r.image_type}|${slug}`);
  }
  return labels;
}

/** Logged when a `batch_analyze` resumes onto a score selection that moved. */
export const ANALYZE_SCORE_CHECKPOINT_MISMATCH =
  'checkpoint mismatch: batch_analyze score fingerprint changed, starting score fresh';

/**
 * Score every image × perspective in `selection`, checkpointing as it goes.
 *
 * Returns the summary when running as a stage of `batch_analyze`, and `null`
 * whenever the job has already been settled, exactly as `runDescribePass` does.
 *
 * Concurrency is a bounded async pool over one connection: time is spent waiting on
 * the provider's HTTP response, not on CPU or SQLite.
 */
export async function runScorePass(
  runner: JobRunner,
  jobId: string,
  metadata: Record<string, unknown>,
  db: Db,
  selection: readonly (readonly [string, string])[],
  ctx: PassContext,
): Promise<BatchScoreResult | null> {
  const prefix = ctx.logPrefix;
  const log = (level: JobLogLevel, message: string): void =>
    runner.log(jobId, level, `${prefix}${message}`);
  const progress = (pct: number, message: string): void =>
    runner.updateProgress(jobId, mapPassProgress(ctx, pct), `${prefix}${message}`);

  const imageType = String(metadata['image_type'] ?? 'catalog');
  const dateFilter = String(metadata['date_filter'] ?? 'all');
  const redoUnlessModel = String(metadata['redo_unless_model'] ?? '').trim() || null;
  // A model-scoped re-do means "replace what the other model wrote", so it implies
  // a per-item force: every triple that survives its filter is one whose current
  // row has to go. That is also why it overrides a blanket `force` of false.
  const force = Boolean(metadata['force']) || redoUnlessModel !== null;
  const providerId = (metadata['provider_id'] as string | null | undefined) ?? null;
  const providerModel = (metadata['provider_model'] as string | null | undefined) ?? null;
  const maxWorkers = Math.max(1, readIntOrNull(metadata['max_workers']) ?? 4);

  const slugs = resolveScoreSlugs(db, metadata);
  const workTriples: [string, string, string][] = selection.flatMap(([key, itype]) =>
    slugs.map((slug): [string, string, string] => [key, itype, slug]),
  );

  const totalAtStart = workTriples.length;
  const fingerprint = await fingerprintBatchScore(metadata, workTriples);
  const processedTriplets = loadResumeState({
    metadata: runner.readMetadata(jobId),
    jobType: 'batch_score',
    resumeKey: 'processed_triplets',
    fingerprint,
    mismatchMessage:
      ctx.checkpoint.mode === 'nested' ? ANALYZE_SCORE_CHECKPOINT_MISMATCH : BATCH_SCORE_CHECKPOINT_MISMATCH,
    log: (message) => log('info', message),
    analyzeStage: ctx.checkpoint.mode === 'nested' ? ctx.checkpoint.key : undefined,
  });

  const tripletLabel = (key: string, itype: string, slug: string): string =>
    `${key}|${itype}|${slug}`;
  let pending = workTriples.filter(([k, t, s]) => !processedTriplets.has(tripletLabel(k, t, s)));

  const promptVersions = new Map<string, string>();
  for (const slug of slugs) {
    const row = getPerspectiveBySlug(db, slug);
    if (row) promptVersions.set(slug, computePromptVersion(row));
  }

  // Made from a since-turned cache image: not done, whatever `image_scores` says.
  const stale = staleScoreLabels(db);
  const isDone = (done: Set<string>, [k, t, s]: [string, string, string]): boolean =>
    done.has(tripletLabel(k, t, s)) && !stale.has(`${k}|${s}`);

  // A pre-filter in SQL rather than a skip per triple: on a catalog that is mostly
  // scored this turns tens of thousands of provider round-trips into none.
  if (!force && pending.length > 0 && promptVersions.size > 0) {
    const done = currentScoreLabels(db, promptVersions, null);
    const before = pending.length;
    pending = pending.filter((triple) => !isDone(done, triple));
    const skippedByDb = before - pending.length;
    if (skippedByDb) {
      log('info', `Skipped ${skippedByDb} already-scored triplets (DB pre-filter)`);
    }
  }

  if (redoUnlessModel !== null && pending.length > 0 && promptVersions.size > 0) {
    const done = currentScoreLabels(db, promptVersions, redoUnlessModel);
    const before = pending.length;
    pending = pending.filter((triple) => !isDone(done, triple));
    log(
      'info',
      `model-scoped re-do (redo_unless_model=${redoUnlessModel}): skipped ` +
        `${before - pending.length} triples already scored by this model; ` +
        'force-rescoring the rest',
    );
  }

  const total = pending.length;
  const alreadyDone = totalAtStart - total;
  const progressFor = (done: number): number =>
    Math.trunc(5 + (done / Math.max(totalAtStart, 1)) * 90);

  progress(progressFor(alreadyDone), `Found ${totalAtStart} scoring units (${total} remaining)`);

  if (totalAtStart === 0) {
    const empty: BatchScoreResult = {
      scored: 0,
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
      scored: 0,
      skipped: 0,
      failed: 0,
      total: 0,
      skip_reason_counts: emptySkipReasonCounts(),
    });
    return null;
  }

  const diag = new PathSkipDiagnostics(runner, jobId, db, {
    jobLabel: 'batch_score',
    logAction: 'score',
  });
  await diag.runPreflight([...new Set(pending.map(([k]) => k))]);

  let scored = 0;
  let skipped = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  let completed = 0;
  let stop = false;

  /**
   * Record a finished unit. Returns false when the checkpoint has outgrown what
   * belongs in one metadata column, which stops the run rather than letting the
   * jobs row grow without bound.
   */
  const recordDone = (key: string, itype: string, slug: string): boolean => {
    processedTriplets.add(tripletLabel(key, itype, slug));
    if (processedTriplets.size > CHECKPOINT_MAX_ENTRIES) {
      runner.failJob(jobId, 'checkpoint too large: exceeds 100000 entries');
      return false;
    }
    const { checkpoint } = ctx;
    if (checkpoint.mode === 'flat') {
      runner.persistCheckpoint(
        jobId,
        buildBatchScoreCheckpointBody({
          fingerprint,
          processed: processedTriplets,
          totalAtStart,
          cull: readDescribeScoreCullSubObject(runner.readMetadata(jobId), 'batch_score'),
        }),
      );
    } else if (checkpoint.mode === 'nested') {
      persistAnalyzeStageCheckpoint(
        runner,
        jobId,
        checkpoint.key,
        buildAnalyzeStagePayload({
          fingerprint,
          processed: processedTriplets,
          totalAtStart,
          resumeKey: 'processed_triplets',
        }),
      );
    }
    return true;
  };

  const cancelCheck: CancelCheck = () => runner.isCancelled(jobId);

  const next = (): [string, string, string] | undefined => (stop ? undefined : pending.shift());

  const worker = async (): Promise<void> => {
    for (let unit = next(); unit !== undefined; unit = next()) {
      const [key, itype, slug] = unit;
      if (runner.isCancelled(jobId)) {
        // Once, not once per worker: every worker in the pool sees the same flag.
        if (!stop) log('info', 'Batch score cancel noted; finishing already-running tasks');
        stop = true;
        return;
      }

      const outcome = await scoreSingleImage(db, key, slug, {
        force,
        providerId,
        model: providerModel,
        logCallback: (level, message) => log(jobLogLevel(level), message),
        cancelCheck,
      });

      completed += 1;
      progress(
        progressFor(alreadyDone + completed),
        `Scoring ${alreadyDone + completed}/${totalAtStart}: ${key}|${slug}`,
      );

      if (outcome.wrote) {
        scored += 1;
        consecutiveFailures = 0;
        if (!recordDone(key, itype, slug)) {
          stop = true;
          return;
        }
      } else if (outcome.status === 'skipped') {
        skipped += 1;
        const { reason, detail } = await diag.classify(key);
        if (reason) diag.recordSkip(reason, key, { detail, logPrefix: prefix });
        log('warning', `${key}|${slug}: ${outcome.reason}`);
        if (!recordDone(key, itype, slug)) {
          stop = true;
          return;
        }
      } else {
        failed += 1;
        consecutiveFailures += 1;
        log('warning', `${key}|${slug}: ${outcome.reason}`);
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

  if (scored === 0 && consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
    runner.failJob(
      jobId,
      `Aborted after ${consecutiveFailures} consecutive failures with 0 successful ` +
        'scores — check file paths and provider connectivity',
    );
    return null;
  }

  const summary: BatchScoreResult = {
    scored,
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
