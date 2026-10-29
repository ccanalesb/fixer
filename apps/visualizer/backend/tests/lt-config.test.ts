/**
 * Config route tests.
 *
 * These routes WRITE `config.yaml`, so every test points `LT_CONFIG_YAML` at a temp
 * file. Without that override the suite would rewrite the user's real config.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createApp } from '../src/app.js';
import {
  initLibraryDb,
  setLibraryMeta,
  SYNCED_CATALOG_META_KEY,
} from '../src/db/library/bootstrap.js';
import { libraryWrite } from '../src/db/library/write.js';

let dir: string;
let cfgPath: string;
let libraryPath: string;
const app = createApp();
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

const put = (path: string, body: unknown) =>
  app.request(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const readCfg = (): Record<string, unknown> =>
  parseYaml(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;

const onMac = process.platform === 'darwin';

/** A library.db whose last catalog sync read `catalogPath`, or no sync at all. */
const seedLibrary = (catalogPath?: string): void => {
  const db = initLibraryDb(libraryPath);
  if (catalogPath) {
    libraryWrite(db, () => setLibraryMeta(db, SYNCED_CATALOG_META_KEY, catalogPath));
  }
  db.close();
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-cfg-'));
  cfgPath = join(dir, 'config.yaml');
  libraryPath = join(dir, 'library.db');
  process.env.LT_CONFIG_YAML = cfgPath;
  // Without this the sync-state read would open the developer's real library.db.
  process.env.LIBRARY_DB = libraryPath;
});

afterEach(() => {
  delete process.env.LT_CONFIG_YAML;
  delete process.env.LIBRARY_DB;
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/config/catalog', () => {
  it('reports the raw path, the expanded path, and whether it exists', async () => {
    const lrcat = join(dir, 'My Catalog.lrcat');
    writeFileSync(lrcat, 'x');
    writeFileSync(cfgPath, `catalog_path: ${JSON.stringify(lrcat)}\nworkers: 4\n`);

    const res = await app.request('/api/config/catalog');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      catalog_path: lrcat,
      resolved_path: lrcat,
      exists: true,
      picker_available: onMac,
      synced_catalog_path: null,
      needs_catalog_sync: false,
    });
  });

  it('reports exists: false for a configured but missing file', async () => {
    writeFileSync(cfgPath, 'catalog_path: /nope/missing.lrcat\n');
    const body = await json<{ exists: boolean; catalog_path: string }>(
      await app.request('/api/config/catalog'),
    );
    expect(body.exists).toBe(false);
    expect(body.catalog_path).toBe('/nope/missing.lrcat');
  });

  it('returns empty strings when nothing is configured', async () => {
    writeFileSync(cfgPath, 'workers: 4\n');
    expect(await json(await app.request('/api/config/catalog'))).toEqual({
      catalog_path: '',
      resolved_path: '',
      exists: false,
      picker_available: onMac,
      synced_catalog_path: null,
      needs_catalog_sync: false,
    });
  });

  it('echoes the raw value, keeping ~ unexpanded, and resolves it separately', async () => {
    // The UI edits what the user typed; resolved_path is shown alongside.
    writeFileSync(cfgPath, 'catalog_path: ~/Pictures/Cat.lrcat\n');
    const body = await json<{ catalog_path: string; resolved_path: string }>(
      await app.request('/api/config/catalog'),
    );
    expect(body.catalog_path).toBe('~/Pictures/Cat.lrcat');
    expect(body.resolved_path).not.toContain('~');
    expect(normalize(body.resolved_path)).toBe(normalize(join(homedir(), 'Pictures', 'Cat.lrcat')));
  });
});

