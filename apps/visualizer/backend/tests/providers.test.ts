/**
 * Providers route tests.
 *
 * Every test points `LT_PROVIDERS_JSON` at a temp file. Without that these would
 * rewrite the user's real provider list — `PUT /fallback-order`, `PUT /defaults`,
 * `PUT /models/order` and `DELETE /models/{id}` all save `providers.json`.
 *
 * No test lets a provider reach the network: the fixtures declare `tool_calling`
 * explicitly (which short-circuits the live probe) and leave `auto_discover` off.
 * The one test that does exercise discovery points the base URL at a closed port.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { initJobsDb } from '../src/db/jobs/jobs.js';
import { insertProviderModel } from '../src/db/jobs/provider-models.js';
import { applyModelOrder } from '../src/providers/registry.js';
import {
  CLOUD_PROVIDER,
  DEFAULT_LOCAL_MODELS,
  LOCAL_PROVIDER,
  writeNewShapeProviders,
} from './helpers/provider-config.js';

let dir: string;
let providersPath: string;
let jobsDbPath: string;
const app = createApp();
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

const readProviders = (): Record<string, unknown> =>
  JSON.parse(readFileSync(providersPath, 'utf8')) as Record<string, unknown>;

interface StoredProvider {
  model_order?: string[];
}

const localConfig = (): StoredProvider =>
  (readProviders().providers as Record<string, StoredProvider>).local ?? {};

/** A providers.json with no network-touching behaviour. */
function writeProviders(overrides: Record<string, unknown> = {}): void {
  writeNewShapeProviders(providersPath, {
    providers: (overrides.providers as Record<string, unknown>) ?? {
      local: LOCAL_PROVIDER,
      cloud: CLOUD_PROVIDER,
    },
    defaults: overrides.defaults as Record<string, unknown> | undefined,
    fallback_order: overrides.fallback_order as string[] | undefined,
    retry_defaults: overrides.retry_defaults as Record<string, unknown> | undefined,
  });
  seedJobsDb(DEFAULT_LOCAL_MODELS);
}

/** `visualizer.db` provider model rows. */
function seedJobsDb(
  rows: {
    provider_id: string;
    model_id: string;
    model_name: string;
    vision?: number;
    image_refused_at?: string | null;
    image_refused_reason?: string | null;
    origin?: 'config' | 'user';
  }[] = DEFAULT_LOCAL_MODELS,
): void {
  const db = initJobsDb(jobsDbPath);
  db.exec('DELETE FROM provider_models;');
  for (const r of rows) {
    insertProviderModel(db, {
      providerId: r.provider_id,
      modelId: r.model_id,
      modelName: r.model_name,
      origin: r.origin ?? 'config',
      acceptsImages: (r.vision ?? 1) === 1 && !r.image_refused_at,
      refusedReason:
        r.image_refused_reason ??
        ((r.vision ?? 1) === 0 ? 'declared without image input' : null),
    });
  }
  db.close();
}

const userModels = (providerId?: string): { provider_id: string; model_id: string }[] => {
  const db = new Database(jobsDbPath, { readonly: true });
  try {
    if (providerId) {
      return db
        .prepare(
          'SELECT provider_id, model_id FROM provider_models WHERE provider_id = ? ORDER BY model_id',
        )
        .all(providerId) as { provider_id: string; model_id: string }[];
    }
    return db
      .prepare('SELECT provider_id, model_id FROM provider_models ORDER BY provider_id, model_id')
      .all() as { provider_id: string; model_id: string }[];
  } finally {
    db.close();
  }
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-prov-'));
  providersPath = join(dir, 'providers.json');
  jobsDbPath = join(dir, 'visualizer.db');
  process.env.LT_PROVIDERS_JSON = providersPath;
  process.env.DATABASE_PATH = jobsDbPath;
  delete process.env.LT_TEST_CLOUD_KEY;
  writeProviders();
  seedJobsDb();
});

afterEach(() => {
  delete process.env.LT_PROVIDERS_JSON;
  delete process.env.DATABASE_PATH;
  delete process.env.LT_TEST_CLOUD_KEY;
  rmSync(dir, { recursive: true, force: true });
});

