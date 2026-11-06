import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initLibraryDb } from '../src/db/library/bootstrap.js';
import {
  CHANGED_SINCE_RANKING_META_KEY,
  hasChangedSinceRanking,
  markChangedSinceRanking,
  noteRankingStaleAfterFolderSync,
} from '../src/db/library/ranking-stale.js';
import { libraryWrite } from '../src/db/library/write.js';

describe('ranking stale mark', () => {
  it('sets and clears the changed-since-ranking library_meta key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lt-ranking-stale-'));
    const dbPath = join(dir, 'library.db');
    const db = initLibraryDb(dbPath);
    try {
      expect(hasChangedSinceRanking(db)).toBe(false);
      libraryWrite(db, () => markChangedSinceRanking(db));
      expect(hasChangedSinceRanking(db)).toBe(true);
      expect(
        db.prepare('SELECT value FROM library_meta WHERE key = ?').get(CHANGED_SINCE_RANKING_META_KEY),
      ).toBeDefined();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('notes folder sync reports that changed files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lt-ranking-stale-'));
    const dbPath = join(dir, 'library.db');
    const db = initLibraryDb(dbPath);
    try {
      noteRankingStaleAfterFolderSync(db, {
        added: 0,
        changed: 1,
        moved: 0,
        newly_gone: 0,
      });
      expect(hasChangedSinceRanking(db)).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
