/**
 * Provider registry — loads `providers.json` and resolves credentials.
 *
 * `providers.json` is gitignored and owned by the user's machine, so it is treated
 * as untrusted input in one specific way: a `defaults` block may name a resolution
 * kind that has since been retired, and those keys are dropped on load with a
 * warning rather than failing — the same courtesy `load_config` extends to
 * `config.yaml`.
 *
 * Model listing and tool-calling probes use plain `fetch` against OpenAI-compatible
 * endpoints. Probe requests do not retry.
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { config, providersExamplePath } from '../config.js';
import { openDb } from '../db/connection.js';
import {
  listProviderModels,
  visionFromRow,
  type ProviderModelRow,
} from '../db/jobs/provider-models.js';
import { writePrivateFile } from '../utils/private-file.js';
import { requestJson, type HttpEndpoint } from './http.js';
import { migrateProvidersConfigIfNeeded } from './migrate-providers.js';
import type { ProviderClient } from './vision-client.js';
import type {
  DefaultsEntry,
  ProviderConfig,
  ProviderModelEntry,
  ProviderSummary,
  RegistryConfig,
  ValueRef,
} from './registry-types.js';

/** The shipped template the registry bootstraps from on first use. */
function examplePath(): string {
  return providersExamplePath();
}

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

export type {
  DefaultsEntry,
  ProviderConfig,
  ProviderModelEntry,
  ProviderSummary,
  RegistryConfig,
  ValueRef,
} from './registry-types.js';

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

  constructor(configPath: string = config.LT_PROVIDERS_JSON) {
    this.configPath = configPath;
    const example = examplePath();
    if (!existsSync(this.configPath) && existsSync(example)) {
      copyFileSync(example, this.configPath);
    }
    migrateProvidersConfigIfNeeded(this.configPath, config.VISUALIZER_DB);
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

  isEnabled(providerId: string): boolean {
    const cfg = this.providers[providerId];
    if (!cfg) return false;
    return cfg.enabled !== false;
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

  /** Models stored for this provider in `visualizer.db`. */
  async listModels(providerId: string): Promise<ProviderModelEntry[]> {
    const cfg = this.providers[providerId];
    if (!cfg) throw new UnknownProviderError(providerId);

    const rows = this.readModelRows(providerId);
    const models: ProviderModelEntry[] = rows.map((row) => rowToEntry(row));
    return applyModelOrder(models, cfg.model_order ?? []);
  }

  private readModelRows(providerId: string): ProviderModelRow[] {
    if (!existsSync(config.VISUALIZER_DB)) return [];
    const db = openDb(config.VISUALIZER_DB, { readonly: true, vec: false });
    try {
      return listProviderModels(db, providerId);
    } finally {
      db.close();
    }
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
    const endpoint = this.buildHttpEndpoint(cfg);
    return {
      providerId,
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      authMode: endpoint.authMode,
      authHeaderName: endpoint.authHeaderName,
      extraHeaders: cfg.extra_headers ?? {},
      timeoutMs: Number(cfg.request_timeout_seconds ?? 120) * 1000,
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

  /** Remove a model row from `visualizer.db`. Returns whether one went. */
  removeModel(providerId: string, modelId: string): boolean {
    const cfg = this.providers[providerId];
    if (!cfg) throw new UnknownProviderError(providerId);
    if (!existsSync(config.VISUALIZER_DB)) return false;
    const db = openDb(config.VISUALIZER_DB, { readonly: false, vec: false });
    try {
      const info = db
        .prepare('DELETE FROM provider_models WHERE provider_id = ? AND model_id = ?')
        .run(providerId, modelId);
      return info.changes > 0;
    } finally {
      db.close();
    }
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
    let probeModel = this.readModelRows(providerId).find((r) => visionFromRow(r))?.model_id;
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
    writePrivateFile(this.configPath, `${JSON.stringify(this.config, null, 2)}\n`);
  }

  /**
   * A provider is available when it is enabled and a credential can be resolved.
   */
  private isAvailable(cfg: ProviderConfig): boolean {
    if (cfg.enabled === false) return false;
    return this.authResolvable(cfg.auth);
  }

  /** Used by the fallback cascade — credentials plus `enabled`. */
  isCascadeEligible(providerId: string): boolean {
    const cfg = this.providers[providerId];
    if (!cfg || cfg.enabled === false) return false;
    return this.authResolvable(cfg.auth);
  }

  private authResolvable(auth: ProviderConfig['auth']): boolean {
    if (auth.mode === 'none') return true;
    const secret = auth.secret;
    if (!secret) return false;
    if (secret.from === 'literal') return secret.value.length > 0;
    return Boolean(process.env[secret.value]);
  }

  resolveValueRef(ref: ValueRef): string {
    if (ref.from === 'literal') return ref.value;
    return process.env[ref.value] ?? '';
  }

  resolveBaseUrl(cfg: ProviderConfig): string {
    const host = this.resolveValueRef(cfg.base_url);
    if (!host) return '';
    const base = host.replace(/\/+$/, '');
    if (cfg.base_url.from === 'env') {
      return base.endsWith('/v1') ? base : `${base}/v1`;
    }
    return base;
  }

  resolveApiKey(cfg: ProviderConfig): string {
    const auth = cfg.auth;
    if (auth.mode === 'none') return '';
    return auth.secret ? this.resolveValueRef(auth.secret) : '';
  }

  private buildHttpEndpoint(cfg: ProviderConfig): HttpEndpoint {
    return {
      baseUrl: this.resolveBaseUrl(cfg),
      apiKey: this.resolveApiKey(cfg),
      authMode: cfg.auth.mode,
      authHeaderName: cfg.auth.header_name,
      extraHeaders: cfg.extra_headers ?? {},
      timeoutMs: Number(cfg.request_timeout_seconds ?? 120) * 1000,
    };
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
    return requestJson(this.buildHttpEndpoint(cfg), path, {
      method: opts.method ?? 'GET',
      body: opts.body,
      onHttpError: (res) => new Error(`${res.status} ${res.statusText}`),
    });
  }
}

function rowToEntry(row: ProviderModelRow): ProviderModelEntry {
  return {
    id: row.model_id,
    name: row.model_name,
    vision: visionFromRow(row),
    source: row.origin === 'user' ? 'user' : 'config',
  };
}

/**
 * Apply a custom model order, appending anything the order does not mention.
 *
 * Newly added models are not in `model_order` yet and must still appear, or a
 * hand-entered model would be invisible in the UI.
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
