/**
 * Folder catalog import into library.db.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initLibraryDb } from '../src/db/library/bootstrap.js';
import { getImageCount } from '../src/db/library/statistics.js';
import { syncFolderCatalog } from '../src/folder/sync.js';

let dir: string;
let root: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-folder-sync-'));
  root = join(dir, 'photos');
  mkdirSync(root, { recursive: true });
  dbPath = join(dir, 'library.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('syncFolderCatalog', () => {
  it('inserts walked photos with capture dates', async () => {
    writeFileSync(join(root, 'one.jpg'), 'fake-jpeg');
    const db = initLibraryDb(dbPath);
    try {
      const { result, cancelled } = await syncFolderCatalog(root, db, {});
      expect(cancelled).toBe(false);
      expect(result.added).toBe(1);
      expect(getImageCount(db)).toBe(1);
      const row = db.prepare('SELECT key, date_taken, filepath FROM images').get() as {
        key: string;
        date_taken: string;
        filepath: string;
      };
      expect(row.filepath).toContain('one.jpg');
      expect(row.key).toMatch(/^\d{4}-\d{2}-\d{2}_one$/);
      expect(row.date_taken.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
