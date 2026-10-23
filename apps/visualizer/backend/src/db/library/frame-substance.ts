/**
 * Frame substance verdict storage and read helpers.
 *
 * A "condemned" frame is one the pixel detector judged `void` or `illegible` and the
 * user has not overridden. That rule is expressed as SQL in
 * `frame-substance-sql.ts`, shared with the identity ranking, the stack suggestions
 * and the catalog listing; the single-key form lives here.
 */
import type { Db } from '../connection.js';
import { prepareCached } from '../prepare-cached.js';
import { FLAGGED_VERDICTS } from './frame-substance-sql.js';
import { getVisionCachedImage, VISION_CACHE_OVERSIZED_SENTINEL } from './vision-cache.js';
import { nowIsoUtc, storedInstantMs } from '../../utils/datetime.js';

export type FrameSubstanceVerdict = 'void' | 'illegible' | 'ok' | 'unknown';

export interface FrameSubstanceRow {
  image_key: string;
  verdict: FrameSubstanceVerdict;
  unknown_reason: string;
  black_frac_25: number | null;
  blown_frac_235: number | null;
  lap_var: number | null;
  tile_max: number | null;
  entropy: number | null;
  detector_version: string;
  judged_at: string;
  run_id: number;
}

export interface FrameSubstanceRunRow {
  run_id: number;
  started_at: string;
  finished_at: string | null;
  detector_version: string;
  count_void: number;
  count_illegible: number;
  count_ok: number;
  count_unknown: number;
  breached: number;
  breach_reason: string;
}

/** One verdict row, or `null` when the image has never been judged. */
export function getFrameSubstanceVerdict(db: Db, imageKey: string): FrameSubstanceRow | null {
  const row = prepareCached(
    db,
    'SELECT * FROM image_frame_substance WHERE image_key = ?',
  ).get(imageKey) as FrameSubstanceRow | undefined;
  return row ?? null;
}

/** Every current verdict row, keyed by image. */
export function loadFrameSubstanceVerdictMap(db: Db): Map<string, FrameSubstanceRow> {
  const rows = db.prepare('SELECT * FROM image_frame_substance').all() as FrameSubstanceRow[];
  return new Map(rows.map((r) => [String(r.image_key), r]));
}

/** The most recent completed detection run, if any. */
export function getLatestFinishedFrameSubstanceRun(db: Db): FrameSubstanceRunRow | null {
  const row = db
    .prepare(
      `
        SELECT *
        FROM frame_substance_runs
        WHERE finished_at IS NOT NULL
        ORDER BY run_id DESC
        LIMIT 1
        `,
    )
    .get() as FrameSubstanceRunRow | undefined;
  return row ?? null;
}

export function countFrameSubstanceByVerdict(db: Db): Record<string, number> {
  const rows = db
    .prepare('SELECT verdict, COUNT(*) AS c FROM image_frame_substance GROUP BY verdict')
    .all() as { verdict: string; c: number }[];
  return Object.fromEntries(rows.map((r) => [String(r.verdict), Math.trunc(r.c)]));
}

export function countFrameSubstanceByUnknownReason(db: Db): Record<string, number> {
  const rows = db
    .prepare(
      `
        SELECT unknown_reason, COUNT(*) AS c
        FROM image_frame_substance
        WHERE verdict = 'unknown'
        GROUP BY unknown_reason
        `,
    )
    .all() as { unknown_reason: string; c: number }[];
  return Object.fromEntries(rows.map((r) => [String(r.unknown_reason), Math.trunc(r.c)]));
}

/** Flagged verdict rows (`void` + `illegible`) net of user overrides. */
export function countFrameSubstanceFlaggedNetOfOverrides(db: Db): number {
  const row = db
    .prepare(
      `
        SELECT COUNT(*) AS c
        FROM image_frame_substance fs
        WHERE fs.verdict IN ('void', 'illegible')
          AND NOT EXISTS (
              SELECT 1
              FROM frame_substance_overrides o
              WHERE o.image_key = fs.image_key
          )
        `,
    )
    .get() as { c: number };
  return Math.trunc(row.c);
}

/** Catalog images with no substance verdict row at all. */
export function countFrameSubstanceNeverJudged(db: Db): number {
  const row = db
    .prepare(
      `
        SELECT COUNT(*) AS c
        FROM images i
        WHERE NOT EXISTS (
            SELECT 1
            FROM image_frame_substance fs
            WHERE fs.image_key = i.key
        )
        `,
    )
    .get() as { c: number };
  return Math.trunc(row.c);
}

