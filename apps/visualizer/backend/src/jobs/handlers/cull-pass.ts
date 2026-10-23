/**
 * Shared cull pass: each stage's model through System One, checkpoints, and per-photo work. Used by the standalone cull job
 * and the in-job cull step.
 */
import { performance } from 'node:perf_hooks';
import { config, loadLibraryConfig } from '../../config.js';
import { cullPhoto } from '../../cull/answer-photo.js';
import { decidePhoto } from '../../cull/decide.js';
import { decideAndStorePhoto, type CullContext } from '../../cull/persist.js';
import { selectPhotosToCull } from '../../cull/select.js';
import {
  assertForecastHasQuestions,
  CullingModels,
  resolveStageModelIds,
  stageModelsFromConfig,
  stagesOn,
} from '../../cull/stage-models.js';
import { resolveCurrentStages } from '../../cull/stages.js';
import type { CullSummaryVerdict, StageKind } from '../../cull/types.js';
import type { Db } from '../../db/connection.js';
import { getCurrentPipelineSetting } from '../../db/library/cull-pipeline.js';
import { seedCullingDefaults } from '../../db/library/cull-profiles.js';
import { loadCurrentStageAnswers, readStoredStageModelIds } from '../../db/library/cull-stages.js';
import { getForecastQuestions } from '../../db/library/score-forecast-questions.js';
import { listSentByHandKeys } from '../../db/library/cull-user-actions.js';
import { finishCullRun, getCullVerdict, insertCullRun, listCullRunIdsForJob } from '../../db/library/cull-verdicts.js';
import { libraryWrite } from '../../db/library/write.js';
import { convertingModelNames } from '../../app-models/install.js';
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

export interface BatchCullResult {
  total: number;
  culled: number;
  redecided: number;
  failed: number;
  filtered_by_culling_profile: number;
  filtered_by_score_forecast: number;
  pending: number;
  passed: number;
  sent_by_hand_passed: number;
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
  opts: { imageKeys?: readonly string[]; skipModelsFor?: ReadonlySet<string>; force?: boolean } = {},
): Promise<BatchCullResult | null> {
  const t0 = performance.now();
  const prefix = ctx.logPrefix;
  const log = (message: string, level: 'info' | 'warning' = 'info'): void =>
    runner.log(jobId, level, `${prefix}[cull] ${message}`);
  const progress = (pct: number, message: string): void =>
    runner.updateProgress(jobId, mapPassProgress(ctx, pct), `${prefix}${message}`);

  seedCullingDefaults(db);
  const pipeline = getCurrentPipelineSetting(db);
  const stageModels = stageModelsFromConfig(loadLibraryConfig(config.LT_CONFIG_YAML).cullingModels);
  const modelIds = await resolveStageModelIds(
    stageModels,
    stagesOn(pipeline.config),
    readStoredStageModelIds(db),
    convertingModelNames(runner.waitingOrRunningJobs()),
  );
  assertForecastHasQuestions(stagesOn(pipeline.config), getForecastQuestions(db).questions.length);
  const stages = resolveCurrentStages(db, pipeline.config, modelIds);

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
  const on = stagesOn(pipeline.config);
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
  const skipModels = opts.skipModelsFor ?? new Set<string>();
  const stageSec: Record<StageKind, number> = { culling_profile: 0, score_forecast: 0 };
  const counts = {
    culled: 0,
    redecided: 0,
    failed: 0,
    filtered_by_culling_profile: 0,
    filtered_by_score_forecast: 0,
    pending: 0,
    passed: 0,
    sent_by_hand_passed: 0,
  };
  const tally = (verdict: CullSummaryVerdict, filteredBy: StageKind | null, sentByHandOverride: boolean): void => {
    if (verdict === 'pending') counts.pending += 1;
    else if (verdict === 'passed') counts.passed += 1;
    else if (filteredBy === 'culling_profile') counts.filtered_by_culling_profile += 1;
    else counts.filtered_by_score_forecast += 1;
    if (sentByHandOverride) counts.sent_by_hand_passed += 1;
  };

  const skipped = candidates.filter((k) => resume.failed.has(k));
  const skippedAnswers = loadCurrentStageAnswers(db, stages, skipped);
  for (const key of skipped) {
    counts.failed += 1;
    const byHand = getCullVerdict(db, key)?.sent_by_hand ?? sentByHand.has(key);
    const d = decidePhoto(pipeline.config, stages, skippedAnswers.get(key) ?? {}, {
      sentByHand: byHand,
      scoreForecastAvailable: cullCtx.scoreForecastAvailable,
    });
    tally(d.verdict, d.filteredBy, d.sentByHandOverride);
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
      if (skipModels.has(key)) {
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
      tally(r.decision.verdict, r.decision.filteredBy, r.decision.sentByHandOverride);
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
