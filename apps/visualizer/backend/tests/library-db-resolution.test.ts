/**
 * Where job handlers find `library.db`. Tests point `LT_CONFIG_YAML` at a temp
 * file; if the resolver read the repo's `config.yaml` instead, a test that drops
 * `LIBRARY_DB` would run its job against the user's real library. `LT_DATA_DIR`
 * points the default at the temp dir too, because a source checkout keeps its
 * real `library.db` at the repo root.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { REPO_ROOT, resolveLibraryDbLocation } from '../src/config.js';
import { describeLibraryDb } from '../src/jobs/library-db.js';
import { resolveOpenLibraryPaths } from '../src/open-library.js';
import {
  createCatalogLibrary,
  invalidateOpenLibraryCache,
  resetCatalogLibraryModuleStateForTests,
} from '../src/catalog-library.js';

let dir: string;
const saved = {
  LIBRARY_DB: process.env.LIBRARY_DB,
  LT_CONFIG_YAML: process.env.LT_CONFIG_YAML,
  LT_DATA_DIR: process.env.LT_DATA_DIR,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-libdb-'));
  delete process.env.LIBRARY_DB;
  process.env.LT_DATA_DIR = dir;
  process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
  invalidateOpenLibraryCache();
  resetCatalogLibraryModuleStateForTests();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('describeLibraryDb', () => {
  it('finds the library under catalogs/ for the configured catalog', () => {
    const lrcat = join(dir, 'cat.lrcat');
    writeFileSync(lrcat, '');
    writeFileSync(process.env.LT_CONFIG_YAML!, `catalog_path: ${JSON.stringify(lrcat)}\n`);
    const created = createCatalogLibrary(lrcat);
    invalidateOpenLibraryCache();

    expect(describeLibraryDb()).toMatchObject({
      path: created.libraryDbPath,
      source: 'default',
      exists: true,
    });
  });

  it('falls back to library.db in the data folder when no catalog is configured', () => {
    writeFileSync(process.env.LT_CONFIG_YAML!, 'workers: 4\n');
    invalidateOpenLibraryCache();

    expect(describeLibraryDb()).toMatchObject({
      path: join(dir, 'library.db'),
      source: 'default',
      exists: false,
    });
  });

  it('falls back to the repo-root library.db when no data folder is set', () => {
    writeFileSync(process.env.LT_CONFIG_YAML!, 'workers: 4\n');
    delete process.env.LT_DATA_DIR;
    invalidateOpenLibraryCache();

    expect(resolveLibraryDbLocation()).toEqual({
      path: join(REPO_ROOT, 'library.db'),
      source: 'default',
    });
  });

  it('reports a conflict instead of throwing', () => {
    const lrcat = join(dir, 'dup.lrcat');
    writeFileSync(lrcat, '');
    writeFileSync(process.env.LT_CONFIG_YAML!, `catalog_path: ${JSON.stringify(lrcat)}\n`);
    const first = createCatalogLibrary(lrcat);
    cpSync(first.catalogFolder!, join(dir, 'catalogs', 'dup-zzzz'), { recursive: true });
    invalidateOpenLibraryCache();

    const status = describeLibraryDb();
    expect(status.exists).toBe(false);
    expect(status.reason).toContain(first.catalogFolder!);
    expect(status.reason).toContain('dup-zzzz');
  });
});

describe('resolveOpenLibraryPaths', () => {
  it('pairs the catalog library with vision-cache/ beside it', () => {
    const lrcat = join(dir, 'cat.lrcat');
    writeFileSync(lrcat, '');
    writeFileSync(process.env.LT_CONFIG_YAML!, `catalog_path: ${JSON.stringify(lrcat)}\n`);
    invalidateOpenLibraryCache();

    const paths = resolveOpenLibraryPaths();
    expect(paths.visionCacheDir).toBe(join(dirname(paths.libraryDbPath), 'vision-cache'));
    expect(paths.libraryDbPath).toContain('catalogs');
  });

  it('uses vision-cache beside the library when catalog_path is set', () => {
    const lrcat = join(dir, 'x.lrcat');
    writeFileSync(lrcat, '');
    writeFileSync(process.env.LT_CONFIG_YAML!, `catalog_path: ${JSON.stringify(lrcat)}\n`);
    invalidateOpenLibraryCache();

    expect(resolveOpenLibraryPaths().visionCacheDir).toBe(
      join(dirname(resolveOpenLibraryPaths().libraryDbPath), 'vision-cache'),
    );
  });
});
