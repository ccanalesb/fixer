/**
 * One library per catalog under `catalogs/<name>/`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
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
  moveLibraryDbSidecarsIfPresent,
  maybeUpgradeLegacyCatalogLayout,
  resetCatalogLibraryModuleStateForTests,
  resolveCatalogLibraryPaths,
  runLegacyUpgradeOnce,
} from '../src/catalog-library.js';
import { openLibraryDb } from '../src/db/connection.js';
import { getLibraryMeta, initLibraryDb } from '../src/db/library/bootstrap.js';
import { libraryWrite } from '../src/db/library/write.js';
import { prepareStartupLibrary, resolveOpenLibraryPaths } from '../src/open-library.js';

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

  it('moves library.db-wal and library.db-shm from the legacy location after checkpoint', () => {
    const legacyDb = join(dir, 'sidecar.db');
    const destDb = join(dir, 'dest', 'library.db');
    mkdirSync(dirname(destDb), { recursive: true });
    writeFileSync(legacyDb, 'sqlite');
    writeFileSync(`${legacyDb}-wal`, 'wal-bytes');
    writeFileSync(`${legacyDb}-shm`, 'shm-bytes');

    moveLibraryDbSidecarsIfPresent(legacyDb, destDb);

    expect(existsSync(`${legacyDb}-wal`)).toBe(false);
    expect(existsSync(`${legacyDb}-shm`)).toBe(false);
    expect(readFileSync(`${destDb}-wal`, 'utf8')).toBe('wal-bytes');
    expect(readFileSync(`${destDb}-shm`, 'utf8')).toBe('shm-bytes');
  });
});

/** A legacy install: `library.db` with one cached preview, its vision cache, and config naming both. */
function seedLegacyInstall(): { lrcat: string; legacyDb: string; legacyCache: string } {
  const lrcat = join(dir, 'legacy.lrcat');
  writeFileSync(lrcat, '');
  const legacyDb = join(dir, 'library.db');
  const legacyCache = join(dir, 'old-cache');
  writeFileSync(
    cfgPath,
    stringifyYaml({ catalog_path: lrcat, db_path: legacyDb, vision_cache_dir: legacyCache }),
  );
  const db = initLibraryDb(legacyDb);
  libraryWrite(db, () => {
    db.prepare('INSERT INTO vision_cache (key, compressed_path) VALUES (?, ?)').run(
      'k1',
      join(legacyCache, 'photo.jpg'),
    );
  });
  db.close();
  mkdirSync(legacyCache, { recursive: true });
  writeFileSync(join(legacyCache, 'photo.jpg'), 'jpeg');
  return { lrcat, legacyDb, legacyCache };
}

function cachedPathIn(libraryDbPath: string): string {
  const db = openLibraryDb(libraryDbPath, { readonly: true });
  try {
    return (db.prepare('SELECT compressed_path FROM vision_cache WHERE key = ?').get('k1') as {
      compressed_path: string;
    }).compressed_path;
  } finally {
    db.close();
  }
}

const exdev = (): never => {
  throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
};

