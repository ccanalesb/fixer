import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { initJobsDb } from '../src/db/jobs/jobs.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { writeNewShapeProviders } from './helpers/provider-config.js';

let dir: string;
let providersPath: string;
let jobsDbPath: string;
let stub: Server | null = null;
const app = createApp();
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

function listenStub(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<string> {
  return new Promise((resolve) => {
    stub = createServer(handler);
    stub.listen(0, '127.0.0.1', () => {
      const port = (stub!.address() as AddressInfo).port;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-prov-base-'));
  providersPath = join(dir, 'providers.json');
  jobsDbPath = join(dir, 'visualizer.db');
  process.env.LT_PROVIDERS_JSON = providersPath;
  process.env.DATABASE_PATH = jobsDbPath;
  writeNewShapeProviders(providersPath, { providers: {}, defaults: {}, fallback_order: [] });
  initJobsDb(jobsDbPath).close();
});

afterEach(() => {
  stub?.close();
  stub = null;
  delete process.env.LT_PROVIDERS_JSON;
  delete process.env.DATABASE_PATH;
  delete process.env.LT_TEST_HOST;
  rmSync(dir, { recursive: true, force: true });
});

describe('literal base_url storage from probe', () => {
  it('keeps bare base when only /models answers and chat uses /chat/completions', async () => {
    const base = await listenStub((req, res) => {
      if (req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const res = await send('POST', '/api/providers/', {
      name: 'Proxy',
      base_url: base,
      auth: { mode: 'none' },
    });
    expect(res.status).toBe(201);
    const stored = (
      JSON.parse(readFileSync(providersPath, 'utf8')) as {
        providers: Record<string, { base_url: { value: string } }>;
      }
    ).providers.proxy!.base_url.value;
    expect(stored).toBe(base);

    const registry = new ProviderRegistry();
    expect(registry.getClient('proxy').baseUrl).toBe(base);
    expect(`${registry.getClient('proxy').baseUrl}/chat/completions`).toBe(`${base}/chat/completions`);
  });

  it('stores /v1 when only /v1/models answers', async () => {
    const host = await listenStub((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const bare = host;
    await send('POST', '/api/providers/', {
      name: 'V1 only',
      base_url: bare,
      auth: { mode: 'none' },
    });
    const stored = (
      JSON.parse(readFileSync(providersPath, 'utf8')) as {
        providers: Record<string, { base_url: { value: string } }>;
      }
    ).providers.v1_only!.base_url.value;
    expect(stored).toBe(`${bare}/v1`);
    expect(new ProviderRegistry().getClient('v1_only').baseUrl).toBe(`${bare}/v1`);
  });

  it('stores trimmed input when nothing answers', async () => {
    const base = await listenStub((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const typed = `${base}/custom/path`;
    await send('POST', '/api/providers/', {
      name: 'Silent',
      base_url: typed,
      auth: { mode: 'none' },
    });
    const stored = (
      JSON.parse(readFileSync(providersPath, 'utf8')) as {
        providers: Record<string, { base_url: { value: string } }>;
      }
    ).providers.silent!.base_url.value;
    expect(stored).toBe(typed);
  });
});

describe('duplicate address on create', () => {
  it('409s when a new literal matches an env-resolved base', async () => {
    writeNewShapeProviders(providersPath, {
      providers: {
        cloud: {
          name: 'Cloud',
          protocol: 'openai',
          enabled: true,
          base_url: { from: 'env', value: 'LT_TEST_HOST' },
          auth: { mode: 'none' },
        },
      },
      fallback_order: ['cloud'],
    });
    const base = await listenStub((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    process.env.LT_TEST_HOST = base;
    const conflict = await send('POST', '/api/providers/', {
      name: 'Dup',
      base_url: `${base}/v1`,
      auth: { mode: 'none' },
    });
    expect(conflict.status).toBe(409);
    expect(await json(conflict)).toEqual({
      error: 'There is already a provider at this address: Cloud',
    });
    expect(Object.keys((JSON.parse(readFileSync(providersPath, 'utf8')) as { providers: Record<string, unknown> }).providers)).toEqual(['cloud']);
  });
});

describe('resolveBaseUrl', () => {
  it('returns a migrated literal with /v1 unchanged', () => {
    writeNewShapeProviders(providersPath, {
      providers: {
        ollama: {
          name: 'Ollama',
          protocol: 'openai',
          enabled: true,
          base_url: { from: 'literal', value: 'http://localhost:11434/v1' },
          auth: { mode: 'none' },
        },
      },
      fallback_order: ['ollama'],
    });
    const registry = new ProviderRegistry();
    expect(registry.getClient('ollama').baseUrl).toBe('http://localhost:11434/v1');
  });

  it('appends /v1 for env base URLs without it', () => {
    writeNewShapeProviders(providersPath, {
      providers: {
        cloud: {
          name: 'Cloud',
          protocol: 'openai',
          enabled: true,
          base_url: { from: 'env', value: 'LT_TEST_HOST' },
          auth: { mode: 'none' },
        },
      },
      fallback_order: ['cloud'],
    });
    process.env.LT_TEST_HOST = 'http://gpu.local:11434';
    const registry = new ProviderRegistry();
    expect(registry.getClient('cloud').baseUrl).toBe('http://gpu.local:11434/v1');
  });
});
