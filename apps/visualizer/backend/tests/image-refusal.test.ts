import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { initJobsDb } from '../src/db/jobs/jobs.js';
import { insertProviderModel } from '../src/db/jobs/provider-models.js';
import { ImageRefusedError } from '../src/providers/errors.js';
import { FallbackDispatcher } from '../src/providers/fallback.js';
import { isImageRefusalResponse } from '../src/providers/image-refusal.js';
import { generateDescription } from '../src/providers/vision-client.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { LibraryFixture } from './helpers/library-fixture.js';
import { writeNewShapeProviders, LOCAL_PROVIDER, CLOUD_PROVIDER } from './helpers/provider-config.js';

describe('isImageRefusalResponse', () => {
  const path = '/chat/completions';

  it.each([
    [400, 'this model does not support image input', path, true],
    [400, 'multimodal not supported', path, true],
    [400, 'unknown field image_url', path, true],
    [400, 'wrong modality for request', path, true],
    [404, 'not found', path, true],
    [404, 'not found', '/v1/models', false],
    [400, 'invalid model name foo', path, false],
    [400, 'context length exceeded', path, false],
    [503, 'overloaded', path, false],
    [500, 'internal error', path, false],
  ])('status %i with %j on %s -> %s', (status, body, requestPath, expected) => {
    expect(isImageRefusalResponse(status, body, requestPath)).toBe(expected);
  });
});

describe('FallbackDispatcher image refusal', () => {
  let dir: string;
  let providersPath: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lt-img-ref-'));
    providersPath = join(dir, 'providers.json');
    dbPath = join(dir, 'visualizer.db');
    process.env.LT_PROVIDERS_JSON = providersPath;
    process.env.DATABASE_PATH = dbPath;
    writeNewShapeProviders(providersPath, {
      providers: { local: LOCAL_PROVIDER, cloud: CLOUD_PROVIDER },
      fallback_order: ['local', 'cloud'],
    });
    const db = initJobsDb(dbPath);
    for (const row of [
      { provider_id: 'local', model_id: 'bad', model_name: 'Bad', vision: 1 },
      { provider_id: 'local', model_id: 'good', model_name: 'Good', vision: 1 },
      { provider_id: 'cloud', model_id: 'backup', model_name: 'Backup', vision: 1 },
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
    process.env.LT_TEST_CLOUD_KEY = 'secret';
  });

  afterEach(() => {
    delete process.env.LT_PROVIDERS_JSON;
    delete process.env.DATABASE_PATH;
    delete process.env.LT_TEST_CLOUD_KEY;
    rmSync(dir, { recursive: true, force: true });
  });

  it('marks the model and continues with the next provider', async () => {
    const registry = new ProviderRegistry(providersPath);
    const logs: string[] = [];
    const dispatcher = new FallbackDispatcher(registry);
    const attempts: string[] = [];

    const result = await dispatcher.callWithFallback({
      operation: 'describe',
      providerId: 'local',
      model: 'bad',
      logCallback: (_level, msg) => logs.push(msg),
      fnFactory: (_client, model) => async () => {
        attempts.push(model);
        if (model === 'bad') {
          throw new ImageRefusedError('400: no images', { provider: 'local', model: 'bad' }, 'no image input');
        }
        return 'ok';
      },
    });

    expect(result).toEqual({ result: 'ok', providerId: 'local', model: 'good' });
    expect(attempts).toEqual(['bad', 'good']);

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare('SELECT image_refused_reason FROM provider_models WHERE provider_id = ? AND model_id = ?')
      .get('local', 'bad') as { image_refused_reason: string };
    db.close();
    expect(row.image_refused_reason).toBe('no image input');
    expect(logs.some((line) => line.includes("doesn't take images"))).toBe(true);
  });

  it('skips a marked model on a later job without calling it', async () => {
    const registry = new ProviderRegistry(providersPath);
    const attempts: string[] = [];
    const dispatcher = new FallbackDispatcher(registry);

    await dispatcher.callWithFallback({
      operation: 'describe',
      providerId: 'local',
      model: 'bad',
      fnFactory: (_client, model) => async () => {
        attempts.push(model);
        if (model === 'bad') {
          throw new ImageRefusedError('400: no images', { provider: 'local', model: 'bad' }, 'no image input');
        }
        return 'ok';
      },
    });

    attempts.length = 0;
    await dispatcher.callWithFallback({
      operation: 'describe',
      providerId: 'local',
      model: 'bad',
      fnFactory: (_client, model) => async () => {
        attempts.push(model);
        return 'again';
      },
    });

    expect(attempts).not.toContain('bad');
    expect(attempts[0]).toBe('good');
  });
});

