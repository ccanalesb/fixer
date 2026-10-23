/**
 * Where job handlers find `library.db`. Tests point `LT_CONFIG_YAML` at a temp
 * file; if the resolver read the repo's `config.yaml` instead, a test that drops
 * `LIBRARY_DB` would run its job against the user's real library.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeLibraryDb } from '../src/jobs/library-db.js';

let dir: string;
const saved = { LIBRARY_DB: process.env.LIBRARY_DB, LT_CONFIG_YAML: process.env.LT_CONFIG_YAML };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-libdb-'));
  delete process.env.LIBRARY_DB;
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

  it('finds nothing when LT_CONFIG_YAML names a missing file and no LIBRARY_DB is set', () => {
    process.env.LT_CONFIG_YAML = join(dir, 'missing.yaml');

    expect(describeLibraryDb()).toMatchObject({ path: null, source: 'none', exists: false });
  });
});
