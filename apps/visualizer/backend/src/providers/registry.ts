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
import { initJobsDb } from '../db/jobs/jobs.js';
import {
  clearProviderImageRefusalMarks,
  listProviderModels,
  visionFromRow,
  type ProviderModelRow,
} from '../db/jobs/provider-models.js';
import { writePrivateFile } from '../utils/private-file.js';
import { requestJson, type HttpEndpoint } from './http.js';
import {
  getProviderAddressProbe,
  upsertProviderAddressProbe,
} from '../db/jobs/provider-probes.js';
import { runAddressProbe, storedLiteralBaseAfterProbe } from './address-probe.js';
import {
  normalizeBaseUrlInput,
  providerAddressesEquivalent,
  providerHostKey,
} from './base-url.js';
import { migrateProvidersConfigIfNeeded } from './migrate-providers.js';
import { deriveProviderId } from './provider-id.js';
import type { ProviderClient } from './vision-client.js';
import type {
  CreateProviderInput,
  DefaultsEntry,
  ProviderAddressProbeSummary,
  ProviderAuthSummary,
  ProviderConfig,
  ProviderModelEntry,
  ProviderSummary,
  RegistryConfig,
  UpdateProviderInput,
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
  CreateProviderInput,
  DefaultsEntry,
  ProviderAddressProbeSummary,
  ProviderAuthSummary,
  ProviderConfig,
  ProviderModelEntry,
  ProviderSummary,
  RegistryConfig,
  UpdateProviderInput,
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
    const order = this.config.fallback_order ?? Object.keys(this.providers);
    return order.filter((id) => this.providers[id]?.protocol !== 'system_one');
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

  providerConfig(providerId: string): ProviderConfig | undefined {
    return this.providers[providerId];
  }

  providerConfigs(): Record<string, ProviderConfig> {
    return this.providers;
  }

  providerHasKey(cfg: ProviderConfig): boolean {
    if (cfg.auth.mode === 'none') return false;
    const secret = cfg.auth.secret;
    if (!secret) return false;
    if (secret.from === 'literal') return secret.value.length > 0;
    return Boolean(process.env[secret.value]);
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
      out.push(await this.buildProviderSummary(id, cfg));
    }
    return out;
  }

  async createProvider(input: CreateProviderInput): Promise<ProviderSummary> {
    const name = input.name.trim();
    if (!name) throw new RangeError('name is required');
    const base = normalizeBaseUrlInput(input.base_url);
    if (!base) throw new RangeError('base_url is required');

    const id = deriveProviderId(name, new Set(Object.keys(this.providers)));
    const cfg: ProviderConfig = {
      name,
      protocol: 'openai',
      enabled: true,
      base_url: { from: 'literal', value: base },
      auth: this.authFromCreateInput(input.auth),
      ...(input.extra_headers ? { extra_headers: { ...input.extra_headers } } : {}),
    };
    this.providers[id] = cfg;
    const order = this.fallbackOrder;
    if (!order.includes(id)) {
      this.config.fallback_order = [...order, id];
    }
    this.saveConfig();
    await this.runAndPersistAddressProbe(id, base);
    return await this.buildProviderSummary(id, cfg);
  }

  async updateProvider(providerId: string, input: UpdateProviderInput): Promise<ProviderSummary> {
    const cfg = this.providers[providerId];
    if (!cfg) throw new UnknownProviderError(providerId);

    const prevBase = cfg.base_url.value;
    let nextBase = prevBase;
    if (input.base_url !== undefined) {
      nextBase = normalizeBaseUrlInput(input.base_url);
      if (!nextBase) throw new RangeError('base_url must not be empty');
    }

    const hostChanged =
      input.base_url !== undefined &&
      providerHostKey(prevBase) !== providerHostKey(nextBase);
    const addressChanged =
      input.base_url !== undefined && !providerAddressesEquivalent(prevBase, nextBase);

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new RangeError('name must not be empty');
      cfg.name = name;
    }
    if (input.base_url !== undefined) {
      cfg.base_url = { ...cfg.base_url, from: 'literal', value: nextBase };
    }
    if (input.enabled !== undefined) {
      cfg.enabled = input.enabled;
    }
    if (input.extra_headers !== undefined) {
      cfg.extra_headers = { ...input.extra_headers };
    }
    if (input.auth) {
      this.applyAuthUpdate(cfg, input.auth, hostChanged);
    } else if (hostChanged) {
      this.clearAuthSecret(cfg);
    }

    if (addressChanged) {
      this.withJobsDbWrite((db) => clearProviderImageRefusalMarks(db, providerId));
    }

    this.saveConfig();
    const probeTrimmed =
      input.base_url !== undefined ? normalizeBaseUrlInput(input.base_url) : undefined;
    await this.runAndPersistAddressProbe(providerId, probeTrimmed);
    return await this.buildProviderSummary(providerId, cfg);
  }

  /** Run the address probe and store the outcome in `visualizer.db`. */
  async runAndPersistAddressProbe(
    providerId: string,
    trimmedBaseOverride?: string,
  ): Promise<ProviderAddressProbeSummary> {
    const cfg = this.providers[providerId];
    if (!cfg) throw new UnknownProviderError(providerId);
    const probeBase = trimmedBaseOverride ?? cfg.base_url.value;
    const http = this.buildHttpEndpoint(cfg);
    const { answered, url, error } = await runAddressProbe(
      {
        apiKey: http.apiKey,
        authMode: http.authMode,
        authHeaderName: http.authHeaderName,
        extraHeaders: http.extraHeaders,
        timeoutMs: 5000,
      },
      probeBase,
    );
    if (cfg.base_url.from === 'literal' && cfg.protocol !== 'system_one') {
      const stored = storedLiteralBaseAfterProbe(probeBase, { answered, url });
      if (stored !== cfg.base_url.value) {
        cfg.base_url.value = stored;
        this.saveConfig();
      }
    }
    const row: ProviderAddressProbeSummary = {
      answered,
      url,
      probed_at: new Date().toISOString(),
      error,
    };
    this.withJobsDbWrite((db) =>
      upsertProviderAddressProbe(db, {
        provider_id: providerId,
        answered,
        answered_url: url,
        probed_at: row.probed_at,
        error,
      }),
    );
    return row;
  }

  readStoredAddressProbe(providerId: string): ProviderAddressProbeSummary | null {
    if (!existsSync(config.VISUALIZER_DB)) return null;
    const db = openDb(config.VISUALIZER_DB, { readonly: true, vec: false });
    try {
      const row = getProviderAddressProbe(db, providerId);
      if (!row) return null;
      return {
        answered: row.answered,
        url: row.answered_url,
        probed_at: row.probed_at,
        error: row.error,
      };
    } finally {
      db.close();
    }
  }

  private async buildProviderSummary(id: string, cfg: ProviderConfig): Promise<ProviderSummary> {
    return {
      id,
      name: cfg.name,
      available: this.isAvailable(cfg),
      tool_calling: await this.resolveToolCalling(id, cfg),
      enabled: cfg.enabled !== false,
      base_url: { from: cfg.base_url.from, value: cfg.base_url.value },
      auth: this.authSummary(cfg),
      address_probe: this.readStoredAddressProbe(id),
    };
  }

  private authSummary(cfg: ProviderConfig): ProviderAuthSummary {
    const auth = cfg.auth;
    if (auth.mode === 'none') {
      return { mode: 'none', has_key: false };
    }
    const secret = auth.secret;
    if (!secret) {
      return { mode: auth.mode, header_name: auth.header_name, has_key: false };
    }
    if (secret.from === 'env') {
      const set = Boolean(process.env[secret.value]);
      return {
        mode: auth.mode,
        header_name: auth.header_name,
        has_key: set,
        secret_from: 'env',
        env_var: secret.value,
        env_set: set,
      };
    }
    return {
      mode: auth.mode,
      header_name: auth.header_name,
      has_key: secret.value.length > 0,
      secret_from: 'literal',
    };
  }

  private authFromCreateInput(auth: CreateProviderInput['auth']): ProviderConfig['auth'] {
    if (auth.mode === 'none') return { mode: 'none' };
    const key = auth.key?.trim() ?? '';
    if (!key) {
      return { mode: auth.mode, header_name: auth.header_name };
    }
    return {
      mode: auth.mode,
      header_name: auth.header_name,
      secret: { from: 'literal', value: key },
    };
  }

  private applyAuthUpdate(
    cfg: ProviderConfig,
    patch: NonNullable<UpdateProviderInput['auth']>,
    hostChanged: boolean,
  ): void {
    if (patch.mode !== undefined) {
      cfg.auth.mode = patch.mode;
    }
    if (patch.header_name !== undefined) {
      cfg.auth.header_name = patch.header_name;
    }
    if (patch.clear_key) {
      delete cfg.auth.secret;
    }
    if (patch.key !== undefined) {
      const key = patch.key.trim();
      if (key) {
        cfg.auth.secret = { from: 'literal', value: key };
      } else {
        delete cfg.auth.secret;
      }
    } else if (hostChanged) {
      this.clearAuthSecret(cfg);
    }
    if (cfg.auth.mode === 'none') {
      delete cfg.auth.secret;
      delete cfg.auth.header_name;
    }
  }

  private clearAuthSecret(cfg: ProviderConfig): void {
    if (cfg.auth.mode === 'none') return;
    delete cfg.auth.secret;
  }

  private withJobsDbWrite<T>(fn: (db: ReturnType<typeof initJobsDb>) => T): T {
    const db = initJobsDb(config.VISUALIZER_DB);
    try {
      return fn(db);
    } finally {
      db.close();
    }
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
    const cullingOnly = ids.filter((id) => this.providers[id]?.protocol === 'system_one');
    if (cullingOnly.length > 0) {
      throw new RangeError(`Provider(s) for culling only: [${cullingOnly.map((u) => `'${u}'`).join(', ')}]`);
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
      if (this.providers[providerId]?.protocol === 'system_one') {
        throw new RangeError(`Provider '${providerId}' is for culling only`);
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
    if (!cfg || cfg.enabled === false || cfg.protocol === 'system_one') return false;
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
    if (cfg.protocol === 'system_one') return base;
    if (cfg.base_url.from === 'env') {
      return base.endsWith('/v1') ? base : `${base}/v1`;
    }
    return base;
  }

  /** Base URL for System One requests (`GET /v1/models`, `POST /v1/systemone`). */
  resolveSystemOneBaseUrl(cfg: ProviderConfig): string {
    return this.resolveBaseUrl(cfg);
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
