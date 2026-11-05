/**
 * Where job handlers find `library.db`. Tests point `LT_CONFIG_YAML` at a temp
 * file; if the resolver read the repo's `config.yaml` instead, a test that drops
 * `LIBRARY_DB` would run its job against the user's real library. `LT_DATA_DIR`
 * points the default at the temp dir too, because a source checkout keeps its
 * real `library.db` at the repo root.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, resolveLibraryDbLocation } from '../src/config.js';
import { describeLibraryDb } from '../src/jobs/library-db.js';
import { resolveOpenLibraryPaths } from '../src/open-library.js';

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
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('describeLibraryDb', () => {
  it('reads db_path from LT_CONFIG_YAML, not the repo config.yaml', () => {
    const db = join(dir, 'library.db');
    writeFileSync(db, '');
    process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
    writeFileSync(process.env.LT_CONFIG_YAML, `db_path: ${db}\n`);

    expect(describeLibraryDb()).toMatchObject({ path: db, source: 'config', exists: true });
  });

  it('falls back to library.db in the data folder when the config file is missing', () => {
    process.env.LT_CONFIG_YAML = join(dir, 'missing.yaml');

    expect(describeLibraryDb()).toMatchObject({
      path: join(dir, 'library.db'),
      source: 'default',
      exists: false,
    });
  });

  it('falls back to the repo-root library.db when no data folder is set', () => {
    process.env.LT_CONFIG_YAML = join(dir, 'missing.yaml');
    delete process.env.LT_DATA_DIR;

    // The location only: describing it would stat the developer's real library.db.
    expect(resolveLibraryDbLocation()).toEqual({
      path: join(REPO_ROOT, 'library.db'),
      source: 'default',
    });
  });
});

describe('resolveOpenLibraryPaths', () => {
  it('pairs library.db resolution with vision_cache_dir from the same config file', () => {
    const db = join(dir, 'library.db');
    writeFileSync(db, '');
    const cache = join(dir, 'my-vision-cache');
    process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
    writeFileSync(process.env.LT_CONFIG_YAML, `db_path: ${db}\nvision_cache_dir: ${cache}\n`);

    expect(resolveOpenLibraryPaths()).toEqual({ libraryDbPath: db, visionCacheDir: cache });
  });

  it('uses the vision cache default when vision_cache_dir is omitted', () => {
    process.env.LT_DATA_DIR = dir;
    process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
    writeFileSync(process.env.LT_CONFIG_YAML, 'catalog_path: /x.lrcat\n');

    expect(resolveOpenLibraryPaths().visionCacheDir).toBe(join(dir, 'vision-cache'));
    expect(resolveOpenLibraryPaths().libraryDbPath).toBe(join(dir, 'library.db'));
  });
});
