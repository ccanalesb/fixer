/**
 * Shared cull pass: each stage's model through System One, checkpoints, and per-photo work. Used by the standalone cull job
 * and the in-job cull step.
 */
import { performance } from 'node:perf_hooks';
import { cullPhoto } from '../../cull/answer-photo.js';
import { decidePhoto } from '../../cull/decide.js';
import { decideAndStorePhoto, type CullContext } from '../../cull/persist.js';
import { selectPhotosToCull } from '../../cull/select.js';
import { CullingModels, resolveStageModelIds, stageModelsFrom, stagesOn } from '../../cull/stage-models.js';
import { resolveLibraryStages, throwIfStageProblem } from '../../cull/stage-resolver.js';
import { syncCurrentStages } from '../../db/library/cull-sync-stages.js';
import type { PhotoDecision, StageKind } from '../../cull/types.js';
import { addDecision, emptyVerdictTally, type VerdictTally } from '../../cull/verdict-tally.js';
import type { Db } from '../../db/connection.js';
import { getCurrentPipelineSetting } from '../../db/library/cull-pipeline.js';
import { seedCullingDefaults } from '../../db/library/cull-profiles.js';
import { loadCurrentStageAnswers, readStoredStageModelIds } from '../../db/library/cull-stages.js';
import { listSentByHandKeys } from '../../db/library/sent-by-hand.js';
import { finishCullRun, getCullVerdict, insertCullRun, listCullRunIdsForJob } from '../../db/library/cull-verdicts.js';
import { libraryWrite } from '../../db/library/write.js';
import { createEventLoopYieldState, pollCancelAndYield } from '../../utils/yield.js';
import {
  buildBatchCullCheckpointBody,
  fingerprintBatchCull,
  loadCullResumeState,
  mergeDescribeScoreCullCheckpoint,
  persistAnalyzeStageCheckpoint,
  type CullResumeState,
} from '../checkpoint.js';
import type { JobRunner } from '../runner.js';
import {
  mapPassProgress,
  readIntOrNull,
  resolveDateWindow,
  selectCatalogKeys,
  type PassContext,
} from './common.js';

export const BATCH_CULL_CHECKPOINT_MISMATCH =
  'checkpoint mismatch: batch_cull_photos_before_scoring stage or pipeline-setting version changed, starting fresh';

const CHECKPOINT_EVERY = 20;

export interface BatchCullResult extends VerdictTally {
  total: number;
  culled: number;
  redecided: number;
  failed: number;
  score_forecast: 'on' | 'off';
  pipeline_setting_version: number;
  stage_versions: Record<string, number>;
  durations_s: { start_check: number; select: number; cull: number; total: number };
  /** Wall seconds spent on each stage's model calls. */
  stage_seconds: Record<StageKind, number>;
  seconds_per_photo: number | null;
  models_started: boolean;
}

function readImageKeys(raw: unknown): string[] | null {
  return Array.isArray(raw) && raw.length > 0 ? raw.map((k) => String(k)) : null;
}

const seconds = (from: number): number => Math.round((performance.now() - from) / 10) / 100;

