/**
 * The cull job, `batch_cull_photos_before_scoring`: Laya answers every stage of the pipeline setting
 * for photos with no current verdict, and each photo's summary row is decided from the answers.
 *
 * Laya runs in its worker thread (ADR-0020): loaded at the start, after the start check, and freed at
 * the end whatever happens. The main thread only awaits it, reads one photo's stored answers, decides,
 * and writes one short transaction per photo, yielding between photos (ADR-0018).
 *
 * This module only orchestrates: which photos (`cull/select.ts`), one photo (`cull/answer-photo.ts`),
 * checkpoint, counts and the run row. `runCullPass` is the pass the jobs that send photos to kimi run
 * before describing (#339).
 */
import { performance } from 'node:perf_hooks';
import { config, loadLibraryConfig } from '../../config.js';
import { cullPhoto } from '../../cull/answer-photo.js';
import type { CullContext } from '../../cull/persist.js';
import { selectPhotosToCull } from '../../cull/select.js';
import { layaQuestionSet, resolveCurrentStages } from '../../cull/stages.js';
import type { CullSummaryVerdict, StageKind } from '../../cull/types.js';
import type { Db } from '../../db/connection.js';
import { getCurrentPipelineSetting } from '../../db/library/cull-pipeline.js';
import { seedCullingDefaults } from '../../db/library/cull-recipes.js';
import { listSentByHandKeys } from '../../db/library/cull-user-actions.js';
import { finishCullRun, getCullVerdict, insertCullRun } from '../../db/library/cull-verdicts.js';
import { libraryWrite } from '../../db/library/write.js';
import { resolveLayaModelFiles } from '../../laya/files.js';
import { readLayaModelIds } from '../../laya/model-id.js';
import { startLayaWithCheck } from '../../laya/runtime.js';
import { createEventLoopYieldState, pollCancelAndYield } from '../../utils/yield.js';
import {
  buildBatchCullCheckpointBody,
  fingerprintBatchCull,
  loadCullResumeState,
  type CullResumeState,
} from '../checkpoint.js';
import type { JobRunner } from '../runner.js';
import {
  asMetadata,
  failureSeverityFromError,
  mapPassProgress,
  OWN_JOB,
  readIntOrNull,
  resolveDateWindow,
  resolveLibraryDbOrFail,
  selectCatalogKeys,
  withLibraryDb,
  type PassContext,
} from './common.js';

export const BATCH_CULL_JOB_TYPE = 'batch_cull_photos_before_scoring';

/** Logged when a resumed cull checkpoint was made under other stage or pipeline-setting versions. */
export const BATCH_CULL_CHECKPOINT_MISMATCH =
  'checkpoint mismatch: batch_cull_photos_before_scoring stage or pipeline-setting version changed, starting fresh';

/** Photos between checkpoint writes; the stored answers already make a restart skip finished photos. */
const CHECKPOINT_EVERY = 20;

export interface BatchCullResult {
  /** Photos in scope: the window, minus videos and void frames. */
  total: number;
  /** Photos Laya answered in this run. */
  culled: number;
  /** Photos re-decided from stored answers, no model call. */
  redecided: number;
  /** Photos left pending: Laya failed on them or no image to read. Retried by the next job. */
  failed: number;
  cut_by_culling_recipe: number;
  cut_by_score_forecast: number;
  pending: number;
  sent: number;
  /** Sent only because the user sent them by hand: the stages alone would have cut them. */
  sent_by_hand_passed: number;
  score_forecast: 'on' | 'off';
  pipeline_setting_version: number;
  stage_versions: Record<string, number>;
  durations_s: { start_check: number; select: number; cull: number; total: number };
  laya_seconds: { prep: number; vision: number; base: number; new: number };
  seconds_per_photo: number | null;
}

/** Cull the catalog (or `metadata.image_keys`): every photo with no current verdict. */
export async function handleBatchCullPhotosBeforeScoring(
  runner: JobRunner,
  jobId: string,
  rawMetadata: unknown,
): Promise<void> {
  const metadata = asMetadata(rawMetadata);
  try {
    const dbPath = resolveLibraryDbOrFail(runner, jobId);
    if (dbPath === null) return;
    await withLibraryDb(dbPath, (db) => runCullPass(runner, jobId, metadata, db, OWN_JOB));
  } catch (e) {
    runner.failJob(jobId, e instanceof Error ? e.message : String(e), failureSeverityFromError(e));
  }
}

