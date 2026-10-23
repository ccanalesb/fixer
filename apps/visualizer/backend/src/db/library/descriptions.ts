/**
 * Image description queries.
 */
import type { Db } from '../connection.js';
import { nowIsoLocal } from '../../utils/datetime.js';
import { decodeJsonColumns } from './row-decode.js';

/** Columns stored as JSON text and decoded on read. */
const JSON_COLUMNS = [
  'composition',
  'perspectives',
  'technical',
  'subjects',
  'dominant_colors',
  'mood_tags',
] as const;

export type DescriptionRow = Record<string, unknown>;

const decodeRow = (row: DescriptionRow): DescriptionRow => decodeJsonColumns(row, JSON_COLUMNS);

/** One `image_descriptions` row by image key, JSON columns decoded. */
export function getImageDescription(db: Db, imageKey: string): DescriptionRow | null {
  const row = db
    .prepare('SELECT * FROM image_descriptions WHERE image_key = ?')
    .get(imageKey) as DescriptionRow | undefined;
  return row ? decodeRow(row) : null;
}

export interface DescriptionListItem {
  image_key: string;
  /** The query selects `'catalog' AS image_type` literally, so this is never
   *  anything else — the Instagram scope was removed. */
  image_type: 'catalog';
  filename: string | null;
  date_ref: string | null;
  summary: string | null;
  best_perspective: string | null;
  desc_model: string | null;
  described_at: string | null;
  has_description: number;
}

/**
 * Images joined with their descriptions for the descriptions page.
 *
 * Undescribed images sort last (NULL `described_at`), then newest description,
 * then newest capture date.
 */
export function getAllImagesWithDescriptions(
  db: Db,
  opts: { describedOnly?: boolean; limit?: number; offset?: number } = {},
): { items: DescriptionListItem[]; total: number } {
  const base = `
    SELECT i.key AS image_key, 'catalog' AS image_type,
           i.filename, i.date_taken AS date_ref,
           d.summary, d.best_perspective, d.model_used AS desc_model,
           d.described_at,
           CASE WHEN d.image_key IS NOT NULL THEN 1 ELSE 0 END AS has_description
    FROM images i
    LEFT JOIN image_descriptions d
      ON i.key = d.image_key AND d.image_type = 'catalog'
  `;
  const wrapper = opts.describedOnly
    ? `SELECT * FROM (${base}) t WHERE t.has_description = 1`
    : `SELECT * FROM (${base}) t`;

  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS cnt FROM (${wrapper})`).get() as { cnt: number }).cnt,
  );

  const items = db
    .prepare(
      `${wrapper} ORDER BY CASE WHEN t.described_at IS NULL THEN 1 ELSE 0 END, ` +
        `t.described_at DESC, t.date_ref DESC LIMIT ? OFFSET ?`,
    )
    .all(opts.limit ?? 50, opts.offset ?? 0) as DescriptionListItem[];

  return { items, total };
}

/**
 * Build an FTS5 `MATCH` string (AND-joined tokens) for `description_search`
 * (NLS-02, D-11–D-13).
 *
 * Returns `{ match, error }` where `match` is suitable as the sole bound parameter
 * to `... MATCH ?`, or `null` when no FTS filter should apply. `error` is non-null
 * only for inputs shorter than two characters (D-12), which the caller turns into
 * a 400.
 *
 * Tokenization: maximal ASCII alphanumeric runs on the trimmed input, so punctuation
 * and FTS/SQL metacharacters can never reach the match string. Tokens shorter than
 * two characters are dropped; if none remain, no filter applies (D-13).
 */
export function buildDescriptionFtsQuery(raw: string | null | undefined): {
  match: string | null;
  error: string | null;
} {
  if (raw === null || raw === undefined) return { match: null, error: null };
  const s = raw.trim();
  if (!s) return { match: null, error: null };
  if (s.length < 2) {
    return { match: null, error: 'description_search must be at least 2 characters' };
  }
  const words = (s.match(/[A-Za-z0-9]+/g) ?? []).filter((t) => t.length >= 2);
  if (words.length === 0) return { match: null, error: null };
  // Double-quote each term so FTS5 reserved words (OR, AND, NOT) stay literals.
  const quoted = words.map((t) => `"${t.replaceAll('"', '""')}"`);
  return { match: quoted.join(' AND '), error: null };
}

/**
 * Subquery yielding catalog image keys whose description matches an FTS `?` param.
 * Shared by the CLI keyword search and the catalog `description_search` filter.
 */
export const DESCRIPTION_FTS_KEY_SUBQUERY =
  'SELECT d2.image_key FROM image_descriptions d2 ' +
  'INNER JOIN image_descriptions_fts ON image_descriptions_fts.rowid = d2.rowid ' +
  "WHERE d2.image_type = 'catalog' AND image_descriptions_fts MATCH ?";

/**
 * Normalized full-text for summary plus subjects (D-06).
 *
 * Whitespace is collapsed so an FTS token cannot be split by a line break.
 */
export function buildDescriptionSearchDocument(
  summary: string | null | undefined,
  subjects: unknown,
): string {
  const part = String(summary ?? '').trim().replace(/\s+/gu, ' ');

  let subj: unknown[] = [];
  if (typeof subjects === 'string') {
    try {
      const parsed = JSON.parse(subjects) as unknown;
      if (Array.isArray(parsed)) subj = parsed;
    } catch {
      subj = [];
    }
  } else if (Array.isArray(subjects)) {
    subj = subjects;
  }

  const joined = subj.filter((s): s is string => typeof s === 'string').join(' ');
  if (!joined) return part;
  if (!part) return joined;
  return `${part} ${joined}`;
}

