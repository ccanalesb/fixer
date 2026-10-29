/**
 * Create, edit, probe and address-change impact for System One providers.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createApp } from '../src/app.js';
import { initJobsDb } from '../src/db/jobs/jobs.js';
import { getProviderAddressProbe } from '../src/db/jobs/provider-probes.js';
import { listProviderModels } from '../src/db/jobs/provider-models.js';
import { writeNewShapeProviders } from './helpers/provider-config.js';
import { LibraryFixture } from './helpers/library-fixture.js';
import { getOrCreateStageVersion, upsertStageAnswer } from '../src/db/library/cull-stages.js';
import { insertCullRun } from '../src/db/library/cull-verdicts.js';
import { seedCullingDefaults } from '../src/db/library/cull-profiles.js';
import { openLibraryDb } from '../src/db/connection.js';

let dir: string;
let providersPath: string;
let jobsDbPath: string;
let configPath: string;
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

function startModelsStub(): Promise<void> {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      if (req.url === '/v1/models' || req.url === '/models') {
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
  dir = mkdtempSync(join(tmpdir(), 'lt-prov-so-'));
  providersPath = join(dir, 'providers.json');
  jobsDbPath = join(dir, 'visualizer.db');
  configPath = join(dir, 'config.yaml');
  process.env.LT_PROVIDERS_JSON = providersPath;
  process.env.DATABASE_PATH = jobsDbPath;
  process.env.LT_CONFIG_YAML = configPath;
  writeFileSync(
    configPath,
    `culling_models:
  culling_profile:
    endpoint: studio_gpu
    model: clef-flash
  score_forecast:
    endpoint: this_app
    model: null
`,
  );
  writeNewShapeProviders(providersPath, { providers: {}, defaults: {}, fallback_order: [] });
  initJobsDb(jobsDbPath).close();
  await startModelsStub();
});

afterEach(() => {
  stub?.close();
  stub = null;
  delete process.env.LT_PROVIDERS_JSON;
  delete process.env.DATABASE_PATH;
  delete process.env.LT_CONFIG_YAML;
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/providers/ system_one', () => {
  it('creates a System One provider with typed models, probes /v1/models, and skips fallback order', async () => {
    const res = await send('POST', '/api/providers/', {
      name: 'Studio GPU',
      protocol: 'system_one',
      base_url: stubBase,
      models: ['clef-flash', 'jev-omni-3b'],
      auth: { mode: 'bearer', key: 'studio-key' },
    });
    expect(res.status).toBe(201);
    const body = await json<{
      id: string;
      protocol: string;
      address_probe: { answered: boolean; url: string | null };
    }>(res);
    expect(body.id).toBe('studio_gpu');
    expect(body.protocol).toBe('system_one');
    expect(body.address_probe.answered).toBe(true);
    expect(body.address_probe.url).toBe(`${stubBase}/v1/models`);

    const stored = JSON.parse(readFileSync(providersPath, 'utf8')) as {
      providers: Record<string, { protocol: string }>;
      fallback_order: string[];
    };
    expect(stored.providers['studio_gpu']!.protocol).toBe('system_one');
    expect(stored.fallback_order).toEqual([]);

    const db = new Database(jobsDbPath, { readonly: true });
    try {
      const models = listProviderModels(db, 'studio_gpu').map((r) => r.model_id).sort();
      expect(models).toEqual(['clef-flash', 'jev-omni-3b']);
      const probe = getProviderAddressProbe(db, 'studio_gpu');
      expect(probe?.answered).toBe(true);
    } finally {
      db.close();
    }
  });

  it('refuses create without model ids', async () => {
    const res = await send('POST', '/api/providers/', {
      name: 'Empty',
      protocol: 'system_one',
      base_url: stubBase,
      models: [],
      auth: { mode: 'bearer', key: 'k' },
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/providers/{id}/address-change-impact', () => {
  it('counts distinct photos answered on stages that use the provider', async () => {
    await send('POST', '/api/providers/', {
      name: 'Studio GPU',
      protocol: 'system_one',
      base_url: stubBase,
      models: ['clef-flash'],
      auth: { mode: 'bearer', key: 'studio-key' },
    });

    const fx = new LibraryFixture();
    process.env.LIBRARY_DB = fx.dbPath;
    try {
      const db = openLibraryDb(fx.dbPath);
      try {
        seedCullingDefaults(db);
        const versionId = getOrCreateStageVersion(db, {
          stageKey: 'culling_profile:default:7',
          kind: 'culling_profile',
          profileSlug: 'default',
          levelSet: '7',
          modelId: 'clef-flash@http://old',
          questions: { q: { type: 'score', instructions: 'q', criteria: ['a', 'b'] } },
        });
        const runId = insertCullRun(db, { kind: 'job', jobId: null, pipelineSettingVersion: 1 });
        for (const key of ['a', 'b', 'c']) {
          upsertStageAnswer(db, {
            imageKey: key,
            stageVersionId: versionId,
            answers: {},
            verdict: 'passed',
            decision: {},
            pipelineSettingVersion: 1,
            source: 'job',
            runId,
          });
        }
      } finally {
        db.close();
      }

      const res = await send('GET', '/api/providers/studio_gpu/address-change-impact');
      expect(res.status).toBe(200);
      const body = await json<{ photos: number; stages: { name: string }[] }>(res);
      expect(body.photos).toBe(3);
      expect(body.stages.map((s) => s.name)).toEqual(['Culling profile']);
    } finally {
      delete process.env.LIBRARY_DB;
      fx.cleanup();
    }
  });
});

describe('DELETE /api/providers/{id} system_one', () => {
  it('removes the provider and clears the endpoint on stages that used it', async () => {
    await send('POST', '/api/providers/', {
      name: 'Studio GPU',
      protocol: 'system_one',
      base_url: stubBase,
      models: ['clef-flash'],
      auth: { mode: 'bearer', key: 'studio-key' },
    });
    const res = await send('DELETE', '/api/providers/studio_gpu');
    expect(res.status).toBe(200);
    const cfg = parseYaml(readFileSync(configPath, 'utf8')) as {
      culling_models: { culling_profile: { endpoint: string; model: string } };
    };
    expect(cfg.culling_models.culling_profile).toEqual({ endpoint: '', model: 'clef-flash' });
    expect((JSON.parse(readFileSync(providersPath, 'utf8')) as { providers: Record<string, unknown> }).providers).toEqual(
      {},
    );
  });
});

describe('POST /api/providers/{id}/probe', () => {
  it('reports whether GET /v1/models answered for System One', async () => {
    await send('POST', '/api/providers/', {
      name: 'Studio GPU',
      protocol: 'system_one',
      base_url: stubBase,
      models: ['clef-flash'],
      auth: { mode: 'bearer', key: 'studio-key' },
    });
    const res = await send('POST', '/api/providers/studio_gpu/probe');
    expect(res.status).toBe(200);
    const body = await json<{ address_probe: { answered: boolean } }>(res);
    expect(body.address_probe.answered).toBe(true);
  });
});
