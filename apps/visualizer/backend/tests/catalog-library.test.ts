/**
 * One library per catalog under `catalogs/<name>/`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  absoluteCatalogPath,
  CATALOG_KIND_META_KEY,
  CATALOG_PATH_META_KEY,
  CatalogLibraryConflictError,
  createCatalogLibrary,
  findCatalogLibrariesForPath,
  invalidateOpenLibraryCache,
  maybeUpgradeLegacyCatalogLayout,
  resetCatalogLibraryModuleStateForTests,
  resolveCatalogLibraryPaths,
} from '../src/catalog-library.js';
import { openLibraryDb } from '../src/db/connection.js';
import { getLibraryMeta, initLibraryDb } from '../src/db/library/bootstrap.js';
import { libraryWrite } from '../src/db/library/write.js';
import { resolveOpenLibraryPaths } from '../src/open-library.js';

let dir: string;
let cfgPath: string;
const saved = {
  LIBRARY_DB: process.env.LIBRARY_DB,
  LT_CONFIG_YAML: process.env.LT_CONFIG_YAML,
  LT_DATA_DIR: process.env.LT_DATA_DIR,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-catlib-'));
  cfgPath = join(dir, 'config.yaml');
  delete process.env.LIBRARY_DB;
  process.env.LT_DATA_DIR = dir;
  process.env.LT_CONFIG_YAML = cfgPath;
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

describe('createCatalogLibrary', () => {
  it('creates catalogs/<basename>-<suffix>/ with library.db, vision-cache/, and library_meta', () => {
    const lrcat = join(dir, 'FinalCatalog-v13-3.lrcat');
    writeFileSync(lrcat, '');
    const catalogAbs = absoluteCatalogPath(lrcat);

    const paths = createCatalogLibrary(catalogAbs);
    expect(existsSync(paths.libraryDbPath)).toBe(true);
    expect(existsSync(paths.visionCacheDir)).toBe(true);
    expect(paths.catalogFolder).toBe(dirname(paths.libraryDbPath));

    const db = openLibraryDb(paths.libraryDbPath, { readonly: true });
    try {
      expect(getLibraryMeta(db, CATALOG_PATH_META_KEY)).toBe(catalogAbs);
      expect(getLibraryMeta(db, CATALOG_KIND_META_KEY)).toBe('lightroom');
    } finally {
      db.close();
    }
  });
});

describe('findCatalogLibrariesForPath', () => {
  it('finds the library whose recorded path matches', () => {
    const lrcat = join(dir, 'cat.lrcat');
    writeFileSync(lrcat, '');
    createCatalogLibrary(lrcat);

    const matches = findCatalogLibrariesForPath(lrcat);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.libraryDbPath).toContain('catalogs');
  });

  it('reports a conflict when two libraries claim one path', () => {
    const lrcat = join(dir, 'dup.lrcat');
    writeFileSync(lrcat, '');
    writeFileSync(cfgPath, `catalog_path: ${JSON.stringify(lrcat)}\n`);
    createCatalogLibrary(lrcat);
    const first = findCatalogLibrariesForPath(lrcat)[0]!;
    const secondFolder = join(dir, 'catalogs', 'dup-bbbb');
    cpSync(first.catalogFolder, secondFolder, { recursive: true });
    invalidateOpenLibraryCache();

    expect(findCatalogLibrariesForPath(lrcat)).toHaveLength(2);
    expect(() => resolveCatalogLibraryPaths()).toThrow(CatalogLibraryConflictError);
  });
});

describe('maybeUpgradeLegacyCatalogLayout', () => {
  it('moves legacy library.db and vision cache into catalogs/, rewrites paths, and trims config', () => {
    const lrcat = join(dir, 'legacy.lrcat');
    writeFileSync(lrcat, '');
    const legacyDb = join(dir, 'library.db');
    const legacyCache = join(dir, 'old-cache');
    writeFileSync(
      cfgPath,
      stringifyYaml({
        catalog_path: lrcat,
        db_path: legacyDb,
        vision_cache_dir: legacyCache,
      }),
    );

    const db = initLibraryDb(legacyDb);
    db.close();
    mkdirSync(legacyCache, { recursive: true });
    const cachedFile = join(legacyCache, 'photo.jpg');
    writeFileSync(cachedFile, 'jpeg');
    const dbw = openLibraryDb(legacyDb);
    libraryWrite(dbw, () => {
      dbw.prepare('INSERT INTO vision_cache (key, compressed_path) VALUES (?, ?)').run(
        'k1',
        cachedFile,
      );
    });
    dbw.close();

    invalidateOpenLibraryCache();
    const result = maybeUpgradeLegacyCatalogLayout();
    expect(result).not.toBeNull();
    expect(existsSync(legacyDb)).toBe(false);
    expect(existsSync(result!.libraryDbPath)).toBe(true);
    expect(existsSync(join(result!.visionCacheDir, 'photo.jpg'))).toBe(true);

    const cfg = parseYaml(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    expect(cfg.db_path).toBeUndefined();
    expect(cfg.vision_cache_dir).toBeUndefined();

    const upgraded = openLibraryDb(result!.libraryDbPath, { readonly: true });
    try {
      expect(getLibraryMeta(upgraded, CATALOG_PATH_META_KEY)).toBe(lrcat);
      const row = upgraded.prepare('SELECT compressed_path FROM vision_cache WHERE key = ?').get(
        'k1',
      ) as { compressed_path: string };
      expect(row.compressed_path.startsWith(result!.visionCacheDir)).toBe(true);
    } finally {
      upgraded.close();
    }
  });
});

describe('library routes under a conflict', () => {
  it('answer 500 with an error naming both catalog folders', async () => {
    const { createApp } = await import('../src/app.js');
    const lrcat = join(dir, 'dup.lrcat');
    writeFileSync(lrcat, '');
    writeFileSync(cfgPath, `catalog_path: ${JSON.stringify(lrcat)}\n`);
    const first = createCatalogLibrary(lrcat);
    const firstFolder = first.catalogFolder!;
    const second = join(dir, 'catalogs', 'dup-ffff');
    cpSync(firstFolder, second, { recursive: true });
    invalidateOpenLibraryCache();

    const app = createApp();
    const res = await app.request('/api/stats');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(firstFolder);
    expect(body.error).toContain(second);
  });
});

describe('resolveOpenLibraryPaths', () => {
  it('uses LIBRARY_DB and places vision cache beside it', () => {
    const pinned = join(dir, 'pinned', 'library.db');
    mkdirSync(dirname(pinned), { recursive: true });
    writeFileSync(pinned, '');
    process.env.LIBRARY_DB = pinned;
    invalidateOpenLibraryCache();
    expect(resolveOpenLibraryPaths()).toEqual({
      libraryDbPath: pinned,
      visionCacheDir: join(dirname(pinned), 'vision-cache'),
    });
  });

  it('opens the library the lookup finds when LIBRARY_DB is unset', () => {
    const lrcat = join(dir, 'open.lrcat');
    writeFileSync(lrcat, '');
    writeFileSync(cfgPath, `catalog_path: ${JSON.stringify(lrcat)}\n`);
    invalidateOpenLibraryCache();
    const paths = resolveOpenLibraryPaths();
    expect(existsSync(paths.libraryDbPath)).toBe(true);
    expect(paths.visionCacheDir).toBe(join(dirname(paths.libraryDbPath), 'vision-cache'));
  });
});
