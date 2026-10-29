import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initJobsDb } from '../src/db/jobs/jobs.js';
import { listProviderModels } from '../src/db/jobs/provider-models.js';
import { FallbackDispatcher } from '../src/providers/fallback.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { migrateProvidersConfigIfNeeded } from '../src/providers/migrate-providers.js';
import { updateConfigYamlCatalogPath } from '../src/config.js';
import { isLegacyProvidersFile } from '../src/providers/registry-types.js';

let dir: string;
let providersPath: string;
let dbPath: string;

const LEGACY_FIXTURE = {
  retry_defaults: { max_retries: 3, backoff_seconds: [2, 8, 32] },
  providers: {
    ollama: {
      name: 'Ollama (Local)',
      tool_calling: false,
      base_url_env: 'OLLAMA_HOST',
      base_url_default: 'http://localhost:11434/v1',
      api_key: 'ollama',
      auto_discover: true,
      native_chat: true,
      models: [],
    },
    cloud: {
      name: 'Cloud',
      base_url: 'http://127.0.0.1:1/v1',
      api_key_env: 'CLOUD_KEY',
      auto_discover: false,
      models: [
        { id: 'vision-ok', name: 'Vision OK', vision: true },
        { id: 'text-only', name: 'Text', vision: false },
      ],
    },
    parked: {
      name: 'Parked',
      enabled: false,
      base_url: 'http://127.0.0.1:1/v1',
      api_key: 'x',
      auto_discover: false,
      models: [{ id: 'm1', name: 'M1', vision: true }],
    },
  },
  defaults: { description: { provider: 'ollama', model: 'llama3.2-vision' } },
  fallback_order: ['ollama', 'cloud', 'parked'],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-migrate-prov-'));
  providersPath = join(dir, 'providers.json');
  dbPath = join(dir, 'visualizer.db');
  process.env.LT_PROVIDERS_JSON = providersPath;
  process.env.DATABASE_PATH = dbPath;
  writeFileSync(providersPath, JSON.stringify(LEGACY_FIXTURE, null, 2));
});

afterEach(() => {
  delete process.env.LT_PROVIDERS_JSON;
  delete process.env.DATABASE_PATH;
  delete process.env.OLLAMA_HOST;
  delete process.env.CLOUD_KEY;
  rmSync(dir, { recursive: true, force: true });
});

describe('migrateProvidersConfigIfNeeded', () => {
  it('rewrites legacy providers.json and seeds model rows once', () => {
    expect(isLegacyProvidersFile(JSON.parse(readFileSync(providersPath, 'utf8')))).toBe(true);
    expect(migrateProvidersConfigIfNeeded(providersPath, dbPath)).toBe(true);

    const next = JSON.parse(readFileSync(providersPath, 'utf8')) as {
      providers: Record<string, Record<string, unknown>>;
    };
    expect(isLegacyProvidersFile(next)).toBe(false);
    expect(next.providers.ollama!).toMatchObject({
      protocol: 'openai',
      enabled: true,
      auth: { mode: 'none' },
      base_url: { from: 'literal', value: 'http://localhost:11434/v1' },
    });
    expect(next.providers.ollama!.models).toBeUndefined();
    expect(next.providers.cloud!.auth).toEqual({
      mode: 'bearer',
      secret: { from: 'env', value: 'CLOUD_KEY' },
    });

    const db = initJobsDb(dbPath);
    try {
      const rows = listProviderModels(db);
      expect(rows.map((r) => `${r.provider_id}/${r.model_id}`).sort()).toEqual([
        'cloud/text-only',
        'cloud/vision-ok',
        'ollama/llama3.2-vision',
        'parked/m1',
      ]);
      const refused = rows.find((r) => r.model_id === 'text-only');
      expect(refused?.image_refused_reason).toBe('declared without image input');
      expect(refused?.image_refused_at).toBeTruthy();
    } finally {
      db.close();
    }

    const afterFirst = readFileSync(providersPath, 'utf8');
    expect(migrateProvidersConfigIfNeeded(providersPath, dbPath)).toBe(false);
    expect(readFileSync(providersPath, 'utf8')).toBe(afterFirst);
  });

  it('keeps the base URL variable when it is set at migration time', () => {
    process.env.OLLAMA_HOST = 'http://gpu.local:11434/v1';
    migrateProvidersConfigIfNeeded(providersPath, dbPath);
    const next = JSON.parse(readFileSync(providersPath, 'utf8')) as {
      providers: Record<string, Record<string, unknown>>;
    };
    expect(next.providers.ollama!.base_url).toEqual({ from: 'env', value: 'OLLAMA_HOST' });
  });

  it('writes providers.json mode 0600 on Unix', () => {
    migrateProvidersConfigIfNeeded(providersPath, dbPath);
    if (process.platform === 'win32') return;
    const mode = statSync(providersPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('resolves env-backed credentials at request time', () => {
    migrateProvidersConfigIfNeeded(providersPath, dbPath);
    process.env.CLOUD_KEY = 'first';
    const registry = new ProviderRegistry(providersPath);
    expect(registry.getClient('cloud').apiKey).toBe('first');
    process.env.CLOUD_KEY = 'rotated';
    expect(new ProviderRegistry(providersPath).getClient('cloud').apiKey).toBe('rotated');
  });

  it('skips a disabled provider in the fallback cascade', async () => {
    migrateProvidersConfigIfNeeded(providersPath, dbPath);
    process.env.CLOUD_KEY = 'secret';
    const parsed = JSON.parse(readFileSync(providersPath, 'utf8')) as {
      providers: Record<string, { enabled?: boolean }>;
    };
    parsed.providers.cloud!.enabled = false;
    writeFileSync(providersPath, JSON.stringify(parsed, null, 2));
    const registry = new ProviderRegistry(providersPath);
    expect(registry.isCascadeEligible('cloud')).toBe(false);
    const list = await registry.listProviders();
    expect(list.find((p) => p.id === 'cloud')!.available).toBe(false);
  });
});

describe('cascade after migration', () => {
  it('does not attempt a model marked as not taking images', async () => {
    migrateProvidersConfigIfNeeded(providersPath, dbPath);
    process.env.CLOUD_KEY = 'secret';
    const registry = new ProviderRegistry(providersPath);
    const attempts: string[] = [];
    const dispatcher = new FallbackDispatcher(registry);
    await expect(
      dispatcher.callWithFallback({
        operation: 'test',
        providerId: 'cloud',
        model: 'text-only',
        fnFactory: (_client, model) => async () => {
          attempts.push(model);
          throw new Error('should not run');
        },
      }),
    ).rejects.toThrow();

    expect(attempts).not.toContain('text-only');
    expect(attempts).toContain('vision-ok');
  });
});

describe('config.yaml permissions', () => {
  it('writes mode 0600 on Unix', () => {
    if (process.platform === 'win32') return;
    const configPath = join(dir, 'config.yaml');
    process.env.LT_CONFIG_YAML = configPath;
    updateConfigYamlCatalogPath(configPath, '/tmp/catalog.lrcat');
    const mode = statSync(configPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('fresh example bootstrap', () => {
  it('copies an empty provider list when providers.json is missing', () => {
    rmSync(providersPath);
    const registry = new ProviderRegistry(providersPath);
    expect(registry.providerIds).toEqual([]);
    expect(JSON.parse(readFileSync(providersPath, 'utf8')).fallback_order).toEqual([]);
  });
});
