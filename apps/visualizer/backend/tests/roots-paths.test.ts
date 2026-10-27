/**
 * Data folder and resources roots: unset behaves like today; set keeps reads and writes
 * under temp dirs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  config,
  clipCacheDir,
  dataRoot,
  loadLibraryConfig,
  providersExamplePath,
  REPO_ROOT,
  resourcesRoot,
} from '../src/config.js';
import { describeLibraryDb, resolveLibraryDbLocation } from '../src/library-db-path.js';
import { initLibraryDb, LIBRARY_SCHEMA_VERSION } from '../src/db/library/bootstrap.js';
import { openLibraryDb } from '../src/db/connection.js';
import { cullingProfileSeedDir } from '../src/db/library/cull-profiles.js';
import { perspectivePromptsDir } from '../src/db/library/bootstrap.js';

const saved = {
  LT_DATA_DIR: process.env.LT_DATA_DIR,
  LT_RESOURCES_DIR: process.env.LT_RESOURCES_DIR,
  LIBRARY_DB: process.env.LIBRARY_DB,
  LT_CONFIG_YAML: process.env.LT_CONFIG_YAML,
  DATABASE_PATH: process.env.DATABASE_PATH,
  LT_PROVIDERS_JSON: process.env.LT_PROVIDERS_JSON,
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-roots-'));
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k as keyof typeof saved];
    else process.env[k as keyof typeof saved] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

function clearRoots(): void {
  delete process.env.LT_DATA_DIR;
  delete process.env.LT_RESOURCES_DIR;
  delete process.env.LIBRARY_DB;
  delete process.env.LT_CONFIG_YAML;
  delete process.env.DATABASE_PATH;
  delete process.env.LT_PROVIDERS_JSON;
}

describe('roots unset', () => {
  beforeEach(clearRoots);

  it('defaults data and resources roots to the repo root', () => {
    expect(dataRoot()).toBe(REPO_ROOT);
    expect(resourcesRoot()).toBe(REPO_ROOT);
  });

  it('keeps legacy default paths for written files', () => {
    expect(config.VISUALIZER_DB).toBe(join(REPO_ROOT, 'apps/visualizer/visualizer.db'));
    expect(config.LT_PROVIDERS_JSON).toBe(
      join(REPO_ROOT, 'apps/visualizer/backend/providers.json'),
    );
    expect(config.THUMBNAIL_DIR).toBe(join(REPO_ROOT, 'apps/visualizer/thumbnails'));
    expect(config.LT_CONFIG_YAML).toBe(join(REPO_ROOT, 'config.yaml'));
  });

  it('keeps the shipped providers example path', () => {
    expect(providersExamplePath()).toBe(
      join(REPO_ROOT, 'apps/visualizer/backend/providers.example.json'),
    );
    expect(existsSync(providersExamplePath())).toBe(true);
  });

  it('reads factory prompts from the repo tree', () => {
    expect(perspectivePromptsDir()).toBe(join(REPO_ROOT, 'prompts', 'perspectives'));
    expect(cullingProfileSeedDir()).toBe(join(REPO_ROOT, 'prompts', 'culling-profiles'));
    expect(existsSync(join(perspectivePromptsDir(), 'environmental-context-legibility.md'))).toBe(
      true,
    );
  });

  it('defaults vision cache to the home cache when LT_DATA_DIR is unset', () => {
    const cfg = loadLibraryConfig(join(dir, 'missing.yaml'));
    expect(cfg.visionCacheDir).toMatch(/\.cache[/\\]lightroom_tagger[/\\]vision$/);
  });
});

describe('roots set', () => {
  beforeEach(() => {
    clearRoots();
    const data = join(dir, 'data');
    const resources = join(dir, 'resources');
    process.env.LT_DATA_DIR = data;
    process.env.LT_RESOURCES_DIR = resources;

    cpSync(join(REPO_ROOT, 'prompts'), join(resources, 'prompts'), { recursive: true });
    cpSync(
      join(REPO_ROOT, 'apps/visualizer/backend/providers.example.json'),
      join(resources, 'providers.example.json'),
    );
    cpSync(join(REPO_ROOT, 'scripts', 'app-models'), join(resources, 'scripts', 'app-models'), {
      recursive: true,
    });
  });

  it('writes defaults under the data folder only', () => {
    expect(config.VISUALIZER_DB).toBe(join(process.env.LT_DATA_DIR!, 'visualizer.db'));
    expect(config.LT_PROVIDERS_JSON).toBe(join(process.env.LT_DATA_DIR!, 'providers.json'));
    expect(config.THUMBNAIL_DIR).toBe(join(process.env.LT_DATA_DIR!, 'thumbnails'));
    expect(config.LT_CONFIG_YAML).toBe(join(process.env.LT_DATA_DIR!, 'config.yaml'));
    expect(resolveLibraryDbLocation().path).toBe(join(process.env.LT_DATA_DIR!, 'library.db'));
  });

  it('reads prompts and the providers example from resources', () => {
    expect(perspectivePromptsDir()).toBe(
      join(process.env.LT_RESOURCES_DIR!, 'prompts', 'perspectives'),
    );
    expect(cullingProfileSeedDir()).toBe(
      join(process.env.LT_RESOURCES_DIR!, 'prompts', 'culling-profiles'),
    );
    expect(providersExamplePath()).toBe(join(process.env.LT_RESOURCES_DIR!, 'providers.example.json'));
    expect(readFileSync(providersExamplePath(), 'utf8')).toContain('"providers"');
  });

  it('defaults vision cache into the data folder', () => {
    const cfg = loadLibraryConfig(config.LT_CONFIG_YAML);
    expect(cfg.visionCacheDir).toBe(join(process.env.LT_DATA_DIR!, 'vision-cache'));
  });

  it('keeps the CLIP cache in its own folder under the data folder', () => {
    expect(clipCacheDir()).toBe(join(process.env.LT_DATA_DIR!, 'clip'));
  });

  it('still honors per-file env overrides', () => {
    const custom = join(dir, 'custom.db');
    process.env.LIBRARY_DB = custom;
    expect(config.LIBRARY_DB).toBe(custom);
  });
});

describe('library.db resolution', () => {
  beforeEach(clearRoots);

  it('matches between config.LIBRARY_DB and describeLibraryDb via db_path', () => {
    const db = join(dir, 'from-config.db');
    writeFileSync(db, '');
    process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
    writeFileSync(process.env.LT_CONFIG_YAML, `db_path: ${db}\n`);

    expect(config.LIBRARY_DB).toBe(db);
    expect(describeLibraryDb()).toMatchObject({ path: db, source: 'config', exists: true });
  });

  it('uses the data folder default when LT_DATA_DIR is set and nothing else names a db', () => {
    process.env.LT_DATA_DIR = join(dir, 'data');
    const expected = join(process.env.LT_DATA_DIR, 'library.db');
    expect(config.LIBRARY_DB).toBe(expected);
    expect(describeLibraryDb()).toMatchObject({ path: expected, source: 'default', exists: false });
  });
});

describe('packaged first start', () => {
  beforeEach(() => {
    clearRoots();
    process.env.LT_DATA_DIR = join(dir, 'data');
    delete process.env.LIBRARY_DB;
  });

  it('creates an empty upgraded library.db at the resolved path', () => {
    const dbPath = config.LIBRARY_DB;
    expect(existsSync(dbPath)).toBe(false);

    initLibraryDb(dbPath).close();

    expect(existsSync(dbPath)).toBe(true);
    const db = openLibraryDb(dbPath, { readonly: true });
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(LIBRARY_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
});