describe('applyModelOrder', () => {
  const models = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];

  it('returns the input unchanged with no order', () => {
    expect(applyModelOrder(models, []).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('applies the order and appends what it does not mention', () => {
    // `c` is not in the order — a newly pulled Ollama model would be exactly this,
    // and dropping it would make it invisible in the UI.
    expect(applyModelOrder(models, ['b', 'a']).map((m) => m.id)).toEqual(['b', 'a', 'c']);
  });

  it('ignores ordered ids that no longer exist', () => {
    expect(applyModelOrder(models, ['gone', 'c']).map((m) => m.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('GET /api/providers/', () => {
  it('returns a bare array with availability per provider', async () => {
    const res = await send('GET', '/api/providers/');
    expect(res.status).toBe(200);
    const body = await json<{ id: string; name: string; available: boolean; tool_calling: boolean }[]>(res);

    // A top-level array, not an object wrapping one.
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual([
      { id: 'local', name: 'Local', available: true, tool_calling: false },
      // `cloud` needs LT_TEST_CLOUD_KEY, which is unset.
      { id: 'cloud', name: 'Cloud', available: false, tool_calling: true },
    ]);
  });

  it('reports a provider as available once its key env var is set', async () => {
    process.env.LT_TEST_CLOUD_KEY = 'secret';
    const body = await json<{ id: string; available: boolean }[]>(
      await send('GET', '/api/providers/'),
    );
    expect(body.find((p) => p.id === 'cloud')!.available).toBe(true);
  });

  it('bootstraps providers.json from the example when it is missing', async () => {
    rmSync(providersPath);
    const res = await send('GET', '/api/providers/');
    expect(res.status).toBe(200);
    // First run must leave a usable config behind rather than erroring.
    expect(Object.keys(readProviders())).toContain('providers');
  });
});

describe('fallback order', () => {
  it('returns the configured order', async () => {
    expect(await json(await send('GET', '/api/providers/fallback-order'))).toEqual({
      order: ['local', 'cloud'],
    });
  });

  it('replaces it and persists', async () => {
    const res = await send('PUT', '/api/providers/fallback-order', { order: ['cloud', 'local'] });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ order: ['cloud', 'local'] });
    expect(readProviders().fallback_order).toEqual(['cloud', 'local']);
  });

  it('de-duplicates, keeping the first occurrence', async () => {
    const res = await send('PUT', '/api/providers/fallback-order', {
      order: ['cloud', 'local', 'cloud'],
    });
    expect(await json(res)).toEqual({ order: ['cloud', 'local'] });
  });

  it.each([
    [{}, 'order is required'],
    [{ order: [] }, 'fallback order must not be empty'],
    [{ order: ['nope'] }, "Unknown provider id(s): ['nope']"],
  ])('400s on %j', async (body, message) => {
    const res = await send('PUT', '/api/providers/fallback-order', body);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: message });
  });

  it('does not write when validation fails', async () => {
    await send('PUT', '/api/providers/fallback-order', { order: ['nope'] });
    expect(readProviders().fallback_order).toEqual(['local', 'cloud']);
  });
});

describe('defaults', () => {
  it('returns and updates the description default', async () => {
    expect(await json(await send('GET', '/api/providers/defaults'))).toEqual({
      description: { provider: 'local', model: null },
    });

    const res = await send('PUT', '/api/providers/defaults', {
      description: { provider: 'cloud', model: 'vision-1' },
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ description: { provider: 'cloud', model: 'vision-1' } });
    expect(readProviders().defaults).toEqual({
      description: { provider: 'cloud', model: 'vision-1' },
    });
  });

  it.each([
    [{}, 'defaults must include description'],
    [{ retired: { provider: 'local' } }, "Unknown defaults key: 'retired'"],
    [{ description: 'local' }, 'description must be an object'],
    [{ description: {} }, 'description requires provider'],
    [{ description: { provider: 'nope' } }, 'Unknown provider: nope'],
  ])('400s on %j', async (body, message) => {
    const res = await send('PUT', '/api/providers/defaults', body);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: message });
  });

  it('drops a retired defaults key on read without rewriting the file', async () => {
    writeProviders({
      defaults: { description: { provider: 'local', model: null }, retired_kind: { provider: 'local' } },
    });
    const body = await json<Record<string, unknown>>(await send('GET', '/api/providers/defaults'));
    // Ignored in memory …
    expect(Object.keys(body)).toEqual(['description']);
    // … but the user's file is left intact, so nothing is destroyed on load.
    expect(Object.keys(readProviders().defaults as object)).toContain('retired_kind');
  });

  it('cannot write a retired key back through a merge', async () => {
    writeProviders({
      defaults: { description: { provider: 'local', model: null }, retired_kind: { provider: 'local' } },
    });
    await send('PUT', '/api/providers/defaults', { description: { provider: 'cloud' } });
    expect(Object.keys(readProviders().defaults as object)).toEqual(['description']);
  });
});

describe('GET /api/providers/{id}/models', () => {
  it('lists stored models and folds in user-added ones', async () => {
    seedJobsDb([
      ...DEFAULT_LOCAL_MODELS,
      { provider_id: 'local', model_id: 'mine', model_name: 'My Model', vision: 1, origin: 'user' },
    ]);
    const res = await send('GET', '/api/providers/local/models');
    expect(res.status).toBe(200);
    const body = await json<{ id: string; source: string; vision?: boolean }[]>(res);

    expect(body.map((m) => [m.id, m.source])).toEqual([
      ['mine', 'user'],
      ['small', 'config'],
      ['vendor/big', 'config'],
    ]);
  });

  it('applies the custom order across stored and user models alike', async () => {
    writeProviders();
    seedJobsDb([
      ...DEFAULT_LOCAL_MODELS,
      { provider_id: 'local', model_id: 'mine', model_name: 'My Model', origin: 'user' },
    ]);
    await send('PUT', '/api/providers/local/models/order', { order: ['mine', 'small'] });

    const body = await json<{ id: string }[]>(await send('GET', '/api/providers/local/models'));
    // `vendor/big` is not in the order, so it lands at the end.
    expect(body.map((m) => m.id)).toEqual(['mine', 'small', 'vendor/big']);
  });

  it('404s for an unknown provider', async () => {
    const res = await send('GET', '/api/providers/nope/models');
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: 'Unknown provider: nope' });
  });
});