describe('GET /api/config/catalog sync state', () => {
  const syncState = async () => {
    const body = await json<{ synced_catalog_path: string | null; needs_catalog_sync: boolean }>(
      await app.request('/api/config/catalog'),
    );
    return {
      synced_catalog_path: body.synced_catalog_path,
      needs_catalog_sync: body.needs_catalog_sync,
    };
  };

  it('says nothing when there is no library.db to ask', async () => {
    writeFileSync(cfgPath, 'catalog_path: /a.lrcat\n');
    expect(await syncState()).toEqual({ synced_catalog_path: null, needs_catalog_sync: false });
  });

  it('says nothing when the library has never been synced', async () => {
    // A library built before this key existed must not be reported as stale;
    // "unknown" and "different" are not the same answer.
    seedLibrary();
    writeFileSync(cfgPath, 'catalog_path: /a.lrcat\n');
    expect(await syncState()).toEqual({ synced_catalog_path: null, needs_catalog_sync: false });
  });

  it('is in sync when the library was synced from the configured catalog', async () => {
    seedLibrary('/a.lrcat');
    writeFileSync(cfgPath, 'catalog_path: /a.lrcat\n');
    expect(await syncState()).toEqual({
      synced_catalog_path: '/a.lrcat',
      needs_catalog_sync: false,
    });
  });

  it('needs a sync when the configured catalog is not the one mirrored', async () => {
    seedLibrary('/old.lrcat');
    writeFileSync(cfgPath, 'catalog_path: /new.lrcat\n');
    expect(await syncState()).toEqual({
      synced_catalog_path: '/old.lrcat',
      needs_catalog_sync: true,
    });
  });

  it('compares expanded paths, so ~ is not a mismatch', async () => {
    // The sync stores what the config loader resolved; comparing the raw value
    // would call a `~` path stale on every read.
    const expanded = join(homedir(), 'Pictures/Cat.lrcat');
    seedLibrary(expanded);
    writeFileSync(cfgPath, 'catalog_path: ~/Pictures/Cat.lrcat\n');
    expect((await syncState()).needs_catalog_sync).toBe(false);
  });
});

describe('PUT /api/config/catalog', () => {
  it('writes the value and preserves unrelated keys and their order', async () => {
    writeFileSync(cfgPath, 'workers: 7\nvision_model: gemma\ncatalog_path: /old.lrcat\n');
    const lrcat = join(dir, 'new.lrcat');
    writeFileSync(lrcat, 'x');

    const res = await put('/api/config/catalog', { catalog_path: lrcat });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ catalog_path: lrcat, ok: true });

    const cfg = readCfg();
    expect(cfg.catalog_path).toBe(lrcat);
    // A rewrite must not drop keys the backend does not understand.
    expect(cfg.workers).toBe(7);
    expect(cfg.vision_model).toBe('gemma');
    expect(Object.keys(cfg)).toEqual(['workers', 'vision_model', 'catalog_path']);
  });

  it('rejects a padded path, because validation runs before the trim', async () => {
    // Validation runs on the raw path before trim, so padded paths fail the extension check.
    const lrcat = join(dir, 'spaced.lrcat');
    writeFileSync(lrcat, 'x');

    const trailing = await put('/api/config/catalog', { catalog_path: `${lrcat}  ` });
    expect(trailing.status).toBe(400);
    expect(await json(trailing)).toEqual({ error: 'catalog_path must be a .lrcat file' });

    const leading = await put('/api/config/catalog', { catalog_path: `  ${lrcat}` });
    expect(leading.status).toBe(400);
    expect(await json(leading)).toEqual({ error: 'catalog_path must be an existing file' });
  });

  it.each([
    [{ catalog_path: '/tmp/notacatalog.txt' }, 'catalog_path must be a .lrcat file'],
    [{ catalog_path: '/nope/missing.lrcat' }, 'catalog_path must be an existing file'],
  ])('rejects %j with a 400', async (body, message) => {
    const res = await put('/api/config/catalog', body);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: message });
  });

  it.each([
    [{}, 'a missing field'],
    [{ catalog_path: 5 }, 'a non-string'],
    [{ catalog_path: '/nope/missing.lrcat', extra: 1 }, 'an unexpected field'],
  ])('answers 422 for %o (%s)', async (body, _why) => {
    // Schema violations return 422, not 400.
    const res = await put('/api/config/catalog', body);
    expect(res.status).toBe(422);
  });

  it('accepts a .LRCAT extension case-insensitively', async () => {
    const lrcat = join(dir, 'Shouty.LRCAT');
    writeFileSync(lrcat, 'x');
    expect((await put('/api/config/catalog', { catalog_path: lrcat })).status).toBe(200);
  });

  it('does not write the file when validation fails', async () => {
    writeFileSync(cfgPath, 'catalog_path: /original.lrcat\n');
    await put('/api/config/catalog', { catalog_path: '/nope/missing.lrcat' });
    expect(readCfg().catalog_path).toBe('/original.lrcat');
  });
});