/** `1`, `0` or `null` from the loose values a model may return. */
function coerceHasRepetition(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value === true || value === 1 || value === '1' || value === 'true' || value === 'yes') {
    return 1;
  }
  // Unrecognized values become 0, meaning "no repetition observed".
  return 0;
}

/** JSON text for a list or object attribute; `null` for anything else. */
function visualAttrJson(value: unknown): string | null {
  if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
    return JSON.stringify(value);
  }
  return null;
}

export interface DescriptionRecord {
  image_key: string;
  image_type: string;
  summary?: string;
  composition?: unknown;
  technical?: unknown;
  subjects?: unknown;
  model_used?: string;
  dominant_colors?: unknown;
  mood_tags?: unknown;
  has_repetition?: unknown;
}

/**
 * Whether `image_descriptions_fts` is an external-content FTS5 table.
 *
 * External-content and standalone forms need opposite removal statements; existing
 * catalogs keep whichever form they were created with.
 */
function ftsIsExternalContent(db: Db): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'image_descriptions_fts'")
    .get() as { sql: string | null } | undefined;
  return /\bcontent\s*=/.test(row?.sql ?? '');
}

/**
 * Drop `rowid`'s entry from the FTS index, given the document text that was indexed.
 *
 * An external-content table must go through FTS5's `'delete'` command: a plain
 * `DELETE ... WHERE rowid = ?` makes FTS5 re-tokenize whatever the content table
 * holds *now*, which raises `database disk image is malformed` against an empty
 * index and silently removes the wrong terms against a populated one. A standalone
 * table is the mirror image — it rejects the `'delete'` command with `SQL logic
 * error` and needs the plain statement.
 */
function removeDescriptionFtsRow(db: Db, rowid: number, indexedDocument: string): void {
  if (ftsIsExternalContent(db)) {
    db.prepare(
      'INSERT INTO image_descriptions_fts(image_descriptions_fts, rowid, description_search_document) ' +
        "VALUES('delete', ?, ?)",
    ).run(rowid, indexedDocument);
  } else {
    db.prepare('DELETE FROM image_descriptions_fts WHERE rowid = ?').run(rowid);
  }
}

/**
 * Store a description, idempotently by `image_key`. Call inside `libraryWrite`.
 *
 * The FTS row is rewritten by hand — remove then insert — because
 * `image_descriptions_fts` has no triggers, so nothing updates it automatically.
 * Skipping that would leave `description_search` matching the previous
 * description for ever.
 */
export function storeImageDescription(db: Db, record: DescriptionRecord): string {
  const imageKey = record.image_key;
  if (!imageKey) throw new RangeError('image_key is required');

  const describedAt = nowIsoLocal();
  const imageType = record.image_type ?? '';
  const dominantColors = visualAttrJson(record.dominant_colors);
  const moodTags = visualAttrJson(record.mood_tags);
  const hasRepetition = coerceHasRepetition(record.has_repetition);
  // Only the catalog scope is searchable; the Instagram scope was removed.
  const searchDocument =
    imageType === 'catalog'
      ? buildDescriptionSearchDocument(record.summary ?? '', record.subjects ?? [])
      : null;

  // Read before the upsert: removing the old index entry needs the text that was
  // indexed, and only a previous catalog write with a non-empty document indexed
  // anything at all.
  const previous = db
    .prepare(
      'SELECT rowid, image_type, description_search_document FROM image_descriptions WHERE image_key = ?',
    )
    .get(imageKey) as
    | { rowid: number; image_type: string | null; description_search_document: string | null }
    | undefined;

  db.prepare(
    `
    INSERT INTO image_descriptions
        (image_key, image_type, summary, composition,
         technical, subjects, model_used, described_at,
         dominant_colors, mood_tags, has_repetition, description_search_document)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(image_key) DO UPDATE SET
        image_type=excluded.image_type, summary=excluded.summary,
        composition=excluded.composition,
        technical=excluded.technical, subjects=excluded.subjects,
        model_used=excluded.model_used,
        described_at=excluded.described_at,
        dominant_colors=excluded.dominant_colors, mood_tags=excluded.mood_tags,
        has_repetition=excluded.has_repetition,
        description_search_document=excluded.description_search_document
    `,
  ).run(
    imageKey,
    imageType,
    record.summary ?? '',
    JSON.stringify(record.composition ?? {}),
    JSON.stringify(record.technical ?? {}),
    JSON.stringify(record.subjects ?? []),
    record.model_used ?? '',
    describedAt,
    dominantColors,
    moodTags,
    hasRepetition,
    searchDocument,
  );

  const row = db
    .prepare('SELECT rowid FROM image_descriptions WHERE image_key = ?')
    .get(imageKey) as { rowid: number } | undefined;
  if (row !== undefined) {
    const indexed = previous?.description_search_document;
    if (previous !== undefined && previous.image_type === 'catalog' && indexed && indexed.trim()) {
      removeDescriptionFtsRow(db, previous.rowid, indexed);
    }
    if (imageType === 'catalog' && searchDocument && searchDocument.trim()) {
      db.prepare(
        'INSERT INTO image_descriptions_fts(rowid, description_search_document) VALUES(?, ?)',
      ).run(row.rowid, searchDocument);
    }
  }
  return imageKey;
}