describe('POST /api/providers/{id}/models', () => {
  it('adds a user model, defaulting vision to true', async () => {
    const res = await send('POST', '/api/providers/local/models', { id: 'new', name: 'New' });
    expect(res.status).toBe(201);
    expect(await json(res)).toEqual({ id: 'new', name: 'New', vision: true, source: 'user' });
    expect(userModels('local').map((m) => m.model_id)).toEqual(['new', 'small', 'vendor/big']);
  });

  it('honours an explicit vision flag', async () => {
    const res = await send('POST', '/api/providers/local/models', {
      id: 'text-only',
      name: 'Text',
      vision: false,
    });
    expect(await json<{ vision: boolean }>(res)).toMatchObject({ vision: false });
  });

  it('409s on a duplicate', async () => {
    await send('POST', '/api/providers/local/models', { id: 'dup', name: 'Dup' });
    const res = await send('POST', '/api/providers/local/models', { id: 'dup', name: 'Dup' });
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: 'Model dup already exists for local' });
  });

  it.each([
    [undefined, 'id and name are required'],
    [{ name: 'No id' }, 'id must be a non-empty string'],
    [{ id: '  ', name: 'Blank id' }, 'id must be a non-empty string'],
    [{ id: 'ok' }, 'name must be a non-empty string'],
    [{ id: 'ok', name: 'ok', vision: 'yes' }, 'vision must be a boolean'],
  ])('400s on %j', async (body, message) => {
    const res = await send('POST', '/api/providers/local/models', body);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: message });
  });

  it('404s for an unknown provider before writing', async () => {
    const before = userModels('local');
    const res = await send('POST', '/api/providers/nope/models', { id: 'x', name: 'X' });
    expect(res.status).toBe(404);
    expect(userModels('local')).toEqual(before);
  });
});

describe('DELETE /api/providers/{id}/models/{model_id}', () => {
  it('removes a stored model row', async () => {
    const res = await send('DELETE', '/api/providers/local/models/small');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ deleted: true });
    expect(userModels('local')).toEqual([{ provider_id: 'local', model_id: 'vendor/big' }]);
  });

  it('deletes a model id containing a slash', async () => {
    const res = await send('DELETE', '/api/providers/local/models/vendor/big');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ deleted: true });
    expect(userModels('local').map((m) => m.model_id)).toEqual(['small']);
  });

  it('404s for an unknown model and an unknown provider', async () => {
    const missingModel = await send('DELETE', '/api/providers/local/models/ghost');
    expect(missingModel.status).toBe(404);
    expect(await json(missingModel)).toEqual({ error: 'Model not found' });

    const missingProvider = await send('DELETE', '/api/providers/nope/models/ghost');
    expect(missingProvider.status).toBe(404);
    expect(await json(missingProvider)).toEqual({ error: 'Unknown provider: nope' });
  });
});

