/**
 * Whether a culling stage that is on can run, asked before a job is started so the UI can say why it
 * cannot. A job started anyway still fails naming the stage (`resolveStageModelIds`).
 */
import type { CullingModelConfig } from '../config.js';
import type { AppModelStatus } from '../app-models/install.js';
import { ProviderRegistry } from '../providers/registry.js';
import { THIS_APP_ENDPOINT } from '../systemone/client.js';
import type { StageKind } from './types.js';

export type StageProblem = 'no_model' | 'converting' | 'parked' | 'removed' | 'no_questions';

export interface StageUsability {
  on: boolean;
  /** Why a stage that is on cannot run; null when it can, or is off. */
  problem: StageProblem | null;
  model: string | null;
  endpoint: string;
  /** The conversion job of a model still converting in this app. */
  job_id: string | null;
  /** System One provider name when the stage is parked. */
  provider_name: string | null;
}

export interface StageUsabilityInput {
  on: boolean;
  cfg: CullingModelConfig;
  /** This app's models, the converting ones included. */
  appModels: readonly AppModelStatus[];
  /** The Score forecast's questions; ignored for the culling profile. */
  questionCount: number;
  registry?: ProviderRegistry;
}

export async function stageUsability(kind: StageKind, input: StageUsabilityInput): Promise<StageUsability> {
  const { cfg } = input;
  const base: StageUsability = {
    on: input.on,
    problem: null,
    model: cfg.model || null,
    endpoint: cfg.endpoint,
    job_id: null,
    provider_name: null,
  };
  if (!input.on) return base;
  if (!cfg.model) return { ...base, problem: 'no_model' };

  if (cfg.endpoint === THIS_APP_ENDPOINT) {
    const converting = input.appModels.find((m) => m.name === cfg.model && m.status === 'converting');
    if (converting) return { ...base, problem: 'converting', job_id: converting.job_id };
    const ready = input.appModels.some((m) => m.name === cfg.model && m.status === 'ready');
    if (!ready) return { ...base, problem: 'no_model' };
  } else if (!cfg.endpoint.trim()) {
    return { ...base, problem: 'removed' };
  } else {
    const registry = input.registry ?? new ProviderRegistry();
    const pcfg = registry.hasProvider(cfg.endpoint) ? registry.providerConfig(cfg.endpoint) : null;
    if (!pcfg || pcfg.protocol !== 'system_one') {
      return { ...base, problem: 'removed' };
    }
    if (pcfg.enabled === false) {
      return { ...base, problem: 'parked', provider_name: pcfg.name };
    }
  }

  if (kind === 'score_forecast' && input.questionCount === 0) return { ...base, problem: 'no_questions' };
  return base;
}
