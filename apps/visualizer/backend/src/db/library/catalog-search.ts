/**
 * Whole-table `images` queries for the CLI.
 *
 * Coarser than the grid filter builder: no paging, ordering, or joins. Kept
 * separate from `catalog-query.ts`, which serves the HTTP API.
 */
import type { Db } from '../connection.js';
import { deserializeRow, type Row } from './catalog.js';
import { buildDescriptionFtsQuery, DESCRIPTION_FTS_KEY_SUBQUERY } from './descriptions.js';

const all = (db: Db, sql: string, params: readonly unknown[] = []): Row[] =>
  (db.prepare(sql).all(...(params as never[])) as Row[]).map(deserializeRow);

/** Every image, JSON and boolean columns normalized. */
export function getAllImages(db: Db): Row[] {
  return all(db, 'SELECT * FROM images');
}

/**
 * Substring match across the Lightroom metadata, widened by an FTS5 match over
 * the AI descriptions.
 *
 * A term too short for FTS still searches the metadata half: the builder's
 * minimum length is the web API's rule, where it answers 400, and here it only
 * means "this term has no FTS half" — a one-character keyword stays a legitimate
 * query.
 */
export function searchByKeyword(db: Db, keyword: string): Row[] {
  const pattern = `%${keyword}%`;
  const params: unknown[] = [pattern, pattern, pattern, pattern];
  let where =
    'keywords LIKE ? COLLATE NOCASE OR filename LIKE ? COLLATE NOCASE OR ' +
    'title LIKE ? COLLATE NOCASE OR description LIKE ? COLLATE NOCASE';

  const { match } = buildDescriptionFtsQuery(keyword);
  if (match !== null) {
    where = `(${where}) OR key IN (${DESCRIPTION_FTS_KEY_SUBQUERY})`;
    params.push(match);
  }

  // `DISTINCT` is redundant (`key` is PK) but kept for the existing query shape.
  return all(db, `SELECT DISTINCT * FROM images WHERE ${where}`, params);
}

export function searchByRating(db: Db, minRating = 0): Row[] {
  return all(db, 'SELECT * FROM images WHERE rating >= ?', [minRating]);
}

export function searchByColorLabel(db: Db, label: string): Row[] {
  return all(db, 'SELECT * FROM images WHERE LOWER(color_label) = LOWER(?)', [label]);
}

/** Images from `startDate` on, bounded by `endDate` when one is given. */
export function searchByDate(db: Db, startDate: string, endDate?: string | null): Row[] {
  return endDate
    ? all(db, 'SELECT * FROM images WHERE date_taken >= ? AND date_taken <= ?', [
        startDate,
        endDate,
      ])
    : all(db, 'SELECT * FROM images WHERE date_taken >= ?', [startDate]);
}
