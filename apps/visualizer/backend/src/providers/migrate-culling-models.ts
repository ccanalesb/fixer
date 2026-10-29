/**
 * One-shot migration: external culling stage URLs in `config.yaml` become `system_one`
 * providers in `providers.json`; stages keep the provider id and model only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { config, CULLING_MODELS_DEFAULTS, type CullingModelsConfig, type CullingModelConfig } from '../config.js';
import { initJobsDb } from '../db/jobs/jobs.js';
import { insertProviderModel } from '../db/jobs/provider-models.js';
import { writePrivateFile } from '../utils/private-file.js';
import {
  cullingProviderDedupKey,
  isExternalCullingEndpoint,
  normalizeCullingEndpointUrl,
  providerIdFromCullingUrl,
} from './culling-provider-id.js';
import type { ProviderConfig, RegistryConfig } from './registry-types.js';
import { stripLegacyProviderFields } from './registry-types.js';

const STAGES = ['culling_profile', 'score_forecast'] as const;

type StageKey = (typeof STAGES)[number];

interface LegacyStageYaml {
  endpoint?: string;
  model?: string;
  api_key?: string;
}

function readRegistry(path: string): RegistryConfig {
  if (!existsSync(path)) {
    return { providers: {}, defaults: {}, fallback_order: [] };
  }
  return JSON.parse(readFileSync(path, 'utf8')) as RegistryConfig;
}

function displayNameForUrl(url: string): string {
  try {
    const u = new URL(url);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    const defaultPort = u.protocol === 'https:' ? '443' : '80';
    return port === defaultPort ? u.hostname : `${u.hostname}:${port}`;
  } catch {
    return url;
  }
}

function ensureUniqueProviderId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function upsertSystemOneProvider(
  registry: RegistryConfig,
  id: string,
  url: string,
  apiKey: string,
): void {
  registry.providers[id] = {
    name: displayNameForUrl(url),
    protocol: 'system_one',
    enabled: true,
    base_url: { from: 'literal', value: normalizeCullingEndpointUrl(url) },
    auth: apiKey ? { mode: 'bearer', secret: { from: 'literal', value: apiKey } } : { mode: 'none' },
  };
}

function legacyStagesNeedMigration(raw: Record<string, unknown>): boolean {
  const block = raw.culling_models;
  if (!block || typeof block !== 'object') return false;
  for (const key of STAGES) {
    const stage = (block as Record<string, unknown>)[key];
    if (!stage || typeof stage !== 'object') continue;
    const endpoint = (stage as LegacyStageYaml).endpoint;
    if (typeof endpoint === 'string' && isExternalCullingEndpoint(endpoint)) return true;
    if (typeof (stage as LegacyStageYaml).api_key === 'string' && (stage as LegacyStageYaml).api_key !== '') {
      return true;
    }
  }
  return false;
}

function writeCullingModelsYaml(
  configPath: string,
  raw: Record<string, unknown>,
  models: CullingModelsConfig,
): void {
  const next = { ...raw };
  next.culling_models = {
    culling_profile: { endpoint: models.culling_profile.endpoint, model: models.culling_profile.model },
    score_forecast: { endpoint: models.score_forecast.endpoint, model: models.score_forecast.model },
  };
  writePrivateFile(configPath, stringifyYaml(next));
}

/**
 * Rewrite legacy stage URLs into providers and trim keys from `config.yaml`. No-op when already migrated.
 */
export function migrateCullingModelsIfNeeded(
  configPath: string = config.LT_CONFIG_YAML,
  providersPath: string = config.LT_PROVIDERS_JSON,
  dbPath: string = config.VISUALIZER_DB,
): boolean {
  if (!existsSync(configPath)) return false;
  const raw = (parseYaml(readFileSync(configPath, 'utf8')) as Record<string, unknown>) ?? {};
  if (!legacyStagesNeedMigration(raw)) return false;

  const block =
    raw.culling_models && typeof raw.culling_models === 'object'
      ? (raw.culling_models as Record<string, LegacyStageYaml>)
      : {};
  const stageFromYaml = (key: StageKey): CullingModelConfig & { apiKey: string } => {
    const v = block[key] ?? {};
    const d = CULLING_MODELS_DEFAULTS[key];
    const str = (k: keyof LegacyStageYaml, fallback: string) =>
      typeof v[k] === 'string' ? (v[k] as string) : fallback;
    return {
      endpoint: str('endpoint', d.endpoint),
      model: str('model', d.model),
      apiKey: str('api_key', ''),
    };
  };
  const current: CullingModelsConfig = {
    culling_profile: stageFromYaml('culling_profile'),
    score_forecast: stageFromYaml('score_forecast'),
  };
  const registry = readRegistry(providersPath);
  const takenIds = new Set(Object.keys(registry.providers ?? {}));
  const dedup = new Map<string, string>();

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = initJobsDb(dbPath);
  try {
    const nextStages: CullingModelsConfig = {
      culling_profile: { endpoint: current.culling_profile.endpoint, model: current.culling_profile.model },
      score_forecast: { endpoint: current.score_forecast.endpoint, model: current.score_forecast.model },
    };

    for (const stageKey of STAGES) {
      const stage = stageFromYaml(stageKey);
      if (!isExternalCullingEndpoint(stage.endpoint)) continue;
      const url = normalizeCullingEndpointUrl(stage.endpoint);
      const apiKey = stage.apiKey;
      const dedupKey = cullingProviderDedupKey(url, apiKey);
      let providerId = dedup.get(dedupKey);
      if (!providerId) {
        const base = providerIdFromCullingUrl(url);
        providerId = ensureUniqueProviderId(base, takenIds);
        takenIds.add(providerId);
        dedup.set(dedupKey, providerId);
        upsertSystemOneProvider(registry, providerId, url, apiKey);
      }
      if (stage.model) {
        insertProviderModel(db, {
          providerId,
          modelId: stage.model,
          modelName: stage.model,
          origin: 'config',
          acceptsImages: true,
          refusedReason: null,
        });
      }
      nextStages[stageKey] = { endpoint: providerId, model: stage.model };
    }

    writeCullingModelsYaml(configPath, raw, nextStages);
    const cleaned = stripLegacyProviderFields(registry);
    writePrivateFile(providersPath, `${JSON.stringify(cleaned, null, 2)}\n`);
    return true;
  } finally {
    db.close();
  }
}
