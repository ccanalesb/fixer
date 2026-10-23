/**
 * `initLibraryDb` — schema shape for a fresh `library.db`.
 *
 * The fixture in `helpers/library-fixture.ts` declares the same shape by hand;
 * these tests keep the two from drifting apart.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { upgradeLibraryDb } from '../src/api/library-db.js';
import { config } from '../src/config.js';
import { openLibraryDb, type Db } from '../src/db/connection.js';
import {
  getLibraryMeta,
  initLibraryDb,
  LIBRARY_SCHEMA_VERSION,
  perspectiveSeedDescription,
  seedPerspectivesFromPromptsDir,
  setLibraryMeta,
  upgradeLibrarySchema,
} from '../src/db/library/bootstrap.js';
import { LibraryFixture } from './helpers/library-fixture.js';

/** Every table and index, with each table's columns — the semantic schema. */
function schemaShape(db: Db): Record<string, string[]> {
  const objects = db
    .prepare(
      "SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY type, name",
    )
    .all() as { type: string; name: string }[];

  const shape: Record<string, string[]> = {};
  for (const o of objects) {
    if (o.type === 'index') {
      shape[`index ${o.name}`] = [];
      continue;
    }
    const cols = db.prepare(`PRAGMA table_info([${o.name}])`).all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    shape[`table ${o.name}`] = cols.map(
      (c) => `${c.name} ${c.type} notnull=${c.notnull} default=${c.dflt_value ?? ''}`,
    );
  }
  return shape;
}

describe('initLibraryDb', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lt-boot-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const init = (name = 'library.db'): { db: Db; path: string } => {
    const path = join(dir, name);
    return { db: initLibraryDb(path), path };
  };

  it('is born at the current schema version', () => {
    const { db } = init();
    expect(db.pragma('user_version', { simple: true })).toBe(LIBRARY_SCHEMA_VERSION);
    db.close();
  });

  /** Production keeps `image_descriptions_fts` as external-content, not standalone. */
  it('creates image_descriptions_fts as external content, as production has it', () => {
    const { db } = init();
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'image_descriptions_fts'")
      .get() as { sql: string };
    expect(row.sql).toContain("content='image_descriptions'");
    db.close();
  });

  it('writes nothing beside the database', () => {
    const { db } = init();
    db.close();
    expect(readdirSync(dir)).toEqual(['library.db']);
  });

  it('creates missing parent directories', () => {
    const { db, path } = init(join('a', 'b', 'library.db'));
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM images').get()).toEqual({ cnt: 0 });
    db.close();
    expect(path).toContain('library.db');
  });

  it('runs clean over a database it already made', () => {
    const path = join(dir, 'library.db');
    initLibraryDb(path).close();
    const db = initLibraryDb(path);
    expect(db.pragma('user_version', { simple: true })).toBe(LIBRARY_SCHEMA_VERSION);
    db.close();
  });

  it('adopts an empty file, which is what opening a missing path leaves behind', () => {
    const path = join(dir, 'empty.db');
    writeFileSync(path, '');
    const db = initLibraryDb(path);
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM images').get()).toEqual({ cnt: 0 });
    db.close();
  });

  it('refuses a populated database from before the current version', () => {
    const path = join(dir, 'legacy.db');
    const legacy = new Database(path);
    legacy.exec('CREATE TABLE images (key TEXT PRIMARY KEY)');
    legacy.pragma('user_version = 5');
    legacy.close();

    expect(() => initLibraryDb(path)).toThrow(/schema version 5, below 17, the oldest this app upgrades/);
  });

  it('refuses a version 16 library, also when the server starts', () => {
    const path = join(dir, 'v16.db');
    initLibraryDb(path).close();
    const v16 = new Database(path);
    v16.pragma('user_version = 16');
    v16.close();

    const db = openLibraryDb(path);
    try {
      expect(() => upgradeLibrarySchema(db)).toThrow(/schema version 16, below 17/);
    } finally {
      db.close();
    }
    expect(() => upgradeLibraryDb(path)).toThrow(/schema version 16, below 17/);
  });

  it('leaves a current library as it is', () => {
    const path = join(dir, 'library.db');
    const db = initLibraryDb(path);
    try {
      setLibraryMeta(db, 'k', 'v');
      upgradeLibrarySchema(db);
      expect(db.pragma('user_version', { simple: true })).toBe(LIBRARY_SCHEMA_VERSION);
      expect(getLibraryMeta(db, 'k')).toBe('v');
    } finally {
      db.close();
    }
  });
});

/**
 * Skips when the production library.db is not present. Opens production read-only
 * and compares table/column/index shape to a fresh init.
 *
 * `image_descriptions_fts` is external-content here, matching production.
 */
