import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { openLibraryDb } from '../src/db/connection.js';
import { seedCullingDefaults } from '../src/db/library/cull-recipes.js';
import { createApp } from '../src/app.js';
import { LibraryFixture } from './helpers/library-fixture.js';
import { makeFakeCatalog } from './helpers/fake-catalog.js';

const app = createApp();
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

let fx: LibraryFixture;
let dir: string;
let cfgPath: string;
let lrcatPath: string;

beforeEach(() => {
  fx = new LibraryFixture().activate();
  dir = mkdtempSync(join(tmpdir(), 'lt-lrw-rt-'));
  cfgPath = join(dir, 'config.yaml');
  lrcatPath = join(dir, 'Test.lrcat');
  process.env.LT_CONFIG_YAML = cfgPath;
  writeFileSync(cfgPath, stringifyYaml({ workers: 4, catalog_path: lrcatPath }));
  makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'x', pick: 0 }]);
  const db = openLibraryDb(fx.dbPath);
  seedCullingDefaults(db);
  db.close();
});

afterEach(() => {
  fx.cleanup();
  delete process.env.LT_CONFIG_YAML;
  rmSync(dir, { recursive: true, force: true });
});

describe('lr writeback routes', () => {
  it('GET settings defaults switches off', async () => {
    const res = await app.request('/api/cull/lightroom-writeback/settings');
    expect(res.status).toBe(200);
    const body = await json<{ write_stars: boolean; write_reject: boolean }>(res);
    expect(body.write_stars).toBe(false);
    expect(body.write_reject).toBe(false);
  });

  it('write-pending returns 400 when catalog locked', async () => {
    writeFileSync(join(dir, 'Test.lrcat-lock'), '');
    const res = await app.request('/api/cull/lightroom-writeback/write-pending', { method: 'POST' });
    expect(res.status).toBe(400);
    const body = await json<{ error: string }>(res);
    expect(body.error).toBe('Close Lightroom before writing to catalog.');
  });
});