export async function runCullPass(
  runner: JobRunner,
  jobId: string,
  metadata: Record<string, unknown>,
  db: Db,
  ctx: PassContext,
  opts: {
    imageKeys?: readonly string[];
    askModelsForSentByHand?: boolean;
    force?: boolean;
    /** Called with each photo's decision as it is counted. */
    onDecision?: (imageKey: string, decision: PhotoDecision) => void;
  } = {},
): Promise<BatchCullResult | null> {
  const t0 = performance.now();
  const prefix = ctx.logPrefix;
  const log = (message: string, level: 'info' | 'warning' = 'info'): void =>
    runner.log(jobId, level, `${prefix}[cull] ${message}`);
  const progress = (pct: number, message: string): void =>
    runner.updateProgress(jobId, mapPassProgress(ctx, pct), `${prefix}${message}`);

  seedCullingDefaults(db);
  const pipeline = getCurrentPipelineSetting(db);
  const on = stagesOn(pipeline.config);
  const resolved = resolveLibraryStages(db);
  throwIfStageProblem(resolved);
  const stageModels = stageModelsFrom(resolved);
  const modelIds = await resolveStageModelIds(stageModels, on, readStoredStageModelIds(db));
  const stages = syncCurrentStages(db, modelIds);

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

  const stageVersions = Object.fromEntries(stages.map((s) => [s.stageKey, s.versionId]));
  const fingerprint = await fingerprintBatchCull({
    stageVersions,
    pipelineSettingVersion: pipeline.version,
    imageKeys: scopeKeys,
    resolvedMonths: months,
    resolvedYear: year,
    minRating,
    force: opts.force ?? false,
  });

  const cp = ctx.checkpoint;
  const resume: CullResumeState =
    cp.mode === 'flat' || cp.mode === 'nested' || cp.mode === 'step'
      ? loadCullResumeState({
          metadata: runner.readMetadata(jobId),
          fingerprint,
          mismatchMessage: BATCH_CULL_CHECKPOINT_MISMATCH,
          log: (m) => runner.log(jobId, 'info', m),
          analyzeStage: cp.mode === 'nested' && cp.key === 'cull' ? 'cull' : undefined,
          stepHost: cp.mode === 'step' ? cp.host : undefined,
        })
      : { doneByStage: {}, failed: new Set(), totalAtStart: null };

  const scoreForecastAvailable = modelIds.score_forecast !== null;
  const cullCtx: CullContext = { stages, pipeline, scoreForecastAvailable };
  const scoreForecast = on.score_forecast;
  const activeStages = stages.filter((s) => on[s.kind]);
  const models = new CullingModels(stageModels, activeStages);
  const selected = selectPhotosToCull(db, cullCtx, keys, {
    force: opts.force ? { doneByRuns: listCullRunIdsForJob(db, jobId) } : undefined,
  });
  const candidates = selected.keys;
  const totalAtStart = resume.totalAtStart ?? candidates.length;
  const work = candidates.filter((k) => !resume.failed.has(k));
  const selectS = seconds(tSelect);
  progress(3, `Found ${work.length} photos to cull of ${keys.length}`);

  const runId = libraryWrite(db, () =>
    insertCullRun(db, { kind: 'job', jobId, pipelineSettingVersion: pipeline.version }),
  );

  const persist = (): void => {
    const body = buildBatchCullCheckpointBody({
      fingerprint,
      state: resume,
      totalAtStart,
      log: (m) => log(m, 'warning'),
    });
    if (cp.mode === 'flat') {
      runner.persistCheckpoint(jobId, body);
    } else if (cp.mode === 'step') {
      mergeDescribeScoreCullCheckpoint(runner, jobId, cp.host, body);
    } else if (cp.mode === 'nested' && cp.key === 'cull') {
      persistAnalyzeStageCheckpoint(runner, jobId, 'cull', body);
    }
  };

  const sentByHand = listSentByHandKeys(db);
  const askModelsForSentByHand = opts.askModelsForSentByHand ?? true;
  const stageSec: Record<StageKind, number> = { culling_profile: 0, score_forecast: 0 };
  const counts = { culled: 0, redecided: 0, failed: 0, ...emptyVerdictTally() };
  const tally = (imageKey: string, decision: PhotoDecision): void => {
    addDecision(counts, decision);
    opts.onDecision?.(imageKey, decision);
  };

  const skipped = candidates.filter((k) => resume.failed.has(k));
  const skippedAnswers = loadCurrentStageAnswers(db, stages, skipped);
  for (const key of skipped) {
    counts.failed += 1;
    const byHand = sentByHand.has(key);
    const d = decidePhoto(pipeline.config, stages, skippedAnswers.get(key) ?? {}, {
      sentByHand: byHand,
      scoreForecastAvailable: cullCtx.scoreForecastAvailable,
    });
    tally(key, d);
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

      let r;
      if (!askModelsForSentByHand && sentByHand.has(key)) {
        const stored = loadCurrentStageAnswers(db, stages, [key]).get(key) ?? {};
        const decision = decideAndStorePhoto(db, cullCtx, {
          imageKey: key,
          stored,
          sentByHand: sentByHand.has(key),
          runId,
          pendingReason: getCullVerdict(db, key)?.pending_reason,
        });
        r = {
          outcome: 'redecided' as const,
          decision,
          answeredStages: [] as string[],
          seconds: {},
          error: undefined,
        };
      } else {
        r = await cullPhoto(db, cullCtx, models, { imageKey: key, sentByHand: sentByHand.has(key), runId, force: opts.force });
      }

      for (const [kind, s] of Object.entries(r.seconds) as [StageKind, number][]) stageSec[kind] += s;
      for (const stage of r.answeredStages) resume.doneByStage[stage] = (resume.doneByStage[stage] ?? 0) + 1;
      if (r.outcome === 'culled') counts.culled += 1;
      else if (r.outcome === 'redecided') counts.redecided += 1;
      else {
        counts.failed += 1;
        resume.failed.add(key);
        if (r.outcome === 'model_failed') log(`${key} left pending: ${r.error!.message}`, 'warning');
      }
      tally(key, r.decision);
      if (r.outcome === 'endpoint_down') throw r.error!;
      if ((i + 1) % CHECKPOINT_EVERY === 0) persist();
      progress(3 + Math.trunc(((i + 1) / Math.max(work.length, 1)) * 97), `Culled ${i + 1}/${work.length}`);
    }
  } catch (e) {
    persist();
    libraryWrite(db, () =>
      finishCullRun(db, runId, { status: 'failed', error: e instanceof Error ? e.message : String(e), ...counts }),
    );
    throw e;
  }

  if (models.started) {
    log(
      `stages=${activeStages.map((s) => `${s.stageKey}@v${s.versionId}`).join(',')} ` +
        `pipeline_setting=v${pipeline.version} score_forecast=${scoreForecast ? 'on' : 'off'} ` +
        `start_check_s=${models.loadSeconds.toFixed(1)}`,
    );
  }

  const startCheckS = models.started ? models.loadSeconds : 0;
  const cullS = seconds(tCull);
  const result: BatchCullResult = {
    total: keys.length,
    ...counts,
    score_forecast: scoreForecast ? 'on' : 'off',
    pipeline_setting_version: pipeline.version,
    stage_versions: stageVersions,
    durations_s: { start_check: startCheckS, select: selectS, cull: cullS, total: seconds(t0) },
    stage_seconds: {
      culling_profile: Math.round(stageSec.culling_profile * 100) / 100,
      score_forecast: Math.round(stageSec.score_forecast * 100) / 100,
    },
    seconds_per_photo: counts.culled > 0 ? Math.round((cullS / counts.culled) * 100) / 100 : null,
    models_started: models.started,
  };
  libraryWrite(db, () => finishCullRun(db, runId, { status: 'complete', ...result }));
  log(
    `status=complete photos=${work.length} culled=${counts.culled} redecided=${counts.redecided} ` +
      `failed=${counts.failed} filtered_profile=${counts.filtered_by_culling_profile} ` +
      `filtered_score_forecast=${counts.filtered_by_score_forecast} pending=${counts.pending} passed=${counts.passed} ` +
      `sent_by_hand_passed=${counts.sent_by_hand_passed} score_forecast=${result.score_forecast} ` +
      `s_per_photo=${result.seconds_per_photo ?? '-'} duration_s=${result.durations_s.total}`,
  );
  if (ctx.settle === 'stage') return result;
  try {
    const { enqueueLrWritebackIfEnabled } = await import('./lr-writeback.js');
    enqueueLrWritebackIfEnabled(db);
  } catch (e) {
    log(`lightroom write-back after cull: ${e instanceof Error ? e.message : String(e)}`, 'warning');
  }
  runner.clearCheckpoint(jobId);
  runner.completeJob(jobId, result);
  return null;
}
