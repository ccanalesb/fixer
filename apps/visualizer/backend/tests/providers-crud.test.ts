/**
 * Create, edit, key rules and address-probe persistence for providers.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { initJobsDb } from '../src/db/jobs/jobs.js';
import { getProviderAddressProbe } from '../src/db/jobs/provider-probes.js';
import { insertProviderModel } from '../src/db/jobs/provider-models.js';
import { writeNewShapeProviders, LOCAL_PROVIDER } from './helpers/provider-config.js';

let dir: string;
let providersPath: string;
let jobsDbPath: string;
let stub: Server | null = null;
let stubBase: string;
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

function startModelsStub(v1Only = false): Promise<void> {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      if (req.url === '/v1/models' || (!v1Only && req.url === '/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    stub.listen(0, '127.0.0.1', () => {
      const port = (stub!.address() as AddressInfo).port;
      stubBase = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lt-prov-crud-'));
  providersPath = join(dir, 'providers.json');
  jobsDbPath = join(dir, 'visualizer.db');
  process.env.LT_PROVIDERS_JSON = providersPath;
  process.env.DATABASE_PATH = jobsDbPath;
  writeNewShapeProviders(providersPath, { providers: {}, defaults: {}, fallback_order: [] });
  initJobsDb(jobsDbPath).close();
  await startModelsStub();
});

afterEach(() => {
  stub?.close();
  stub = null;
  delete process.env.LT_PROVIDERS_JSON;
  delete process.env.DATABASE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/providers/', () => {
  it('creates with only the address probe (no chat or extra models discovery)', async () => {
    const requests: string[] = [];
    stub?.close();
    await new Promise<void>((resolve) => {
      stub = createServer((req, res) => {
        requests.push(req.url ?? '');
        if (req.url === '/v1/models' || req.url === '/models') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
      stub.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (stub!.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    stubBase = base;

    const res = await send('POST', '/api/providers/', {
      name: 'Probe only',
      base_url: base,
      auth: { mode: 'none' },
    });
    expect(res.status).toBe(201);
    const body = await json<{ tool_calling: boolean }>(res);
    expect(body.tool_calling).toBe(false);
    expect(requests.some((u) => u.includes('chat'))).toBe(false);
    expect(requests.every((u) => u === '/v1/models' || u === '/models')).toBe(true);
    expect(requests.length).toBeLessThanOrEqual(2);
  });

  it('creates a provider, stores a literal key off the wire, and persists the probe', async () => {
    const res = await send('POST', '/api/providers/', {
      name: 'Stub',
      base_url: `${stubBase}/v1/chat/completions`,
      auth: { mode: 'bearer', key: 'secret-key' },
    });
    expect(res.status).toBe(201);
    const body = await json<{
      id: string;
      has_key?: never;
      auth: { has_key: boolean; secret_from?: string };
      address_probe: { answered: boolean; url: string | null };
    }>(res);
    expect(body.id).toBe('stub');
    expect(body.auth.has_key).toBe(true);
    expect(body.auth.secret_from).toBe('literal');
    expect(JSON.stringify(body)).not.toContain('secret-key');
    expect(body.address_probe.answered).toBe(true);
    expect(body.address_probe.url).toBe(`${stubBase}/v1/models`);

    const stored = (readProviders().providers as Record<string, { auth: { secret?: { value: string } } }>)
      .stub!;
    expect(stored.auth.secret?.value).toBe('secret-key');

    const db = new Database(jobsDbPath, { readonly: true });
    try {
      const row = getProviderAddressProbe(db, 'stub');
      expect(row?.answered).toBe(true);
      expect(row?.answered_url).toBe(`${stubBase}/v1/models`);
    } finally {
      db.close();
    }
  });

  it('409s when the address matches an existing provider (normalized variants)', async () => {
    await send('POST', '/api/providers/', {
      name: 'First',
      base_url: `${stubBase}/v1`,
      auth: { mode: 'none' },
    });
    const variants = [
      `${stubBase}`,
      `${stubBase}/`,
      `${stubBase}/v1/`,
      `${stubBase}/v1/chat/completions`,
    ];
    for (const base_url of variants) {
      const res = await send('POST', '/api/providers/', {
        name: 'Second',
        base_url,
        auth: { mode: 'none' },
      });
      expect(res.status).toBe(409);
      expect(await json(res)).toEqual({
        error: 'There is already a provider at this address: First',
      });
    }
    expect(Object.keys((readProviders().providers as Record<string, unknown>) ?? {})).toEqual([
      'first',
    ]);
  });

  it('accepts a different address', async () => {
    await send('POST', '/api/providers/', {
      name: 'A',
      base_url: stubBase,
      auth: { mode: 'none' },
    });
    const otherPort = Number(stubBase.match(/:(\d+)$/)![1]) + 1;
    const res = await send('POST', '/api/providers/', {
      name: 'B',
      base_url: `http://127.0.0.1:${otherPort}`,
      auth: { mode: 'none' },
    });
    expect(res.status).toBe(201);
    expect(Object.keys((readProviders().providers as Record<string, unknown>) ?? {}).sort()).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('PUT /api/providers/{id}', () => {
  it('allows changing the address to one another provider already uses', async () => {
    writeNewShapeProviders(providersPath, {
      providers: {
        a: {
          name: 'A',
          protocol: 'openai',
          enabled: true,
          base_url: { from: 'literal', value: `${stubBase}/v1` },
          auth: { mode: 'none' },
        },
        b: {
          name: 'B',
          protocol: 'openai',
          enabled: true,
          base_url: { from: 'literal', value: 'http://127.0.0.1:59997' },
          auth: { mode: 'none' },
        },
      },
      fallback_order: ['a', 'b'],
    });
    const res = await send('PUT', '/api/providers/b', { base_url: `${stubBase}` });
    expect(res.status).toBe(200);
  });

  it('keeps the id when the name changes', async () => {
    writeNewShapeProviders(providersPath, {
      providers: { local: LOCAL_PROVIDER },
      fallback_order: ['local'],
    });
    const res = await send('PUT', '/api/providers/local', { name: 'Renamed local' });
    expect(res.status).toBe(200);
    const body = await json<{ provider: { id: string; name: string } }>(res);
    expect(body.provider).toMatchObject({ id: 'local', name: 'Renamed local' });
    expect((readProviders().providers as Record<string, unknown>).local).toBeTruthy();
  });

  it('clears the key when the host changes but keeps it on a port change', async () => {
    writeNewShapeProviders(providersPath, {
      providers: {
        edge: {
          ...LOCAL_PROVIDER,
          name: 'Edge',
          base_url: { from: 'literal', value: `${stubBase}` },
        },
      },
      fallback_order: ['edge'],
    });
    const otherHost = stubBase.replace('127.0.0.1', '127.0.0.2');
    const hostRes = await send('PUT', '/api/providers/edge', { base_url: otherHost });
    expect(hostRes.status).toBe(200);
    expect(
      (readProviders().providers as Record<string, { auth: { secret?: unknown } }>).edge!.auth.secret,
    ).toBeUndefined();

    writeNewShapeProviders(providersPath, {
      providers: {
        edge: {
          ...LOCAL_PROVIDER,
          name: 'Edge',
          base_url: { from: 'literal', value: `${stubBase}` },
          auth: {
            mode: 'bearer',
            secret: { from: 'literal', value: 'keep-me' },
          },
        },
      },
      fallback_order: ['edge'],
    });
    const portRes = await send('PUT', '/api/providers/edge', {
      base_url: stubBase.replace(/:(\d+)$/, ':59999'),
    });
    expect(portRes.status).toBe(200);
    expect(
      (readProviders().providers as Record<string, { auth: { secret?: { value: string } } }>).edge!
        .auth.secret?.value,
    ).toBe('keep-me');
  }, 15_000);

  it('clears image-refusal marks on an address change but not on a key-only change', async () => {
    writeNewShapeProviders(providersPath, {
      providers: {
        edge: {
          ...LOCAL_PROVIDER,
          name: 'Edge',
          base_url: { from: 'literal', value: stubBase },
        },
      },
      fallback_order: ['edge'],
    });
    const db = initJobsDb(jobsDbPath);
    insertProviderModel(db, {
      providerId: 'edge',
      modelId: 'm',
      modelName: 'M',
      origin: 'user',
      acceptsImages: false,
      refusedReason: 'server refused image',
    });
    db.close();

    await send('PUT', '/api/providers/edge', { auth: { key: 'new-key' } });
    let row: { image_refused_at: string | null };
    {
      const check = new Database(jobsDbPath, { readonly: true });
      try {
        row = check
          .prepare('SELECT image_refused_at FROM provider_models WHERE provider_id = ?')
          .get('edge') as { image_refused_at: string | null };
      } finally {
        check.close();
      }
    }
    expect(row.image_refused_at).toBeTruthy();

    await send('PUT', '/api/providers/edge', {
      base_url: stubBase.replace(/:(\d+)$/, ':59998'),
    });
    {
      const check = new Database(jobsDbPath, { readonly: true });
      try {
        row = check
          .prepare('SELECT image_refused_at FROM provider_models WHERE provider_id = ?')
          .get('edge') as { image_refused_at: string | null };
      } finally {
        check.close();
      }
    }
    expect(row.image_refused_at).toBeNull();
  });
});

describe('probe persistence', () => {
  it('survives a new registry instance', async () => {
    const res = await send('POST', '/api/providers/', {
      name: 'Stub',
      base_url: stubBase,
      auth: { mode: 'none' },
    });
    expect(res.status).toBe(201);
    const body = await json<{ address_probe: { answered: boolean } }>(res);
    expect(body.address_probe.answered).toBe(true);

    const list = await json<{ address_probe: { answered: boolean } | null }[]>(
      await send('GET', '/api/providers/'),
    );
    expect(list.find(p => p)?.address_probe?.answered).toBe(true);
  });
});

describe('address probe fallback', () => {
  it('answers on /models when /v1/models is absent', async () => {
    stub?.close();
    await new Promise<void>((resolve) => {
      stub = createServer((req, res) => {
        if (req.url === '/models') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [] }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
      stub.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (stub!.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const res = await send('POST', '/api/providers/', {
      name: 'Plain models',
      base_url: base,
      auth: { mode: 'none' },
    });
    const body = await json<{ address_probe: { answered: boolean; url: string | null } }>(res);
    expect(body.address_probe.answered).toBe(true);
    expect(body.address_probe.url).toBe(`${base}/models`);
  });
});