describe('PUT /api/providers/{id}/models/order', () => {
  it('saves the order and keeps previously-known ids at the end', async () => {
    await send('PUT', '/api/providers/local/models/order', { order: ['a', 'b'] });
    const res = await send('PUT', '/api/providers/local/models/order', { order: ['b'] });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ success: true });

    // `a` was known before and is not in the new list, so it is appended rather
    // than forgotten — the UI does not always know about every cloud model.
    expect(localConfig().model_order).toEqual(['b', 'a']);
  });

  it('400s without an order and 404s for an unknown provider', async () => {
    const noOrder = await send('PUT', '/api/providers/local/models/order', {});
    expect(noOrder.status).toBe(400);
    expect(await json(noOrder)).toEqual({ error: 'order is required' });

    const unknown = await send('PUT', '/api/providers/nope/models/order', { order: ['a'] });
    expect(unknown.status).toBe(404);
    expect(await json(unknown)).toEqual({ error: 'Unknown provider: nope' });
  });
});

describe('GET /api/providers/{id}/health', () => {
  it('reports unreachable with the reason, as a 200', async () => {
    // Port 1 refuses connections. Provider down is a state the UI renders, not a
    // request failure.
    const res = await send('GET', '/api/providers/local/health');
    expect(res.status).toBe(200);
    const body = await json<{ reachable: boolean; error: string }>(res);
    expect(body.reachable).toBe(false);
    expect(body.error).toBeTruthy();
  });

  it('404s for an unknown provider', async () => {
    const res = await send('GET', '/api/providers/nope/health');
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: 'Unknown provider' });
  });
});

describe('GET /api/providers/models/description', () => {
  it('flattens every provider model with its tool-calling capability', async () => {
    const res = await send('GET', '/api/providers/models/description');
    expect(res.status).toBe(200);
    const body = await json<{
      models: { provider_id: string; provider_name: string; model_id: string; tool_calling: boolean }[];
      default_provider: string | null;
      default_model: string | null;
    }>(res);

    // Includes unavailable providers, unlike /api/vision-models.
    expect(body.models.map((m) => `${m.provider_id}:${m.model_id}`)).toEqual([
      'local:small',
      'local:vendor/big',
      'cloud:vision-1',
    ]);
    expect(body.models[0]!.tool_calling).toBe(false);
    expect(body.models.at(-1)!.tool_calling).toBe(true);
    expect(body.default_provider).toBe('local');
    expect(body.default_model).toBeNull();
  });
});

describe('GET /api/vision-models', () => {
  it('lists vision models from available providers only, marking a default', async () => {
    const res = await send('GET', '/api/vision-models');
    expect(res.status).toBe(200);
    const body = await json<{
      models: { name: string; provider_id?: string; default: boolean }[];
      fallback: boolean;
    }>(res);

    // `cloud` has no key, and `vendor/big` is not vision-capable.
    expect(body.models).toEqual([{ name: 'small', provider_id: 'local', default: true }]);
    expect(body.fallback).toBe(false);
  });

  it('adds user-added vision models', async () => {
    seedJobsDb([
      ...DEFAULT_LOCAL_MODELS,
      { provider_id: 'local', model_id: 'mine', model_name: 'Mine', vision: 1, origin: 'user' },
    ]);
    const body = await json<{ models: { name: string }[] }>(await send('GET', '/api/vision-models'));
    expect(body.models.map((m) => m.name).sort()).toEqual(['mine', 'small']);
  });

  it('marks exactly one default even when none matches the configured one', async () => {
    writeProviders({ defaults: { description: { provider: 'cloud', model: 'vision-1' } } });
    const body = await json<{ models: { name: string; default: boolean }[] }>(
      await send('GET', '/api/vision-models'),
    );
    // `cloud` is unavailable, so nothing matched — but something must be selected.
    expect(body.models.filter((m) => m.default)).toHaveLength(1);
    expect(body.models[0]!.default).toBe(true);
  });

  it('falls back rather than failing when nothing is configured', async () => {
    writeNewShapeProviders(providersPath, { providers: {}, defaults: {}, fallback_order: [] });
    seedJobsDb([]);
    const res = await send('GET', '/api/vision-models');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      models: [{ name: 'gemma3:27b', default: true }],
      fallback: true,
    });
  });

  it('falls back rather than 500ing on an unreadable providers.json', async () => {
    writeFileSync(providersPath, 'not json at all');
    const res = await send('GET', '/api/vision-models');
    // A broken config must still leave the description UI with something selectable.
    expect(res.status).toBe(200);
    expect(await json<{ fallback: boolean }>(res)).toMatchObject({ fallback: true });
  });
});