describe('describe cascade over HTTP', () => {
  let fx: LibraryFixture;
  let dir: string;
  let server: Server;
  let port: number;
  let reply: { status: number; body: unknown };
  let callCount: Record<string, number>;
  const app = createApp();

  function startServer(): Promise<void> {
    return new Promise((resolve) => {
      server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          const parsed = raw ? (JSON.parse(raw) as { model?: string }) : {};
          const model = parsed.model ?? 'unknown';
          callCount[model] = (callCount[model] ?? 0) + 1;
          res.writeHead(reply.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(reply.body));
        });
      });
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lt-img-http-'));
    fx = new LibraryFixture().activate();
    callCount = {};
    reply = { status: 200, body: { choices: [{ message: { content: '{"summary":"ok"}' } }] } };
    await startServer();
    process.env.DATABASE_PATH = join(dir, 'visualizer.db');
    const db = initJobsDb(process.env.DATABASE_PATH);
    insertProviderModel(db, {
      providerId: 'primary',
      modelId: 'refuser',
      modelName: 'Refuser',
      origin: 'config',
      acceptsImages: true,
      refusedReason: null,
    });
    insertProviderModel(db, {
      providerId: 'fallback',
      modelId: 'vision',
      modelName: 'Vision',
      origin: 'config',
      acceptsImages: true,
      refusedReason: null,
    });
    db.close();
    writeFileSync(
      join(dir, 'providers.json'),
      JSON.stringify({
        retry_defaults: { max_retries: 1, backoff_seconds: [0] },
        fallback_order: ['primary', 'fallback'],
        defaults: { description: { provider: 'primary', model: 'refuser' } },
        providers: {
          primary: {
            name: 'Primary',
            base_url: `http://127.0.0.1:${port}/v1`,
            api_key: 'k',
            tool_calling: false,
            auto_discover: false,
          },
          fallback: {
            name: 'Fallback',
            base_url: `http://127.0.0.1:${port}/v1`,
            api_key: 'k',
            tool_calling: false,
            auto_discover: false,
          },
        },
      }),
    );
    writeFileSync(join(dir, 'config.yaml'), `vision_cache_dir: ${join(dir, 'vision')}\n`);
    process.env.LT_PROVIDERS_JSON = join(dir, 'providers.json');
    process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
  });

  afterEach(async () => {
    delete process.env.LT_PROVIDERS_JSON;
    delete process.env.LT_CONFIG_YAML;
    delete process.env.DATABASE_PATH;
    fx.cleanup();
    rmSync(dir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  });

  it('marks a model on image 400 and describes with the fallback provider', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    callCount = {};
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const parsed = raw ? (JSON.parse(raw) as { model?: string }) : {};
        const model = parsed.model ?? 'unknown';
        callCount[model] = (callCount[model] ?? 0) + 1;
        if (model === 'refuser') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ error: { message: 'image input is not supported for this model' } }),
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '{"summary":"from fallback"}' } }] }));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port;
        writeFileSync(
          join(dir, 'providers.json'),
          JSON.stringify({
            retry_defaults: { max_retries: 1, backoff_seconds: [0] },
            fallback_order: ['primary', 'fallback'],
            defaults: { description: { provider: 'primary', model: 'refuser' } },
            providers: {
              primary: {
                name: 'Primary',
                base_url: `http://127.0.0.1:${port}/v1`,
                api_key: 'k',
                tool_calling: false,
                auto_discover: false,
              },
              fallback: {
                name: 'Fallback',
                base_url: `http://127.0.0.1:${port}/v1`,
                api_key: 'k',
                tool_calling: false,
                auto_discover: false,
              },
            },
          }),
        );
        resolve();
      });
    });

    const path = join(dir, 'photo.jpg');
    await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toFile(path);
    fx.addImage({ key: 'a', filepath: path });

    const res = await app.request('/api/descriptions/a/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider_id: 'primary', provider_model: 'refuser' }),
    });
    expect(res.status).toBe(200);

    const db = new Database(process.env.DATABASE_PATH!, { readonly: true });
    const marked = db
      .prepare('SELECT image_refused_reason FROM provider_models WHERE provider_id = ? AND model_id = ?')
      .get('primary', 'refuser') as { image_refused_reason: string };
    db.close();
    expect(marked.image_refused_reason).toContain('image input');
    expect(callCount.refuser).toBe(1);
    expect(callCount.vision).toBe(1);
  });
});

describe('generateDescription maps 404 on chat completions', () => {
  it('throws ImageRefusedError', async () => {
    let server: Server;
    const port = await new Promise<number>((resolve) => {
      server = createServer((req, res) => {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });

    const client = {
      providerId: 'p',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'k',
      extraHeaders: {},
      timeoutMs: 5000,
    };
    const path = join(tmpdir(), 'tiny.jpg');
    await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#000' },
    })
      .jpeg()
      .toFile(path);

    await expect(
      generateDescription(client, 'm', path, { fallbackPrompt: 'describe' }),
    ).rejects.toBeInstanceOf(ImageRefusedError);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
