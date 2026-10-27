/**
 * Sidecar behaviour: health, packaged SPA, loopback guards, stdin shutdown.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as appModelInstall from '../src/jobs/handlers/app-model-install.js';
import * as processor from '../src/jobs/processor.js';
import { createApp } from '../src/app.js';
import { assertLoopbackSocketHandshake, isAllowedHost } from '../src/middleware/loopback.js';
import { runGracefulShutdown } from '../src/lifecycle/shutdown.js';

const BACKEND_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const savedEnv = {
  LT_RESOURCES_DIR: process.env.LT_RESOURCES_DIR,
  LT_DATA_DIR: process.env.LT_DATA_DIR,
  LIBRARY_DB: process.env.LIBRARY_DB,
  FLASK_PORT: process.env.FLASK_PORT,
  FLASK_HOST: process.env.FLASK_HOST,
  FRONTEND_URL: process.env.FRONTEND_URL,
};

let tmp = '';
let resources = '';
let dataDir = '';
let dbPath = '';

function seedLibrary(path: string) {
  const db = new Database(path);
  db.exec('CREATE TABLE images (key TEXT PRIMARY KEY)');
  db.close();
}

function req(
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit & { host?: string; origin?: string } = {},
) {
  const headers = new Headers(init.headers);
  if (init.host) headers.set('host', init.host);
  if (init.origin) headers.set('origin', init.origin);
  const { host: _h, origin: _o, ...rest } = init;
  return app.request(path, { ...rest, headers });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (!addr || typeof addr === 'string') {
        s.close();
        reject(new Error('no port'));
        return;
      }
      const port = addr.port;
      s.close(() => resolve(port));
    });
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lt-sidecar-'));
  resources = join(tmp, 'resources');
  dataDir = join(tmp, 'data');
  mkdirSync(resources, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  dbPath = join(dataDir, 'library.db');
  seedLibrary(dbPath);
  delete process.env.LT_RESOURCES_DIR;
  delete process.env.LT_DATA_DIR;
  delete process.env.LIBRARY_DB;
  delete process.env.FLASK_PORT;
  delete process.env.FLASK_HOST;
  delete process.env.FRONTEND_URL;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('GET /api/health', () => {
  it('returns ok when library.db opens', async () => {
    process.env.LIBRARY_DB = dbPath;
    const app = createApp();
    const res = await req(app, '/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('returns 503 when library.db is missing', async () => {
    process.env.LIBRARY_DB = join(tmp, 'missing.db');
    const app = createApp();
    const res = await req(app, '/api/health');
    expect(res.status).toBe(503);
  });
});

describe('packaged SPA', () => {
  it('serves index.html at / and on a deep link', async () => {
    const frontend = join(resources, 'frontend');
    mkdirSync(frontend, { recursive: true });
    writeFileSync(join(frontend, 'index.html'), '<!doctype html><title>Fixer</title>');
    writeFileSync(join(frontend, 'logo.svg'), '<svg/>');
    process.env.LT_RESOURCES_DIR = resources;

    const app = createApp();
    const root = await req(app, '/');
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('Fixer');

    const deep = await req(app, '/insights/setup');
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('Fixer');

    const asset = await req(app, '/logo.svg');
    expect(asset.status).toBe(200);
  });

  it('does not serve the SPA without LT_RESOURCES_DIR', async () => {
    const app = createApp();
    const res = await req(app, '/');
    expect(res.status).toBe(404);
  });
});

describe('loopback guards', () => {
  beforeEach(() => {
    process.env.FLASK_PORT = '5001';
    process.env.LIBRARY_DB = dbPath;
  });

  it('accepts localhost and 127.0.0.1 Host values', () => {
    expect(isAllowedHost('localhost:5001', 5001)).toBe(true);
    expect(isAllowedHost('127.0.0.1:5001', 5001)).toBe(true);
    expect(isAllowedHost('evil.test:5001', 5001)).toBe(false);
  });

  it('accepts dev and backend Origins on POST', async () => {
    process.env.FRONTEND_URL = 'http://localhost:5173';
    const app = createApp();
    const okDev = await req(app, '/api/status', {
      method: 'POST',
      host: 'localhost:5001',
      origin: 'http://localhost:5173',
    });
    expect(okDev.status).not.toBe(403);

    const okBackend = await req(app, '/api/status', {
      method: 'POST',
      host: '127.0.0.1:5001',
      origin: 'http://127.0.0.1:5001',
    });
    expect(okBackend.status).not.toBe(403);
  });

  it('rejects a foreign Host and a foreign Origin on POST', async () => {
    const app = createApp();
    const badHost = await req(app, '/api/health', { host: 'example.com:5001' });
    expect(badHost.status).toBe(403);

    const badOrigin = await req(app, '/api/health', {
      method: 'POST',
      host: 'localhost:5001',
      origin: 'https://evil.example',
    });
    expect(badOrigin.status).toBe(403);
  });

  it('allows GET without Origin', async () => {
    const app = createApp();
    const res = await req(app, '/api/health', { host: 'localhost:5001' });
    expect(res.status).toBe(200);
  });

  it('validates socket handshakes the same way', () => {
    expect(
      assertLoopbackSocketHandshake({ host: 'localhost:5001', origin: 'http://localhost:5173' }, 5001),
    ).toBe(true);
    expect(assertLoopbackSocketHandshake({ host: 'attacker:5001' }, 5001)).toBe(false);
    expect(
      assertLoopbackSocketHandshake(
        { host: 'localhost:5001', origin: 'https://attacker' },
        5001,
      ),
    ).toBe(false);
  });
});

describe('graceful shutdown', () => {
  it('stops jobs and conversions', () => {
    const stopJobs = vi.spyOn(processor, 'stopJobProcessor').mockImplementation(() => undefined);
    const stopConv = vi
      .spyOn(appModelInstall, 'stopRunningConversions')
      .mockImplementation(() => undefined);
    const io = { close: () => undefined } as unknown as import('socket.io').Server;
    const server = { close: (cb: () => void) => cb() } as import('node:http').Server;
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    runGracefulShutdown({ io, server }, 'TEST');
    expect(stopJobs).toHaveBeenCalled();
    expect(stopConv).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);

    exit.mockRestore();
    stopJobs.mockRestore();
    stopConv.mockRestore();
  });
});

describe('stdin EOF shutdown', () => {
  it('exits when stdin closes with LT_EXIT_ON_STDIN_EOF=1', async () => {
    const port = await freePort();
    const visDb = join(dataDir, 'visualizer.db');
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      ['--import', 'tsx', join(BACKEND_ROOT, 'src/server.ts')],
      {
        cwd: BACKEND_ROOT,
        env: {
          ...process.env,
          LT_EXIT_ON_STDIN_EOF: '1',
          LT_DATA_DIR: dataDir,
          LIBRARY_DB: dbPath,
          DATABASE_PATH: visDb,
          FLASK_HOST: '127.0.0.1',
          FLASK_PORT: String(port),
          NODE_ENV: 'test',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    const exited = new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 30_000);
      child.on('exit', (code) => {
        clearTimeout(t);
        resolve(code ?? 1);
      });
      child.on('error', reject);
    });

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 15_000;
      const poll = async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/health`);
          if (res.ok) {
            resolve();
            return;
          }
        } catch {
          // not up yet
        }
        if (Date.now() > deadline) reject(new Error('server never listened'));
        else setTimeout(() => void poll(), 100);
      };
      void poll();
    });

    child.stdin.end();
    expect(await exited).toBe(0);
  }, 35_000);
});