/** Persist a user override that restores ranking eligibility. Call inside `libraryWrite`. */
export function insertFrameSubstanceOverride(db: Db, imageKey: string): void {
  db.prepare(
    `
      INSERT INTO frame_substance_overrides (image_key)
      VALUES (?)
      ON CONFLICT(image_key) DO NOTHING
      `,
  ).run(imageKey);
}

/** Remove a user override. Returns whether a row was deleted. Call inside `libraryWrite`. */
export function deleteFrameSubstanceOverride(db: Db, imageKey: string): boolean {
  const info = db
    .prepare('DELETE FROM frame_substance_overrides WHERE image_key = ?')
    .run(imageKey);
  return info.changes > 0;
}

export function hasFrameSubstanceOverride(db: Db, imageKey: string): boolean {
  const row = prepareCached(
    db,
    'SELECT 1 AS o FROM frame_substance_overrides WHERE image_key = ?',
  ).get(imageKey);
  return row !== undefined;
}

/** A void/illegible verdict with no user override. */
export function isFrameSubstanceFlagged(db: Db, imageKey: string): boolean {
  const verdict = getFrameSubstanceVerdict(db, imageKey);
  if (verdict === null) return false;
  if (!FLAGGED_VERDICTS.includes(verdict.verdict as (typeof FLAGGED_VERDICTS)[number])) {
    return false;
  }
  return !hasFrameSubstanceOverride(db, imageKey);
}

type StalenessVerdict = Pick<FrameSubstanceRow, 'verdict' | 'unknown_reason' | 'judged_at'>;
type StalenessCache = { compressed_path: string | null; compressed_at: string | null };

/**
 * Whether a verdict no longer describes the image's preview: the preview was rebuilt
 * after it, or the detector found no preview and one exists now.
 *
 * `compressed_at` is local wall-clock and `judged_at` UTC, so they are compared as
 * instants, never as text.
 */
function verdictOutlivedPreview(verdict: StalenessVerdict, cache: StalenessCache | null): boolean {
  if (!cache?.compressed_at) return false;
  if (verdict.verdict === 'unknown') {
    const cp = (cache.compressed_path ?? '').trim();
    if (
      cp !== '' &&
      cp !== VISION_CACHE_OVERSIZED_SENTINEL &&
      (verdict.unknown_reason === 'no_cache_row' || verdict.unknown_reason === 'cache_file_missing')
    ) {
      return true;
    }
  }
  if (!verdict.judged_at) return false;
  return storedInstantMs(cache.compressed_at) > storedInstantMs(verdict.judged_at);
}

/** Whether the preview the detector judged has since been rebuilt. */
export function isFrameSubstanceVerdictStale(
  db: Db,
  imageKey: string,
  opts: { verdictRow?: FrameSubstanceRow | null } = {},
): boolean {
  const verdict =
    opts.verdictRow !== undefined ? opts.verdictRow : getFrameSubstanceVerdict(db, imageKey);
  if (verdict === null || verdict === undefined) return false;
  return verdictOutlivedPreview(verdict, getVisionCachedImage(db, imageKey));
}

/**
 * True when every *active optional* perspective scored `not_attempted`.
 *
 * This is the "excusal channel" hint: the scorer declining every excusable
 * dimension is weak evidence the frame has nothing in it, independent of the pixel
 * detector. Reported as advisory only.
 */
export function hasExcusalChannelHint(db: Db, imageKey: string): boolean {
  const optionalCount = Math.trunc(
    (
      db
        .prepare('SELECT COUNT(*) AS c FROM perspectives WHERE optional = 1 AND active = 1')
        .get() as { c: number }
    ).c,
  );
  if (optionalCount === 0) return false;

  const excusedCount = Math.trunc(
    (
      db
        .prepare(
          `
            SELECT COUNT(*) AS c
            FROM perspectives p
            WHERE p.optional = 1
              AND p.active = 1
              AND EXISTS (
                  SELECT 1
                  FROM image_scores s
                  WHERE s.image_key = ?
                    AND s.image_type = 'catalog'
                    AND s.perspective_slug = p.slug
                    AND s.is_current = 1
                    AND s.not_attempted = 1
              )
            `,
        )
        .get(imageKey) as { c: number }
    ).c,
  );
  return excusedCount === optionalCount;
}

/** Insert a started detection run and return its id. Call inside `libraryWrite`. */
export function insertFrameSubstanceRun(db: Db, detectorVersion: string): number {
  const info = db
    .prepare('INSERT INTO frame_substance_runs (started_at, detector_version) VALUES (?, ?)')
    .run(nowIsoUtc(), detectorVersion);
  return Number(info.lastInsertRowid);
}

