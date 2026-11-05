/**
 * Whether a culling stage that is on can run, from what is known locally — before listing models or
 * calling an endpoint. Jobs, the CLI and `/api/culling-models/usable` share this; remote checks stay in
 * `resolveStageModelIds`.
 */
import type { CullingModelConfig } from '../config.js';
import type { AppModelStatus } from '../app-models/install.js';
import { setupErrorMessage } from '../app-models/files.js';
import { ProviderRegistry } from '../providers/registry.js';
import { systemOneEndpoint, THIS_APP_ENDPOINT, type SystemOneEndpoint } from '../systemone/client.js';
import type { StageKind } from './types.js';
import { CullingStageError, STAGE_NAMES } from './stage-models.js';

export type StageProblem = 'no_model' | 'converting' | 'parked' | 'removed' | 'no_questions';

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

export interface ResolveStageInput {
  on: boolean;
  cfg: CullingModelConfig;
  /** This app's models, the converting ones included. */
  appModels: readonly AppModelStatus[];
  /** The Score forecast's questions; ignored for the culling profile. */
  questionCount: number;
  registry?: ProviderRegistry;
  thisAppFetch?: typeof fetch;
}

const TURN_OFF: Record<StageKind, string> = { culling_profile: 'the culling profile', score_forecast: 'the Score forecast' };

const named = (kind: StageKind, message: string) => `${STAGE_NAMES[kind]}: ${message}`;

/** This app, a System One provider's endpoint, or null when the stage's endpoint is removed. */
export function stageEndpoint(
  cfg: CullingModelConfig,
  registry: ProviderRegistry,
  opts: { thisAppFetch?: typeof fetch } = {},
): SystemOneEndpoint | null {
  if (cfg.endpoint === THIS_APP_ENDPOINT) {
    return systemOneEndpoint(cfg, { registry, thisAppFetch: opts.thisAppFetch });
  }
  const pcfg = registry.hasProvider(cfg.endpoint) ? registry.providerConfig(cfg.endpoint) : null;
  if (pcfg?.protocol === 'system_one') {
    return systemOneEndpoint(cfg, { registry, thisAppFetch: opts.thisAppFetch });
  }
  return null;
}

export async function resolveStage(kind: StageKind, input: ResolveStageInput): Promise<ResolveStageResult> {
  const { cfg } = input;
  const registry = input.registry ?? new ProviderRegistry();
  const systemOne = stageEndpoint(cfg, registry, { thisAppFetch: input.thisAppFetch });
  const base: ResolveStageResult = {
    on: input.on,
    problem: null,
    model: cfg.model || null,
    endpoint: cfg.endpoint,
    job_id: null,
    provider_name: null,
    systemOne,
  };
  if (!input.on) return base;
  if (!cfg.model) return { ...base, problem: 'no_model' };

  if (cfg.endpoint === THIS_APP_ENDPOINT) {
    const converting = input.appModels.find((m) => m.name === cfg.model && m.status === 'converting');
    if (converting) return { ...base, problem: 'converting', job_id: converting.job_id };
    const ready = input.appModels.some((m) => m.name === cfg.model && m.status === 'ready');
    if (!ready) return { ...base, problem: 'no_model' };
  } else if (!cfg.endpoint.trim() || systemOne === null) {
    return { ...base, problem: 'removed', systemOne: null };
  } else {
    const pcfg = registry.providerConfig(cfg.endpoint)!;
    if (pcfg.enabled === false) {
      return { ...base, problem: 'parked', provider_name: pcfg.name };
    }
  }

  if (kind === 'score_forecast' && input.questionCount === 0) return { ...base, problem: 'no_questions' };
  return base;
}

export function cullingStageErrorForProblem(kind: StageKind, problem: StageProblem, result: ResolveStageResult): CullingStageError {
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

/** Throws when the stage is on with a local problem; optional `skip` ignores listed problems (CLI: no_questions). */
export function throwIfStageProblem(
  kind: StageKind,
  result: ResolveStageResult,
  opts: { skip?: ReadonlySet<StageProblem> } = {},
): void {
  if (!result.on || !result.problem) return;
  if (opts.skip?.has(result.problem)) return;
  throw cullingStageErrorForProblem(kind, result.problem, result);
}
