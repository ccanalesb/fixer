/**
 * Whether a culling stage that is on can run, from what is known locally — before listing models or
 * calling an endpoint. Jobs, the CLI and `/api/culling-models/usable` share this; remote checks stay in
 * `resolveStageModelIds`.
 */
import { config, loadLibraryConfig, type CullingModelConfig, type CullingModelsConfig } from '../config.js';
import { listAppModels, type AppModelStatus } from '../app-models/install.js';
import { setupErrorMessage } from '../app-models/files.js';
import type { Db } from '../db/connection.js';
import { initJobsDb } from '../db/jobs/jobs.js';
import { getCurrentPipelineSetting } from '../db/library/cull-pipeline.js';
import { getForecastQuestions } from '../db/library/score-forecast-questions.js';
import { ProviderRegistry } from '../providers/registry.js';
import { findSystemOneEndpoint, THIS_APP_ENDPOINT, type SystemOneEndpoint } from '../systemone/client.js';
import type { StageKind, StageProblem } from './types.js';
import { CullingStageError, STAGE_NAMES, stagesOn } from './stage-models.js';

export type { StageProblem } from './types.js';

export interface ResolveStageResult {
  on: boolean;
  endpoint: string;
  model: string | null;
  /** Why a stage that is on cannot run; null when it can, or is off. */
  problem: StageProblem | null;
  /** The conversion job of a model still converting in this app. */
  job_id: string | null;
  /** System One provider name when the stage is parked. */
  provider_name: string | null;
  /** Built when the endpoint is this app or a known System One provider; else null. */
  systemOne: SystemOneEndpoint | null;
}

export type ResolvedStages = Record<StageKind, ResolveStageResult>;

export interface ResolveStagesInput {
  on: Record<StageKind, boolean>;
  cfg: CullingModelsConfig;
  /** This app's models, the converting ones included. */
  appModels: readonly AppModelStatus[];
  /** The Score forecast's questions. */
  questionCount: number;
  registry?: ProviderRegistry;
  thisAppFetch?: typeof fetch;
}

const TURN_OFF: Record<StageKind, string> = { culling_profile: 'the culling profile', score_forecast: 'the Score forecast' };

const named = (kind: StageKind, message: string) => `${STAGE_NAMES[kind]}: ${message}`;

function resolveStage(
  kind: StageKind,
  cfg: CullingModelConfig,
  input: ResolveStagesInput,
  registry: ProviderRegistry,
): ResolveStageResult {
  const on = input.on[kind];
  const systemOne = findSystemOneEndpoint(cfg.endpoint, { registry, thisAppFetch: input.thisAppFetch });
  const base: ResolveStageResult = {
    on,
    problem: null,
    model: cfg.model || null,
    endpoint: cfg.endpoint,
    job_id: null,
    provider_name: null,
    systemOne,
  };
  if (!on) return base;
  if (!cfg.model) return { ...base, problem: 'no_model' };

  if (cfg.endpoint === THIS_APP_ENDPOINT) {
    const converting = input.appModels.find((m) => m.name === cfg.model && m.status === 'converting');
    if (converting) return { ...base, problem: 'converting', job_id: converting.job_id };
    const ready = input.appModels.some((m) => m.name === cfg.model && m.status === 'ready');
    if (!ready) return { ...base, problem: 'no_model' };
  } else if (systemOne === null) {
    return { ...base, problem: 'removed' };
  } else {
    const pcfg = registry.providerConfig(cfg.endpoint)!;
    if (pcfg.enabled === false) {
      return { ...base, problem: 'parked', provider_name: pcfg.name };
    }
  }

  if (kind === 'score_forecast' && input.questionCount === 0) return { ...base, problem: 'no_questions' };
  return base;
}

/** Both stages, from what the caller already has. */
export function resolveStages(input: ResolveStagesInput): ResolvedStages {
  const registry = input.registry ?? new ProviderRegistry();
  return {
    culling_profile: resolveStage('culling_profile', input.cfg.culling_profile, input, registry),
    score_forecast: resolveStage('score_forecast', input.cfg.score_forecast, input, registry),
  };
}

/**
 * Both stages as the library has them: which are on in its pipeline setting, its Score forecast
 * questions, `config.yaml`'s culling models, and this app's models with the ones still converting.
 */
export function resolveLibraryStages(db: Db, opts: { registry?: ProviderRegistry } = {}): ResolvedStages {
  const libraryConfig = loadLibraryConfig(config.LT_CONFIG_YAML);
  const jobsDb = initJobsDb(config.VISUALIZER_DB);
  let appModels: AppModelStatus[];
  try {
    appModels = listAppModels(libraryConfig.appModelsDir, jobsDb);
  } finally {
    jobsDb.close();
  }
  return resolveStages({
    on: stagesOn(getCurrentPipelineSetting(db).config),
    cfg: libraryConfig.cullingModels,
    appModels,
    questionCount: getForecastQuestions(db).questions.length,
    registry: opts.registry,
  });
}

export function cullingStageErrorForProblem(
  kind: StageKind,
  problem: StageProblem,
  result: Pick<ResolveStageResult, 'model' | 'provider_name' | 'systemOne'>,
): CullingStageError {
  switch (problem) {
    case 'no_model':
      if (result.model) {
        return new CullingStageError(
          kind,
          'not_listed',
          named(kind, setupErrorMessage(`${result.model} is not listed by ${result.systemOne?.label ?? 'this app'}`)),
        );
      }
      return new CullingStageError(
        kind,
        'no_model',
        named(kind, `no model chosen. Choose one in Processing → Settings → Culling models, or turn ${TURN_OFF[kind]} off`),
      );
    case 'converting':
      return new CullingStageError(
        kind,
        'converting',
        named(kind, `${result.model} is still converting. It can be used once its conversion job finishes`),
      );
    case 'parked':
      return new CullingStageError(
        kind,
        'parked',
        named(
          kind,
          `${result.provider_name} is parked. Turn it back on in Processing → Providers, or turn ${TURN_OFF[kind]} off`,
        ),
      );
    case 'removed':
      return new CullingStageError(
        kind,
        'removed',
        named(kind, `its endpoint was removed. Choose one in Processing → Providers, or turn ${TURN_OFF[kind]} off`),
      );
    case 'no_questions':
      return new CullingStageError(
        kind,
        'no_questions',
        named(
          'score_forecast',
          'no questions yet. Create them in Perspectives → Score forecast questions, or turn the Score forecast off',
        ),
      );
  }
}

/** Throws for the first stage that is on with a local problem; `skip` ignores listed problems (CLI: no_questions). */
export function throwIfStageProblem(stages: ResolvedStages, opts: { skip?: ReadonlySet<StageProblem> } = {}): void {
  for (const kind of ['culling_profile', 'score_forecast'] as const) {
    const result = stages[kind];
    if (!result.on || !result.problem || opts.skip?.has(result.problem)) continue;
    throw cullingStageErrorForProblem(kind, result.problem, result);
  }
}
