/**
 * An older `library.db` is brought up to the current schema by the API itself — when the server starts
 * and when a request opens it — not only by a job or the CLI. Before, a route reading a table the new
 * schema added answered 500 until some job had run.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { upgradeLibraryDb } from '../src/api/library-db.js';
import { openLibraryDb } from '../src/db/connection.js';
import { LIBRARY_SCHEMA_VERSION } from '../src/db/library/bootstrap.js';
import { LibraryFixture } from './helpers/library-fixture.js';

let fx: LibraryFixture;
const app = createApp();

/** Back to schema 14: no Score forecast questions table. */
function downgradeToV14(path: string): void {
  const db = openLibraryDb(path);
  db.exec('DROP TABLE score_forecast_question_versions');
  db.pragma('user_version = 14');
  db.close();
}

const userVersion = (path: string): number => {
  const db = openLibraryDb(path, { readonly: true });
  try {
    return db.pragma('user_version', { simple: true }) as number;
  } finally {
    db.close();
  }
};

beforeEach(() => {
  fx = new LibraryFixture().activate();
  downgradeToV14(fx.dbPath);
});

afterEach(() => {
  fx.cleanup();
});

describe('library.db upgrade from the API', () => {
  it('a read-only request upgrades an older library.db before reading it', async () => {
    const res = await app.request('/api/score-forecast-questions');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ questions: [], version: 0 });
    expect(userVersion(fx.dbPath)).toBe(LIBRARY_SCHEMA_VERSION);
  });

  it('at server start, upgrades the library.db; a missing one is left missing', () => {
    upgradeLibraryDb(fx.dbPath);
    expect(userVersion(fx.dbPath)).toBe(LIBRARY_SCHEMA_VERSION);

    const missing = join(fx.dir, 'none.db');
    upgradeLibraryDb(missing);
    expect(existsSync(missing)).toBe(false);
  });
});