describe('an interrupted upgrade', () => {
  it('opens the moved library on the next start, then finishes moving the vision cache', () => {
    const { legacyDb, legacyCache } = seedLegacyInstall();
    const failCacheMove = {
      rename: (src: string, dest: string) => {
        if (src === legacyCache) throw new Error('interrupted');
        renameSync(src, dest);
      },
      copy: (src: string, dest: string) => cpSync(src, dest, { recursive: true }),
    };

    expect(() => maybeUpgradeLegacyCatalogLayout(cfgPath, failCacheMove)).toThrow('interrupted');
    expect(existsSync(legacyDb)).toBe(false);

    resetCatalogLibraryModuleStateForTests();
    const result = runLegacyUpgradeOnce();
    expect(result).not.toBeNull();
    const paths = resolveCatalogLibraryPaths();
    expect(paths.libraryDbPath).toBe(result!.libraryDbPath);
    expect(readdirSync(join(dir, 'catalogs'))).toHaveLength(1);
    expect(cachedPathIn(paths.libraryDbPath)).toBe(join(paths.visionCacheDir, 'photo.jpg'));
    expect(existsSync(join(paths.visionCacheDir, 'photo.jpg'))).toBe(true);
    expect(existsSync(legacyCache)).toBe(false);
    const cfg = parseYaml(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    expect(cfg.db_path).toBeUndefined();
  });

  it('runs again when catalogs/ holds only a library that records no catalog', () => {
    const { legacyDb } = seedLegacyInstall();
    mkdirSync(join(dir, 'catalogs', 'stray-0000'), { recursive: true });
    initLibraryDb(join(dir, 'catalogs', 'stray-0000', 'library.db')).close();

    const result = maybeUpgradeLegacyCatalogLayout();
    expect(result).not.toBeNull();
    expect(existsSync(legacyDb)).toBe(false);
    expect(cachedPathIn(resolveCatalogLibraryPaths().libraryDbPath)).toBe(
      join(result!.visionCacheDir, 'photo.jpg'),
    );
  });
});

describe('an upgrade across volumes', () => {
  it('copies the library and vision cache, then removes the originals', () => {
    const { legacyDb, legacyCache } = seedLegacyInstall();
    const crossVolume = {
      rename: exdev,
      copy: (src: string, dest: string) => cpSync(src, dest, { recursive: true }),
    };

    const result = maybeUpgradeLegacyCatalogLayout(cfgPath, crossVolume);
    expect(result).not.toBeNull();
    expect(existsSync(legacyDb)).toBe(false);
    expect(existsSync(legacyCache)).toBe(false);
    expect(readFileSync(join(result!.visionCacheDir, 'photo.jpg'), 'utf8')).toBe('jpeg');
    expect(cachedPathIn(result!.libraryDbPath)).toBe(join(result!.visionCacheDir, 'photo.jpg'));
  });

  it('keeps the original library when the copy comes out short', () => {
    const { legacyDb } = seedLegacyInstall();
    const shortCopy = {
      rename: exdev,
      copy: (_src: string, dest: string) => writeFileSync(dest, ''),
    };

    expect(() => maybeUpgradeLegacyCatalogLayout(cfgPath, shortCopy)).toThrow();
    expect(existsSync(legacyDb)).toBe(true);
    resetCatalogLibraryModuleStateForTests();
    expect(cachedPathIn(resolveCatalogLibraryPaths().libraryDbPath)).toContain('photo.jpg');
  });
});

describe('the library lookup', () => {
  it('keeps its answer until the catalog changes', () => {
    const lrcat = join(dir, 'kept.lrcat');
    writeFileSync(lrcat, '');
    writeFileSync(cfgPath, `catalog_path: ${JSON.stringify(lrcat)}\n`);
    const first = resolveCatalogLibraryPaths();
    cpSync(first.catalogFolder!, join(dir, 'catalogs', 'kept-ffff'), { recursive: true });

    expect(resolveCatalogLibraryPaths()).toEqual(first);
    invalidateOpenLibraryCache();
    expect(() => resolveCatalogLibraryPaths()).toThrow(CatalogLibraryConflictError);
  });

  it('follows a catalog_path edited in config.yaml', () => {
    const a = join(dir, 'a.lrcat');
    const b = join(dir, 'b.lrcat');
    writeFileSync(a, '');
    writeFileSync(b, '');
    writeFileSync(cfgPath, `catalog_path: ${JSON.stringify(a)}\n`);
    const first = resolveCatalogLibraryPaths();
    writeFileSync(cfgPath, `catalog_path: ${JSON.stringify(b)}\n# edited\n`);

    const second = resolveCatalogLibraryPaths();
    expect(second.libraryDbPath).not.toBe(first.libraryDbPath);
    expect(findCatalogLibrariesForPath(b)[0]!.libraryDbPath).toBe(second.libraryDbPath);
  });
});

describe('runLegacyUpgradeOnce', () => {
  it('retries after a failed upgrade and is a no-op after success', () => {
    const lrcat = join(dir, 'retry.lrcat');
    writeFileSync(lrcat, '');
    const legacyDb = join(dir, 'library.db');
    writeFileSync(
      cfgPath,
      stringifyYaml({ catalog_path: lrcat, db_path: legacyDb, vision_cache_dir: join(dir, 'c') }),
    );
    initLibraryDb(legacyDb).close();
    mkdirSync(join(dir, 'c'), { recursive: true });
    writeFileSync(join(dir, 'catalogs'), 'block');

    invalidateOpenLibraryCache();
    expect(() => runLegacyUpgradeOnce()).toThrow();
    rmSync(join(dir, 'catalogs'));
    mkdirSync(join(dir, 'catalogs'), { recursive: true });

    expect(runLegacyUpgradeOnce()).not.toBeNull();
    expect(runLegacyUpgradeOnce()).toBeNull();
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

describe('prepareStartupLibrary', () => {
  it('creates an empty library in the data folder when no catalog is set, so health answers 200', async () => {
    const { createApp } = await import('../src/app.js');
    expect((await createApp().request('/api/health')).status).toBe(503);

    expect(prepareStartupLibrary()).toBe(join(dir, 'library.db'));
    expect(existsSync(join(dir, 'library.db'))).toBe(true);
    expect((await createApp().request('/api/health')).status).toBe(200);
  });

  it('opens the catalog library and creates nothing in the data folder when a catalog is set', () => {
    const lrcat = join(dir, 'set.lrcat');
    writeFileSync(lrcat, '');
    writeFileSync(cfgPath, `catalog_path: ${JSON.stringify(lrcat)}\n`);

    expect(prepareStartupLibrary()).toBe(findCatalogLibrariesForPath(lrcat)[0]!.libraryDbPath);
    expect(existsSync(join(dir, 'library.db'))).toBe(false);
  });

  it('gives a catalog set later its own library under catalogs/', () => {
    prepareStartupLibrary();
    const lrcat = join(dir, 'later.lrcat');
    writeFileSync(lrcat, '');
    writeFileSync(cfgPath, `catalog_path: ${JSON.stringify(lrcat)}\n`);

    const paths = resolveOpenLibraryPaths();
    expect(dirname(dirname(paths.libraryDbPath))).toBe(join(dir, 'catalogs'));
    expect(existsSync(paths.libraryDbPath)).toBe(true);
  });
});
