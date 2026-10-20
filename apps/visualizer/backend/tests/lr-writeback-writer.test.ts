/**
 * Guarded pick/rating updates and auto keywords on a fake `.lrcat`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTO_REJECT_KEYWORD,
  AUTO_STARS_KEYWORD,
  addKeywordByKey,
  clearPickIfMatches,
  clearRatingIfMatches,
  connectCatalog,
  readPickRating,
  updatePickIfUnflagged,
  updateRatingIfUnset,
} from '../src/lightroom/writer.js';
import { makeFakeCatalog } from './helpers/fake-catalog.js';

let dir: string;
let lrcat: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-lrw-'));
  lrcat = join(dir, 'cat.lrcat');
  makeFakeCatalog(lrcat, [
    { id: 1, baseName: 'unflagged', pick: 0, rating: null },
    { id: 2, baseName: 'picked', pick: 1, rating: null },
    { id: 3, baseName: 'rejected', pick: -1, rating: null },
    { id: 4, baseName: 'rated', pick: 0, rating: 4 },
  ]);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const key = (base: string) => `2024-06-01_${base}`;

describe('writeback writer guards', () => {
  it('writes reject and stars only on eligible photos', () => {
    const conn = connectCatalog(lrcat);
    try {
      expect(updatePickIfUnflagged(conn, key('unflagged'), -1)).toBe('updated');
      expect(updatePickIfUnflagged(conn, key('picked'), -1)).toBe('skipped');
      expect(updatePickIfUnflagged(conn, key('rejected'), -1)).toBe('skipped');
      expect(updateRatingIfUnset(conn, key('unflagged'), 2)).toBe('updated');
      expect(updateRatingIfUnset(conn, key('rated'), 1)).toBe('skipped');
      expect(addKeywordByKey(conn, key('unflagged'), AUTO_REJECT_KEYWORD)).toBe('added');
      expect(addKeywordByKey(conn, key('unflagged'), AUTO_STARS_KEYWORD)).toBe('added');
    } finally {
      conn.close();
    }
    const ro = new Database(lrcat, { readonly: true });
    const rejectKw = ro
      .prepare(
        `SELECT COUNT(*) AS c FROM AgLibraryKeywordImage ki
         JOIN AgLibraryKeyword k ON k.id_local = ki.tag
         JOIN Adobe_images ai ON ai.id_local = ki.image
         JOIN AgLibraryFile f ON f.id_local = ai.rootFile
         WHERE k.name = ? AND f.baseName = ?`,
      )
      .get(AUTO_REJECT_KEYWORD, 'unflagged') as { c: number };
    expect(rejectKw.c).toBe(1);
    ro.close();
  });

  it('clears when live values still match written values', () => {
    const conn = connectCatalog(lrcat);
    try {
      updatePickIfUnflagged(conn, key('unflagged'), -1);
      updateRatingIfUnset(conn, key('unflagged'), 3);
      expect(clearPickIfMatches(conn, key('unflagged'), -1)).toBe('updated');
      expect(clearRatingIfMatches(conn, key('unflagged'), 3)).toBe('updated');
      const live = readPickRating(conn, key('unflagged'));
      expect(live?.pick).toBe(0);
      expect(live?.rating).toBeNull();
    } finally {
      conn.close();
    }
  });
});
