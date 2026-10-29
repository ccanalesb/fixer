/**
 * Park, remove, default repoint, and job cascade when a provider drops out.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { initJobsDb, createJob, getJob } from '../src/db/jobs/jobs.js';
import { insertProviderModel } from '../src/db/jobs/provider-models.js';
import { getProviderAddressProbe } from '../src/db/jobs/provider-probes.js';
import { JobRunner } from '../src/jobs/runner.js';
import { tick } from '../src/jobs/processor.js';
import { LibraryFixture } from './helpers/library-fixture.js';
import {
  CLOUD_PROVIDER,
  LOCAL_PROVIDER,
  writeNewShapeProviders,
} from './helpers/provider-config.js';
import { NO_PHOTO_PROVIDER_LEFT } from '../src/providers/fallback.js';
import type { Db } from '../src/db/connection.js';

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

let primaryServer: Server;
let backupServer: Server;
let primaryPort: number;
let backupPort: number;
let primaryCalls = 0;
let backupCalls = 0;

function startServers(): Promise<void> {
  primaryCalls = 0;
  backupCalls = 0;
  return new Promise((resolve) => {
    primaryServer = createServer((_req, res) => {
      primaryCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ summary: 'ok', subjects: ['x'] }) } }],
        }),
      );
    });
    backupServer = createServer((_req, res) => {
      backupCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ summary: 'backup', subjects: ['y'] }) } }],
        }),
      );
    });
    primaryServer.listen(0, '127.0.0.1', () => {
      primaryPort = (primaryServer.address() as { port: number }).port;
      backupServer.listen(0, '127.0.0.1', () => {
        backupPort = (backupServer.address() as { port: number }).port;
        resolve();
      });
    });
  });
}

function writeTwoProviderConfig(opts: { localEnabled?: boolean } = {}): void {
  writeNewShapeProviders(providersPath, {
    fallback_order: ['local', 'cloud'],
    defaults: { description: { provider: 'local', model: 'vision-1' } },
    providers: {
      local: {
        ...LOCAL_PROVIDER,
        enabled: opts.localEnabled ?? true,
        base_url: { from: 'literal', value: `http://127.0.0.1:${primaryPort}/v1` },
      },
      cloud: {
        ...CLOUD_PROVIDER,
        auth: { mode: 'bearer', secret: { from: 'literal', value: 'cloud-key' } },
        base_url: { from: 'literal', value: `http://127.0.0.1:${backupPort}/v1` },
      },
    },
  });
  const db = initJobsDb(jobsDbPath);
  db.exec('DELETE FROM provider_models;');
  for (const row of [
    { provider_id: 'local', model_id: 'vision-1', model_name: 'Vision One' },
    { provider_id: 'cloud', model_id: 'vision-2', model_name: 'Vision Two' },
  ]) {
    insertProviderModel(db, {
      providerId: row.provider_id,
      modelId: row.model_id,
      modelName: row.model_name,
      origin: 'config',
      acceptsImages: true,
      refusedReason: null,
    });
  }
  db.close();
}

const readProviders = (): Record<string, unknown> =>
  JSON.parse(readFileSync(providersPath, 'utf8')) as Record<string, unknown>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lt-park-'));
  providersPath = join(dir, 'providers.json');
  jobsDbPath = join(dir, 'visualizer.db');
  process.env.LT_PROVIDERS_JSON = providersPath;
  process.env.DATABASE_PATH = jobsDbPath;
  await startServers();
  writeTwoProviderConfig();
});

afterEach(async () => {
  delete process.env.LT_PROVIDERS_JSON;
  delete process.env.DATABASE_PATH;
  rmSync(dir, { recursive: true, force: true });
  await new Promise((r) => primaryServer.close(r));
  await new Promise((r) => backupServer.close(r));
});

describe('PUT park and unpark', () => {
  it('keeps the provider in providers.json with enabled false', async () => {
    const res = await send('PUT', '/api/providers/local', { enabled: false });
    expect(res.status).toBe(200);
    const cfg = (readProviders().providers as Record<string, { enabled?: boolean }>).local!;
    expect(cfg.enabled).toBe(false);

    const back = await send('PUT', '/api/providers/local', { enabled: true });
    expect(back.status).toBe(200);
    expect((readProviders().providers as Record<string, { enabled?: boolean }>).local!.enabled).not.toBe(
      false,
    );
  });

  it('repoints the description default when the default provider is parked', async () => {
    const res = await send('PUT', '/api/providers/local', { enabled: false });
    const body = await json<{ defaults_notice?: string }>(res);
    expect(body.defaults_notice).toMatch(/Now using Cloud/i);
    const defaults = readProviders().defaults as { description: { provider: string } };
    expect(defaults.description.provider).toBe('cloud');
  });
});

describe('DELETE provider', () => {
  it('removes models and the probe record for that provider', async () => {
    const db = initJobsDb(jobsDbPath);
    db.prepare(
      `INSERT INTO provider_address_probes (provider_id, answered, answered_url, probed_at, error)
       VALUES ('local', 1, 'http://x', '2020-01-01T00:00:00Z', NULL)`,
    ).run();
    db.close();

    const res = await send('DELETE', '/api/providers/local');
    expect(res.status).toBe(200);
    expect((readProviders().providers as Record<string, unknown>).local).toBeUndefined();

    const check = new Database(jobsDbPath, { readonly: true });
    expect(check.prepare('SELECT COUNT(*) AS c FROM provider_models WHERE provider_id = ?').get('local')).toEqual({
      c: 0,
    });
    expect(getProviderAddressProbe(check as unknown as Db, 'local')).toBeNull();
    check.close();
  });
});

describe('describe jobs when a named provider is parked or removed', () => {
  let fx: LibraryFixture;

  beforeEach(async () => {
    fx = new LibraryFixture().addForecastQuestions().activate();
    process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
    writeFileSync(join(dir, 'config.yaml'), 'library_db: null\n');
    const photo = join(dir, 'p.jpg');
    await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toFile(photo);
    fx.addImage({ key: 'k1', filepath: photo });
  });

  afterEach(() => {
    fx.cleanup();
    delete process.env.LT_CONFIG_YAML;
  });

  async function runDescribe(metadata: Record<string, unknown>) {
    const db = initJobsDb(jobsDbPath);
    const jobId = createJob(db, 'single_describe', metadata);
    await tick(db, new JobRunner(db));
    const job = getJob(db, jobId)!;
    db.close();
    return job;
  }

  it('logs that the provider is parked and uses the next one', async () => {
    writeTwoProviderConfig({ localEnabled: false });
    const job = await runDescribe({ image_key: 'k1', provider_id: 'local', provider_model: 'vision-1' });
    expect(job.status).toBe('completed');
    const parkedLine = job.logs.find((l) => l.message.includes('is parked'));
    expect(parkedLine?.message).toMatch(/Cloud/i);
    expect(backupCalls).toBeGreaterThan(0);
    expect(primaryCalls).toBe(0);
  });

  it('logs that the provider was removed and uses the cascade', async () => {
    const cfg = readProviders();
    delete (cfg.providers as Record<string, unknown>).local;
    writeFileSync(providersPath, JSON.stringify(cfg));
    const job = await runDescribe({ image_key: 'k1', provider_id: 'local', provider_model: 'vision-1' });
    expect(job.status).toBe('completed');
    expect(job.logs.some((l) => l.message.includes('was removed'))).toBe(true);
    expect(backupCalls).toBeGreaterThan(0);
  });

  it('fails when no provider left can read a photo', async () => {
    writeNewShapeProviders(providersPath, {
      fallback_order: ['local'],
      defaults: { description: { provider: 'local', model: 'vision-1' } },
      providers: {
        local: {
          ...LOCAL_PROVIDER,
          enabled: false,
          base_url: { from: 'literal', value: `http://127.0.0.1:${primaryPort}/v1` },
        },
      },
    });
    const job = await runDescribe({ image_key: 'k1', provider_id: 'local', provider_model: 'vision-1' });
    expect(job.status).toBe('failed');
    expect(job.error).toContain(NO_PHOTO_PROVIDER_LEFT);
  });
});
