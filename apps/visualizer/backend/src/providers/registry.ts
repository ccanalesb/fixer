/**
 * Provider registry — loads `providers.json`, auto-discovers Ollama models, and
 * resolves credentials.
 *
 * `providers.json` is gitignored and owned by the user's machine, so it is treated
 * as untrusted input in one specific way: a `defaults` block may name a resolution
 * kind that has since been retired, and those keys are dropped on load with a
 * warning rather than failing — the same courtesy `load_config` extends to
 * `config.yaml`.
 *
 * Model listing, Ollama discovery, and tool-calling probes use plain `fetch`
 * against OpenAI-compatible endpoints. Probe requests do not retry.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, REPO_ROOT } from '../config.js';
import { requestJson } from './http.js';
import type { ProviderClient } from './vision-client.js';

/** The shipped template the registry bootstraps from on first use. */
const EXAMPLE_PATH = join(
  REPO_ROOT,
  'apps',
  'visualizer',
  'backend',
  'providers.example.json',
);

/**
 * The only resolution kinds a `defaults` block may declare.
 *
 * Retired kinds still appear in files written before they were removed.
 */
const DEFAULTS_KEYS = new Set(['description']);

/**
 * Tool-calling probe cache, shared for the process lifetime.
 *
 * A fresh `ProviderRegistry` is constructed per request, so a per-instance cache
 * would probe on every page load.
 */
const toolCallingProbeCache = new Map<string, boolean>();