function readImageKeys(raw: unknown): string[] | null {
  return Array.isArray(raw) && raw.length > 0 ? raw.map((k) => String(k)) : null;
}

const seconds = (from: number): number => Math.round((performance.now() - from) / 10) / 100;

/**
 * Cull the photos in scope with no current verdict. Returns the summary as a stage of a composite
 * job, `null` when the job was settled here (completed or cancelled). A `LayaSetupError` from the
 * start check is thrown before anything is written.
 */
export async function runCullPass(
  runner: JobRunner,
  jobId: string,
  metadata: Record<string, unknown>,
  db: Db,
  ctx: PassContext,
  opts: { imageKeys?: readonly string[] } = {},
): Promise<BatchCullResult | null> {
  const t0 = performance.now();
  const prefix = ctx.logPrefix;
  const log = (message: string, level: 'info' | 'warning' = 'info'): void =>
    runner.log(jobId, level, `${prefix}[cull] ${message}`);
  const progress = (pct: number, message: string): void =>
    runner.updateProgress(jobId, mapPassProgress(ctx, pct), `${prefix}${message}`);

  seedCullingDefaults(db);
  const pipeline = getCurrentPipelineSetting(db);
  const modelsDir = loadLibraryConfig(config.LT_CONFIG_YAML).layaModelsDir;
  const files = resolveLayaModelFiles(modelsDir);
  const stages = resolveCurrentStages(db, pipeline.config, await readLayaModelIds(files));
  progress(1, 'Loading the cull models');
  const check = await startLayaWithCheck(modelsDir, layaQuestionSet(stages));
  const runtime = check.runtime;
  const startCheckS = seconds(t0);
  try {
    return await cullWithRuntime();
  } finally {
    await runtime.close();
  }

  async function cullWithRuntime(): Promise<BatchCullResult | null> {
    const cullCtx: CullContext = { stages, pipeline, scoreForecastAvailable: runtime.scoreForecastOn };
    const scoreForecast = cullCtx.scoreForecastAvailable && pipeline.config.score_forecast.enabled;
    const activeStages = stages.filter((s) => s.kind !== 'score_forecast' || scoreForecast);
    const stageVersions = Object.fromEntries(stages.map((s) => [s.stageKey, s.versionId]));
    log(
      `stages=${activeStages.map((s) => `${s.stageKey}@v${s.versionId}`).join(',')} ` +
        `pipeline_setting=v${pipeline.version} score_forecast=${scoreForecast ? 'on' : 'off'} ` +
        `models_loaded_s=${check.loadSeconds.toFixed(1)}`,
    );

    const tSelect = performance.now();
    const { months, year } = resolveDateWindow(metadata);
    const minRating = readIntOrNull(metadata['min_rating']);
    const scopeKeys = opts.imageKeys ?? readImageKeys(metadata['image_keys']);
    let keys = selectCatalogKeys(db, { months, year, minRating, undescribedOnly: false, excludeVoidSubstance: true }).map(
      ([k]) => k,
    );
    if (scopeKeys) {
      const scope = new Set(scopeKeys);
      keys = keys.filter((k) => scope.has(k));
    }
    const candidates = selectPhotosToCull(db, cullCtx, keys);

    const fingerprint = await fingerprintBatchCull({
      stageVersions,
      pipelineSettingVersion: pipeline.version,
      imageKeys: scopeKeys,
      resolvedMonths: months,
      resolvedYear: year,
      minRating,
    });
    const resume: CullResumeState =
      ctx.checkpoint.mode === 'flat'
        ? loadCullResumeState({
            metadata: runner.readMetadata(jobId),
            fingerprint,
            mismatchMessage: BATCH_CULL_CHECKPOINT_MISMATCH,
            log: (m) => runner.log(jobId, 'info', m),
          })
        : { doneByStage: {}, failed: new Set() };
    const work = candidates.filter((k) => !resume.failed.has(k));
    const selectS = seconds(tSelect);
    progress(3, `Found ${work.length} photos to cull of ${keys.length}`);

    const runId = libraryWrite(db, () =>
      insertCullRun(db, { kind: 'job', jobId, pipelineSettingVersion: pipeline.version }),
    );
    const persist = (): void => {
      if (ctx.checkpoint.mode !== 'flat') return;
      runner.persistCheckpoint(jobId, buildBatchCullCheckpointBody({ fingerprint, state: resume, totalAtStart: candidates.length }));
    };

    const sentByHand = listSentByHandKeys(db);
    const laya = { prep: 0, vision: 0, base: 0, new: 0 };
    const counts = {
      culled: 0,
      redecided: 0,
      failed: 0,
      cut_by_culling_recipe: 0,
      cut_by_score_forecast: 0,
      pending: 0,
      sent: 0,
      sent_by_hand_passed: 0,
    };
    const tally = (verdict: CullSummaryVerdict, cutBy: StageKind | null, sentByHandOverride: boolean): void => {
      if (verdict === 'pending') counts.pending += 1;
      else if (verdict === 'sent') counts.sent += 1;
      else if (cutBy === 'culling_recipe') counts.cut_by_culling_recipe += 1;
      else counts.cut_by_score_forecast += 1;
      if (sentByHandOverride) counts.sent_by_hand_passed += 1;
    };
    // Photos an earlier attempt of this run already failed on: skipped, but still in the counts.
    for (const key of candidates) {
      if (!resume.failed.has(key)) continue;
      counts.failed += 1;
      const v = getCullVerdict(db, key);
      if (v) tally(v.verdict, v.cut_by, false);
    }

    const tCull = performance.now();
    const yieldState = createEventLoopYieldState();
    try {
      for (const [i, key] of work.entries()) {
        if (await pollCancelAndYield(db, () => runner.isCancelled(jobId), yieldState)) {
          persist();
          libraryWrite(db, () => finishCullRun(db, runId, { status: 'cancelled', ...counts }));
          runner.finalizeCancelled(jobId);
          return null;
        }
        const r = await cullPhoto(db, cullCtx, runtime, { imageKey: key, sentByHand: sentByHand.has(key), runId });
        for (const k of Object.keys(laya) as (keyof typeof laya)[]) laya[k] += r.seconds[k];
        for (const stage of r.answeredStages) resume.doneByStage[stage] = (resume.doneByStage[stage] ?? 0) + 1;
        if (r.outcome === 'culled') counts.culled += 1;
        else if (r.outcome === 'redecided') counts.redecided += 1;
        else {
          counts.failed += 1;
          resume.failed.add(key);
          if (r.outcome === 'laya_failed') log(`${key} left pending, Laya failed on it: ${r.error!.message}`, 'warning');
        }
        tally(r.decision.verdict, r.decision.cutBy, r.decision.sentByHandOverride);
        if (r.outcome === 'worker_died') throw r.error!;
        if ((i + 1) % CHECKPOINT_EVERY === 0) persist();
        progress(3 + Math.trunc(((i + 1) / work.length) * 97), `Culled ${i + 1}/${work.length}`);
      }
    } catch (e) {
      persist();
      libraryWrite(db, () =>
        finishCullRun(db, runId, { status: 'failed', error: e instanceof Error ? e.message : String(e), ...counts }),
      );
      throw e;
    }

    const cullS = seconds(tCull);
    const result: BatchCullResult = {
      total: keys.length,
      ...counts,
      score_forecast: scoreForecast ? 'on' : 'off',
      pipeline_setting_version: pipeline.version,
      stage_versions: stageVersions,
      durations_s: { start_check: startCheckS, select: selectS, cull: cullS, total: seconds(t0) },
      laya_seconds: {
        prep: Math.round(laya.prep * 100) / 100,
        vision: Math.round(laya.vision * 100) / 100,
        base: Math.round(laya.base * 100) / 100,
        new: Math.round(laya.new * 100) / 100,
      },
      seconds_per_photo: counts.culled > 0 ? Math.round((cullS / counts.culled) * 100) / 100 : null,
    };
    libraryWrite(db, () => finishCullRun(db, runId, { status: 'complete', ...result }));
    log(
      `status=complete photos=${work.length} culled=${counts.culled} redecided=${counts.redecided} ` +
        `failed=${counts.failed} cut_recipe=${counts.cut_by_culling_recipe} ` +
        `cut_score_forecast=${counts.cut_by_score_forecast} pending=${counts.pending} sent=${counts.sent} ` +
        `sent_by_hand_passed=${counts.sent_by_hand_passed} score_forecast=${result.score_forecast} ` +
        `s_per_photo=${result.seconds_per_photo ?? '-'} duration_s=${result.durations_s.total}`,
    );
    if (ctx.settle === 'stage') return result;
    runner.clearCheckpoint(jobId);
    runner.completeJob(jobId, result);
    return null;
  }
}
