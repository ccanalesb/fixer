/**
 * Catalog list filters for photos missing from the folder or Lightroom catalog.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initLibraryDb } from '../src/db/library/bootstrap.js';
import { queryCatalogImages } from '../src/db/library/catalog-query.js';
import { insertFolderRecords } from '../src/db/library/folder-sync.js';
import { buildFolderCatalogRecords } from '../src/folder/exif-read.js';
import type { ResolvedFolderPhoto } from '../src/folder/walk.js';
import { nowIsoUtc } from '../src/utils/datetime.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-catalog-gone-'));
  dbPath = join(dir, 'library.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('catalog_presence filter', () => {
  it('lists only present or missing photos', () => {
    const db = initLibraryDb(dbPath);
    try {
      const photos: ResolvedFolderPhoto[] = [
        { filepath: join(dir, 'a.jpg'), relPath: 'a.jpg', filename: 'a', stem: 'a' },
        { filepath: join(dir, 'b.jpg'), relPath: 'b.jpg', filename: 'b', stem: 'b' },
      ];
      writeFileSync(photos[0]!.filepath, 'x');
      writeFileSync(photos[1]!.filepath, 'y');
      const tags = new Map(photos.map((p) => [p.filepath, { DateTimeOriginal: '2024:01:01 00:00:00' }]));
      const records = buildFolderCatalogRecords(photos, tags);
      insertFolderRecords(db, records, new Map(records.map((r) => [r.key, 1])));
      db.prepare('UPDATE images SET catalog_missing_since = ? WHERE id = ?').run(
        nowIsoUtc(),
        'b.jpg',
      );

      const all = queryCatalogImages(db, {});
      expect(all.total).toBe(2);

      const present = queryCatalogImages(db, { catalogPresence: 'present' });
      expect(present.total).toBe(1);
      expect(present.rows[0]!.id).toBe('a.jpg');

      const missing = queryCatalogImages(db, { catalogPresence: 'missing' });
      expect(missing.total).toBe(1);
      expect(missing.rows[0]!.id).toBe('b.jpg');
    } finally {
      db.close();
    }
  });
});