/** Finalize a run with per-verdict counts. Call inside `libraryWrite`. */
export function finishFrameSubstanceRun(
  db: Db,
  runId: number,
  counts: {
    countVoid: number;
    countIllegible: number;
    countOk: number;
    countUnknown: number;
    breached: boolean;
    breachReason?: string;
  },
): void {
  db.prepare(
    `
      UPDATE frame_substance_runs
      SET finished_at = ?,
          count_void = ?,
          count_illegible = ?,
          count_ok = ?,
          count_unknown = ?,
          breached = ?,
          breach_reason = ?
      WHERE run_id = ?
      `,
  ).run(
    nowIsoUtc(),
    Math.trunc(counts.countVoid),
    Math.trunc(counts.countIllegible),
    Math.trunc(counts.countOk),
    Math.trunc(counts.countUnknown),
    counts.breached ? 1 : 0,
    counts.breachReason || '',
    Math.trunc(runId),
  );
}

export interface FrameSubstanceVerdictInput {
  image_key: string;
  verdict: FrameSubstanceVerdict;
  unknown_reason?: string;
  black_frac_25?: number | null;
  blown_frac_235?: number | null;
  lap_var?: number | null;
  tile_max?: number | null;
  entropy?: number | null;
  detector_version: string;
  judged_at?: string;
  run_id: number;
}

const UPSERT_VERDICT_SQL = `
    INSERT INTO image_frame_substance (
        image_key, verdict, unknown_reason,
        black_frac_25, blown_frac_235, lap_var, tile_max, entropy,
        detector_version, judged_at, run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(image_key) DO UPDATE SET
        verdict = excluded.verdict,
        unknown_reason = excluded.unknown_reason,
        black_frac_25 = excluded.black_frac_25,
        blown_frac_235 = excluded.blown_frac_235,
        lap_var = excluded.lap_var,
        tile_max = excluded.tile_max,
        entropy = excluded.entropy,
        detector_version = excluded.detector_version,
        judged_at = excluded.judged_at,
        run_id = excluded.run_id
`;

/** Overwrite verdict rows. Call inside `libraryWrite`. */
export function upsertFrameSubstanceVerdicts(
  db: Db,
  rows: readonly FrameSubstanceVerdictInput[],
): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(UPSERT_VERDICT_SQL);
  for (const row of rows) {
    stmt.run(
      String(row.image_key),
      String(row.verdict),
      row.unknown_reason || '',
      row.black_frac_25 ?? null,
      row.blown_frac_235 ?? null,
      row.lap_var ?? null,
      row.tile_max ?? null,
      row.entropy ?? null,
      String(row.detector_version),
      row.judged_at || nowIsoUtc(),
      Math.trunc(row.run_id),
    );
  }
}

/** Keys per query: well under SQLite's bound-parameter limit. */
const KEYS_PER_QUERY = 500;

/** Catalog images for detection, optionally scoped and staleness-filtered; in key order. */
export function listCatalogImagesForFrameSubstance(
  db: Db,
  opts: { imageKeys?: readonly string[] | null; staleOnly?: boolean } = {},
): { image_key: string; compressed_path: string | null }[] {
  const select = (keys: readonly string[] | null) => {
    const where = keys !== null ? `WHERE i.key IN (${keys.map(() => '?').join(',')})` : '';
    const rows = db
      .prepare(
        `
        SELECT i.key AS image_key, vc.compressed_path AS compressed_path,
               vc.compressed_at AS compressed_at, fs.image_key AS judged_key,
               fs.verdict AS verdict, fs.unknown_reason AS unknown_reason, fs.judged_at AS judged_at
        FROM images i
        LEFT JOIN vision_cache vc ON vc.key = i.key
        LEFT JOIN image_frame_substance fs ON fs.image_key = i.key
        ${where}
        ORDER BY i.key ASC
        `,
      )
      .all(...(keys ?? [])) as (StalenessCache &
      StalenessVerdict & { image_key: string; judged_key: string | null })[];
    const wanted = opts.staleOnly
      ? rows.filter((r) => r.judged_key === null || verdictOutlivedPreview(r, r))
      : rows;
    return wanted.map((r) => ({ image_key: r.image_key, compressed_path: r.compressed_path }));
  };

  if (opts.imageKeys === null || opts.imageKeys === undefined) return select(null);
  // Chunks of the sorted keys, each in key order, concatenate in key order. A whole-catalog
  // scope is past SQLite's bound-parameter cap in one `IN (...)`.
  const sorted = [...new Set(opts.imageKeys)].sort();
  const out: { image_key: string; compressed_path: string | null }[] = [];
  for (let i = 0; i < sorted.length; i += KEYS_PER_QUERY) out.push(...select(sorted.slice(i, i + KEYS_PER_QUERY)));
  return out;
}