const PROBE_TOOL = {
  type: 'function',
  function: {
    name: 'noop',
    description: 'No-op capability probe.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
} as const;

export interface ProviderModelEntry {
  id: string;
  name: string;
  vision?: boolean;
  source?: 'config' | 'discovered' | 'user';
  [key: string]: unknown;
}

export interface ProviderConfig {
  name: string;
  tool_calling?: boolean;
  base_url?: string;
  base_url_env?: string;
  base_url_default?: string;
  api_key?: string;
  api_key_env?: string;
  auto_discover?: boolean;
  /** Use Ollama's native `/api/chat` for vision calls. See `ProviderClient`. */
  native_chat?: boolean;
  extra_headers?: Record<string, string>;
  request_timeout_seconds?: number;
  retry?: Record<string, unknown>;
  models?: ProviderModelEntry[];
  model_order?: string[];
}

export interface ProviderSummary {
  id: string;
  name: string;
  available: boolean;
  tool_calling: boolean;
}

export interface DefaultsEntry {
  provider: string;
  model?: string | null;
}

interface RegistryConfig {
  retry_defaults?: Record<string, unknown>;
  providers: Record<string, ProviderConfig>;
  defaults?: Record<string, DefaultsEntry>;
  fallback_order?: string[];
}

/** Raised for caller mistakes the API maps to 404 (unknown provider). */
export class UnknownProviderError extends Error {
  constructor(providerId: string) {
    super(`Unknown provider: ${providerId}`);
    this.name = 'UnknownProviderError';
  }
}

export class ProviderRegistry {
  private readonly configPath: string;
  private config: RegistryConfig;
  private readonly discoveredCache = new Map<string, ProviderModelEntry[]>();

  constructor(configPath: string = config.LT_PROVIDERS_JSON) {
    this.configPath = configPath;
    if (!existsSync(this.configPath) && existsSync(EXAMPLE_PATH)) {
      copyFileSync(EXAMPLE_PATH, this.configPath);
    }
    this.config = JSON.parse(readFileSync(this.configPath, 'utf8')) as RegistryConfig;
    this.dropUnknownDefaults();
  }

  private get providers(): Record<string, ProviderConfig> {
    return this.config.providers;
  }

  /**
   * Ignore defaults for resolution kinds that no longer exist.
   *
   * In memory only — the file is left untouched, so nothing is destroyed on load.
   * `updateDefaults` merges onto the cleaned object, so a retired kind cannot be
   * written back either.
   */
  private dropUnknownDefaults(): void {
    const defaults = this.config.defaults;
    if (!defaults || typeof defaults !== 'object') return;
    const unknown = Object.keys(defaults).filter((k) => !DEFAULTS_KEYS.has(k));
    if (unknown.length === 0) return;
    for (const key of unknown) delete defaults[key];
    process.stderr.write(
      `Ignoring unknown defaults ${[...unknown].sort().join(', ')} in ` +
        `${this.configPath} (retired resolution kinds)\n`,
    );
  }

  get fallbackOrder(): string[] {
    return this.config.fallback_order ?? Object.keys(this.providers);
  }

  get defaults(): Record<string, DefaultsEntry> {
    return this.config.defaults ?? {};
  }

  get providerIds(): string[] {
    return Object.keys(this.providers);
  }

  hasProvider(providerId: string): boolean {
    return Object.hasOwn(this.providers, providerId);
  }

  /** The provider's custom model order, or `[]`. */
  modelOrderFor(providerId: string): string[] {
    return this.providers[providerId]?.model_order ?? [];
  }

  /**
   * Every provider with its availability and tool-calling capability.
   *
   * Note that this can make network calls: a provider with no explicit
   * `tool_calling` triggers a live probe (cached per process).
   */
  async listProviders(): Promise<ProviderSummary[]> {
    const out: ProviderSummary[] = [];
    for (const [id, cfg] of Object.entries(this.providers)) {
      out.push({
        id,
        name: cfg.name,
        available: this.isAvailable(cfg),
        tool_calling: await this.resolveToolCalling(id, cfg),
      });
    }
    return out;
  }

  /** Config models plus auto-discovered ones, in the user's custom order. */
  async listModels(providerId: string): Promise<ProviderModelEntry[]> {
    const cfg = this.providers[providerId];
    if (!cfg) throw new UnknownProviderError(providerId);

    const models: ProviderModelEntry[] = (cfg.models ?? []).map((m) => ({
      ...m,
      source: 'config' as const,
    }));
    if (cfg.auto_discover) {
      models.push(...(await this.discoverModels(providerId, cfg)));
    }
    return applyModelOrder(models, cfg.model_order ?? []);
  }

  /**
   * Whether the provider's API answers a models-list call.
   *
   * Returns the failure reason rather than throwing, because "unreachable" is a
   * normal answer the UI displays. Throws only for an unknown provider id.
   */
  async probeConnection(providerId: string): Promise<{ ok: boolean; detail: string | null }> {
    const cfg = this.providers[providerId];
    if (!cfg) throw new UnknownProviderError(providerId);
    try {
      await this.fetchJson(cfg, '/models', { timeoutMs: 5000 });
      return { ok: true, detail: null };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Model ids the provider reports live, for providers with none configured. */
  async discoverOpenAiModels(providerId: string, timeoutMs = 2000): Promise<string[]> {
    const cfg = this.providers[providerId];
    if (!cfg) throw new UnknownProviderError(providerId);
    const body = (await this.fetchJson(cfg, '/models', { timeoutMs })) as {
      data?: { id?: string }[];
    };
    return (body.data ?? []).map((m) => String(m.id)).filter(Boolean);
  }

  /** A resolved endpoint for the vision client. */
  getClient(providerId: string): ProviderClient {
    const cfg = this.providers[providerId];
    if (!cfg) throw new UnknownProviderError(providerId);
    return {
      providerId,
      baseUrl: this.resolveBaseUrl(cfg),
      apiKey: this.resolveApiKey(cfg),
      extraHeaders: cfg.extra_headers ?? {},
      timeoutMs: Number(cfg.request_timeout_seconds ?? 120) * 1000,
      // Defaulting on the id covers `providers.json` files written before the
      // flag existed. Renaming that provider without setting `native_chat` is
      // the one case this gets wrong, and it degrades to the compat endpoint.
      nativeChat: cfg.native_chat ?? providerId === 'ollama',
    };
  }

  /** Merged retry config for a provider. Consumed by the job engine, not the API. */
  getRetryConfig(providerId: string): Record<string, unknown> {
    const cfg = this.providers[providerId];
    if (!cfg) throw new UnknownProviderError(providerId);
    return { ...(this.config.retry_defaults ?? {}), ...(cfg.retry ?? {}) };
  }

  /** Replace the fallback order, de-duplicated, preserving first occurrence. */
  updateFallbackOrder(order: unknown): void {
    if (!Array.isArray(order) || order.length === 0) {
      throw new RangeError('fallback order must not be empty');
    }
    const ids = order.map(String);
    const unknown = ids.filter((id) => !this.hasProvider(id));
    if (unknown.length > 0) {
      throw new RangeError(`Unknown provider id(s): [${unknown.map((u) => `'${u}'`).join(', ')}]`);
    }
    this.config.fallback_order = [...new Set(ids)];
    this.saveConfig();
  }

  /** Merge a defaults patch, validating each entry names a real provider. */
  updateDefaults(defaults: unknown): void {
    if (!defaults || typeof defaults !== 'object' || Object.keys(defaults).length === 0) {
      throw new RangeError('defaults must include description');
    }
    for (const [key, value] of Object.entries(defaults as Record<string, unknown>)) {
      if (!DEFAULTS_KEYS.has(key)) throw new RangeError(`Unknown defaults key: '${key}'`);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new RangeError(`${key} must be an object`);
      }
      const entry = value as Record<string, unknown>;
      if (!('provider' in entry)) throw new RangeError(`${key} requires provider`);
      const providerId = String(entry.provider);
      if (!this.hasProvider(providerId)) {
        throw new RangeError(`Unknown provider: ${providerId}`);
      }
    }
    this.config.defaults = {
      ...(this.config.defaults ?? {}),
      ...(defaults as Record<string, DefaultsEntry>),
    };
    this.saveConfig();
  }

  /** Remove a config model from `providers.json`. Returns whether one went. */
  removeModel(providerId: string, modelId: string): boolean {
    const cfg = this.providers[providerId];
    if (!cfg) throw new UnknownProviderError(providerId);
    const models = cfg.models ?? [];
    const kept = models.filter((m) => m.id !== modelId);
    if (kept.length === models.length) return false;
    cfg.models = kept;
    this.saveConfig();
    return true;
  }

  /**
   * Reorder a provider's models.
   *
   * Entries already in `model_order` but absent from the new list are appended
   * rather than dropped — the UI does not know about every cloud model, and a
   * reorder from a partial view must not silently forget the rest.
   */
  reorderModels(providerId: string, modelOrder: unknown): boolean {
    const cfg = this.providers[providerId];
    if (!cfg) throw new UnknownProviderError(providerId);
    if (!Array.isArray(modelOrder)) throw new RangeError('order must be a list');
    const ids = modelOrder.map(String);
    const newSet = new Set(ids);
    const tail = (cfg.model_order ?? []).filter((mid) => !newSet.has(mid));
    cfg.model_order = [...ids, ...tail];
    this.saveConfig();
    return true;
  }

  /** Explicit config wins; otherwise a lazily-cached live probe. */
  private async resolveToolCalling(providerId: string, cfg: ProviderConfig): Promise<boolean> {
    if (cfg.tool_calling !== undefined) return Boolean(cfg.tool_calling);
    const cached = toolCallingProbeCache.get(providerId);
    if (cached !== undefined) return cached;
    const result = await this.probeToolCalling(providerId, cfg);
    toolCallingProbeCache.set(providerId, result);
    return result;
  }

  /**
   * Send a minimal tool-calling request to detect support.
   *
   * Uses the first configured model, or a discovered one when none are configured.
   * Any error means "not capable" — a probe that cannot complete is indistinguishable
   * from a provider that refuses tools, and guessing `true` would break real requests.
   */
  private async probeToolCalling(providerId: string, cfg: ProviderConfig): Promise<boolean> {
    let probeModel = cfg.models?.[0]?.id;
    if (!probeModel) {
      try {
        probeModel = (await this.discoverOpenAiModels(providerId, 5000))[0];
      } catch {
        return false;
      }
    }
    if (!probeModel) return false;

    try {
      await this.fetchJson(cfg, '/chat/completions', {
        timeoutMs: 10000,
        method: 'POST',
        body: {
          model: probeModel,
          messages: [{ role: 'user', content: 'hi' }],
          tools: [PROBE_TOOL],
          tool_choice: 'auto',
          max_tokens: 1,
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  private saveConfig(): void {
    writeFileSync(this.configPath, `${JSON.stringify(this.config, null, 2)}\n`, 'utf8');
  }

  /**
   * A provider is available when a credential can be resolved.
   *
   * An inline `api_key` (Ollama's literal `"ollama"`) always counts; otherwise the
   * named environment variable has to be set.
   */
  private isAvailable(cfg: ProviderConfig): boolean {
    if (cfg.api_key !== undefined) return true;
    if (cfg.api_key_env) return Boolean(process.env[cfg.api_key_env]);
    return false;
  }

  private resolveBaseUrl(cfg: ProviderConfig): string {
    if (cfg.base_url !== undefined) return cfg.base_url;
    const host = cfg.base_url_env ? (process.env[cfg.base_url_env] ?? '') : '';
    if (host) {
      // A bare host from the environment gets `/v1` appended; an explicit one is
      // left alone, so `OLLAMA_HOST=http://box:11434` works either way.
      const base = host.replace(/\/+$/, '');
      return base.endsWith('/v1') ? base : `${base}/v1`;
    }
    return cfg.base_url_default ?? '';
  }

  private resolveApiKey(cfg: ProviderConfig): string {
    if (cfg.api_key !== undefined) return cfg.api_key;
    return cfg.api_key_env ? (process.env[cfg.api_key_env] ?? '') : '';
  }

  /**
   * One OpenAI-compatible request, with the provider's headers and timeout.
   *
   * Failures stay plain `Error`s carrying the status line: every caller here is a
   * probe, and `probeConnection` puts this message straight in front of the user
   * as the reason a provider is unavailable.
   */
  private async fetchJson(
    cfg: ProviderConfig,
    path: string,
    opts: { timeoutMs: number; method?: string; body?: unknown },
  ): Promise<unknown> {
    return requestJson(
      {
        baseUrl: this.resolveBaseUrl(cfg),
        apiKey: this.resolveApiKey(cfg),
        extraHeaders: cfg.extra_headers ?? {},
        timeoutMs: opts.timeoutMs,
      },
      path,
      {
        method: opts.method ?? 'GET',
        body: opts.body,
        onHttpError: (res) => new Error(`${res.status} ${res.statusText}`),
      },
    );
  }

  /**
   * Ollama's `/api/tags`, cached per registry instance.
   *
   * Not the OpenAI `/models` endpoint: Ollama's tag list is what reports locally
   * pulled models, and everything it returns is treated as vision-capable because
   * the tag list does not say.
   */
  private async discoverModels(
    providerId: string,
    cfg: ProviderConfig,
  ): Promise<ProviderModelEntry[]> {
    const cached = this.discoveredCache.get(providerId);
    if (cached) return cached;

    const tagsUrl = this.resolveBaseUrl(cfg).replace('/v1', '/api/tags');
    let models: ProviderModelEntry[] = [];
    try {
      const res = await fetch(tagsUrl, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = (await res.json()) as { models?: { name?: string }[] };
        models = (data.models ?? [])
          .filter((m) => m.name)
          .map((m) => ({
            id: String(m.name),
            name: String(m.name),
            vision: true,
            source: 'discovered' as const,
          }));
      }
    } catch {
      // A provider that is not running is not an error; it just has no models.
    }
    this.discoveredCache.set(providerId, models);
    return models;
  }
}

/**
 * Apply a custom model order, appending anything the order does not mention.
 *
 * Newly discovered models are not in `model_order` yet and must still appear, or
 * pulling a new Ollama model would make it invisible.
 */
export function applyModelOrder(
  models: readonly ProviderModelEntry[],
  modelOrder: readonly string[],
): ProviderModelEntry[] {
  if (modelOrder.length === 0) return [...models];
  const byId = new Map(models.map((m) => [m.id, m]));
  const ordered: ProviderModelEntry[] = [];
  for (const modelId of modelOrder) {
    const model = byId.get(modelId);
    if (model) ordered.push(model);
  }
  const known = new Set(modelOrder);
  for (const model of models) {
    if (!known.has(model.id)) ordered.push(model);
  }
  return ordered;
}