describe.skipIf(!existsSync(config.LIBRARY_DB))('schema parity with the real library.db', () => {
  it('matches every table, column and index', () => {
    const real = openLibraryDb(config.LIBRARY_DB, { readonly: true });
    const dir = mkdtempSync(join(tmpdir(), 'lt-boot-parity-'));
    const fresh = initLibraryDb(join(dir, 'library.db'));
    try {
      expect(schemaShape(fresh)).toEqual(schemaShape(real));
      expect(fresh.pragma('user_version', { simple: true })).toBe(
        real.pragma('user_version', { simple: true }),
      );
    } finally {
      fresh.close();
      real.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('perspective seeding', () => {
  let fixture: LibraryFixture;
  let db: Db;
  let promptsDir: string;

  beforeEach(() => {
    fixture = new LibraryFixture();
    db = openLibraryDb(fixture.dbPath);
    promptsDir = mkdtempSync(join(tmpdir(), 'lt-prompts-'));
  });

  afterEach(() => {
    db.close();
    fixture.cleanup();
    rmSync(promptsDir, { recursive: true, force: true });
  });

  const writePrompt = (name: string, body: string): void =>
    writeFileSync(join(promptsDir, name), body);

  it('inserts one row per markdown file, in filename order', () => {
    writePrompt('street.md', '# Street\n\nMoment and geometry.\n');
    writePrompt('color_theory.md', '# Color Theory\n\nHue and value.\n');
    writePrompt('notes.txt', 'ignored');

    expect(seedPerspectivesFromPromptsDir(db, promptsDir)).toBe(2);
    expect(
      db.prepare('SELECT slug, display_name, description, source_filename FROM perspectives ORDER BY id').all(),
    ).toEqual([
      {
        slug: 'color_theory',
        display_name: 'Color Theory',
        description: 'Hue and value.',
        source_filename: 'color_theory.md',
      },
      {
        slug: 'street',
        display_name: 'Street',
        description: 'Moment and geometry.',
        source_filename: 'street.md',
      },
    ]);
  });

  it('title-cases every hyphenated word in the slug', () => {
    writePrompt('environmental-context-legibility.md', '# Heading\n\nBody.\n');
    seedPerspectivesFromPromptsDir(db, promptsDir);
    expect(
      (db.prepare('SELECT display_name FROM perspectives').get() as { display_name: string })
        .display_name,
    ).toBe('Environmental-Context-Legibility');
  });

  it('derives `optional` from the markdown marker', () => {
    writePrompt('framing.md', '# Framing\n\n<!-- optional: true -->\n\nA framing device.\n');
    writePrompt('street.md', '# Street\n\nMoment.\n');
    seedPerspectivesFromPromptsDir(db, promptsDir);
    expect(db.prepare('SELECT slug, optional FROM perspectives ORDER BY slug').all()).toEqual([
      { slug: 'framing', optional: 1 },
      { slug: 'street', optional: 0 },
    ]);
  });

  it('seeds once and leaves the database authoritative afterwards', () => {
    writePrompt('street.md', '# Street\n\nMoment.\n');
    expect(seedPerspectivesFromPromptsDir(db, promptsDir)).toBe(1);
    writePrompt('publisher.md', '# Publisher\n\nFor print.\n');
    expect(seedPerspectivesFromPromptsDir(db, promptsDir)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM perspectives').get()).toEqual({ cnt: 1 });
  });

  it('does nothing when the prompts directory is absent', () => {
    expect(seedPerspectivesFromPromptsDir(db, join(promptsDir, 'nope'))).toBe(0);
  });

  it('seeds the repo rubrics by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lt-boot-seed-'));
    const fresh = initLibraryDb(join(dir, 'library.db'));
    try {
      const slugs = (
        fresh.prepare('SELECT slug FROM perspectives ORDER BY slug').all() as { slug: string }[]
      ).map((r) => r.slug);
      expect(slugs).toContain('street');
      expect(slugs).toContain('compositional-cleanliness');
    } finally {
      fresh.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('perspectiveSeedDescription', () => {
  it('takes the first body line under the heading', () => {
    expect(perspectiveSeedDescription('# Street\n\nMoment and geometry.\n')).toBe(
      'Moment and geometry.',
    );
  });

  it('takes the first line when there is no heading', () => {
    expect(perspectiveSeedDescription('\n\nStraight into it.\n')).toBe('Straight into it.');
  });

  it('falls back to the heading text when the file is only a heading', () => {
    expect(perspectiveSeedDescription('# Street\n')).toBe('Street');
  });

  it('is empty for an empty file', () => {
    expect(perspectiveSeedDescription('\n  \n')).toBe('');
  });

  /** When the optional marker is the first body line, it becomes the seeded description. */
  it('returns the optional marker when that is the first body line', () => {
    expect(perspectiveSeedDescription('# Framing\n\n<!-- optional: true -->\n\nReal text.\n')).toBe(
      '<!-- optional: true -->',
    );
  });
});
