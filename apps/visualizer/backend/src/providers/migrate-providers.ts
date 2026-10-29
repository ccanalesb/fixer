/**
 * One-shot rewrite of legacy `providers.json` into the current shape and backfill
 * of `provider_models` rows in `visualizer.db`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { initJobsDb } from '../db/jobs/jobs.js';
import { insertProviderModel, migrateLegacyVisionColumn } from '../db/jobs/provider-models.js';
import { writePrivateFile } from '../utils/private-file.js';
import type { ProviderAuth, ProviderConfig, RegistryConfig, ValueRef } from './registry-types.js';
import { isLegacyProvidersFile, stripLegacyProviderFields } from './registry-types.js';

const DECLARED_WITHOUT_IMAGE = 'declared without image input';

interface LegacyModelEntry {
  id: string;
  name?: string;
  vision?: boolean;
}

interface LegacyProviderConfig {
  name: string;
  tool_calling?: boolean;
  base_url?: string;
  base_url_env?: string;
  base_url_default?: string;
  api_key?: string;
  api_key_env?: string;
  auto_discover?: boolean;
  native_chat?: boolean;
  extra_headers?: Record<string, string>;
  request_timeout_seconds?: number;
  retry?: Record<string, unknown>;
  models?: LegacyModelEntry[];
  model_order?: string[];
  enabled?: boolean;
}

interface LegacyRegistryConfig {
  retry_defaults?: Record<string, unknown>;
  providers: Record<string, LegacyProviderConfig>;
  defaults?: RegistryConfig['defaults'];
  fallback_order?: string[];
}

function literalRef(value: string): ValueRef {
  return { from: 'literal', value };
}

function envRef(value: string): ValueRef {
  return { from: 'env', value };
}

function migrateAuth(legacy: LegacyProviderConfig): ProviderAuth {
  if (legacy.api_key === 'ollama') return { mode: 'none' };
  if (legacy.api_key !== undefined) {
    return { mode: 'bearer', secret: literalRef(legacy.api_key) };
  }
  if (legacy.api_key_env) {
    return { mode: 'bearer', secret: envRef(legacy.api_key_env) };
  }
  return { mode: 'none' };
}

function migrateBaseUrl(legacy: LegacyProviderConfig): ValueRef {
  if (legacy.base_url !== undefined) return literalRef(legacy.base_url);
  if (legacy.base_url_env) return envRef(legacy.base_url_env);
  if (legacy.base_url_default) return literalRef(legacy.base_url_default);
  return literalRef('');
}

function migrateProvider(id: string, legacy: LegacyProviderConfig): ProviderConfig {
  return {
    name: legacy.name,
    protocol: 'openai',
    enabled: legacy.enabled ?? true,
    tool_calling: legacy.tool_calling,
    base_url: migrateBaseUrl(legacy),
    auth: migrateAuth(legacy),
    extra_headers: legacy.extra_headers,
    request_timeout_seconds: legacy.request_timeout_seconds,
    retry: legacy.retry,
    model_order: legacy.model_order,
  };
}

function defaultDescriptionModel(
  cfg: LegacyRegistryConfig,
  providerId: string,
): string | null {
  const entry = cfg.defaults?.description;
  if (!entry || entry.provider !== providerId) return null;
  return entry.model ?? null;
}

/**
 * Rewrite a legacy file and seed model rows. No-op when the file is already current.
 */
export function migrateProvidersConfigIfNeeded(
  configPath: string = config.LT_PROVIDERS_JSON,
  dbPath: string = config.VISUALIZER_DB,
): boolean {
  if (!existsSync(configPath)) return false;
  const raw = readFileSync(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!isLegacyProvidersFile(parsed)) return false;

  const legacy = parsed as LegacyRegistryConfig;
  const next: RegistryConfig = {
    retry_defaults: legacy.retry_defaults,
    providers: {},
    defaults: legacy.defaults,
    fallback_order: legacy.fallback_order,
  };

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = initJobsDb(dbPath);
  migrateLegacyVisionColumn(db);

  try {
    for (const [providerId, providerLegacy] of Object.entries(legacy.providers ?? {})) {
      next.providers[providerId] = migrateProvider(providerId, providerLegacy);

      const defaultModelId = defaultDescriptionModel(legacy, providerId);
      const fileModels = providerLegacy.models ?? [];

      for (const model of fileModels) {
        const acceptsImages = model.vision !== false;
        insertProviderModel(db, {
          providerId,
          modelId: model.id,
          modelName: model.name ?? model.id,
          origin: 'config',
          acceptsImages,
          refusedReason: acceptsImages ? null : DECLARED_WITHOUT_IMAGE,
        });
      }

      if (providerLegacy.auto_discover && defaultModelId) {
        const already = fileModels.some((m) => m.id === defaultModelId);
        if (!already) {
          insertProviderModel(db, {
            providerId,
            modelId: defaultModelId,
            modelName: defaultModelId,
            origin: 'config',
            acceptsImages: true,
            refusedReason: null,
          });
        }
      }
    }

    const cleaned = stripLegacyProviderFields(next);
    writePrivateFile(configPath, `${JSON.stringify(cleaned, null, 2)}\n`);
    return true;
  } finally {
    db.close();
  }
}

export { DECLARED_WITHOUT_IMAGE };