// Opening the dialog for real would block the suite on a human, so the only
// branch testable here is the one where there is no dialog to open.
describe('POST /api/config/catalog/pick', () => {
  it('answers 501 on a platform without a native dialog', async () => {
    const real = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const res = await app.request('/api/config/catalog/pick', { method: 'POST' });
      expect(res.status).toBe(501);
      expect(await json(res)).toEqual({
        error: 'Native file dialog is only available on macOS',
      });
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true });
    }
  });
});

describe('GET /api/config/stack-detection', () => {
  it('returns the configured value', async () => {
    writeFileSync(cfgPath, 'stack_burst_delta_ms: 1500\n');
    expect(await json(await app.request('/api/config/stack-detection'))).toEqual({
      stack_burst_delta_ms: 1500,
    });
  });

  it('falls back to the 2000ms default', async () => {
    writeFileSync(cfgPath, 'workers: 4\n');
    expect(await json(await app.request('/api/config/stack-detection'))).toEqual({
      stack_burst_delta_ms: 2000,
    });
  });
});

describe('PUT /api/config/stack-detection', () => {
  it('writes the value and preserves other keys', async () => {
    writeFileSync(cfgPath, 'workers: 4\n');
    const res = await put('/api/config/stack-detection', { stack_burst_delta_ms: 750 });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ stack_burst_delta_ms: 750, ok: true });
    expect(readCfg()).toEqual({ workers: 4, stack_burst_delta_ms: 750 });
  });

  it.each([
    [{ stack_burst_delta_ms: 0 }, 'stack_burst_delta_ms must be at least 1'],
    [{ stack_burst_delta_ms: -5 }, 'stack_burst_delta_ms must be at least 1'],
  ])('rejects %j with a 400', async (body, message) => {
    const res = await put('/api/config/stack-detection', body);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: message });
  });

  it.each([
    [{}, 'a missing field'],
    [{ stack_burst_delta_ms: 12.5 }, 'a fractional number'],
    [{ stack_burst_delta_ms: '900' }, 'a numeric string'],
    [{ stack_burst_delta_ms: true }, 'a boolean'],
  ])('answers 422 for %o (%s)', async (body, _why) => {
    // Numeric strings and booleans are rejected at schema validation (422); Zod does not
    // coerce them to integers the way the old backend did before its handler-level 400s.
    const res = await put('/api/config/stack-detection', body);
    expect(res.status).toBe(422);
    // Nothing reached the writer: the file is not even created.
    expect(existsSync(cfgPath)).toBe(false);
  });

  it('accepts the minimum of 1', async () => {
    writeFileSync(cfgPath, '');
    const res = await put('/api/config/stack-detection', { stack_burst_delta_ms: 1 });
    expect(res.status).toBe(200);
    expect(readCfg().stack_burst_delta_ms).toBe(1);
  });

  it('creates config.yaml when it does not exist yet', async () => {
    const res = await put('/api/config/stack-detection', { stack_burst_delta_ms: 1234 });
    expect(res.status).toBe(200);
    expect(readCfg().stack_burst_delta_ms).toBe(1234);
  });
});
