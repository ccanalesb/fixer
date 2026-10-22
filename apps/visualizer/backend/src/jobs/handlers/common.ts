/**
 * Cross-family helpers shared by job handlers.
 */
import { openLibraryDb, type Db } from '../../db/connection.js';
import type { JobLogLevel } from '../../db/jobs/jobs.js';
import { upgradeLibrarySchema } from '../../db/library/bootstrap.js';
import { loadCullVerdictsForKeys } from '../../db/library/cull-verdicts.js';
import { CullingStageError } from '../../cull/stage-models.js';
import { AuthenticationError, InvalidRequestError } from '../../providers/errors.js';
import type { AnalyzeStage } from '../checkpoint.js';
import { requireLibraryDb } from '../library-db.js';
import type { ErrorSeverity, JobRunner } from '../runner.js';

/**
 * The library DB path, or `null` after failing the job with the reason.
 *
 * Centralized so every catalog-dependent handler reports the same accurate
 * message — the resolution failure is presentable text, not a stack trace.
 */
export function resolveLibraryDbOrFail(runner: JobRunner, jobId: string): string | null {
  try {
    return requireLibraryDb();
  } catch (e) {
    runner.failJob(jobId, e instanceof Error ? e.message : String(e), 'warning');
    return null;
  }
}

/**
 * Open the catalog for the duration of `fn` and always close it.
 *
 * Writable: handlers exist to mutate the catalog, unlike the routes, which open
 * read-only unless they declare otherwise.
 */
export async function withLibraryDb<T>(path: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const db = openLibraryDb(path);
  try {
    upgradeLibrarySchema(db);
    return await fn(db);
  } finally {
    db.close();
  }
}

/**
 * How loudly the UI should report a failure.
 *
 * `warning` is for the user's own inputs — a bad key, an expired token, or a culling stage whose
 * model or endpoint is not set up, is not a defect. `critical` is for the two cases where continuing would be unsafe: the
 * filesystem refusing the process, and a write attempted against a catalog
 * Lightroom still holds open.
 */
export function failureSeverityFromError(e: unknown): ErrorSeverity {
  if (e instanceof AuthenticationError || e instanceof InvalidRequestError || e instanceof CullingStageError) {
    return 'warning';
  }
  // Node reports filesystem and permission failures with both `errno` and `code`.
  if (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { errno?: unknown }).errno === 'number' &&
    typeof (e as { code?: unknown }).code === 'string'
  ) {
    return 'critical';
  }
  if (e instanceof Error && e.message === 'Close Lightroom before writing to catalog.') {
    return 'critical';
  }
  return 'error';
}

/**
 * Narrow a provider `LogCallback` level onto the four the job log stores.
 *
 * The provider layer types its level as a bare string — it is shared with the
 * routes, which log to stdout — so anything it emits outside the enum lands as
 * `info` rather than writing a level the log filters cannot select.
 */
export function jobLogLevel(level: string): JobLogLevel {
  return level === 'debug' || level === 'info' || level === 'warning' || level === 'error'
    ? level
    : 'info';
}

/** Job metadata as a plain object, whatever the column happened to hold. */
export function asMetadata(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

/** A metadata value read as an int, or `null` when it is not one. */
export function readIntOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined || typeof raw === 'boolean') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Exclude videos in SQL rather than after the fact, so a worker slot is never
 * spent opening a `.mov` only to discover it is not describable.
 */
const CATALOG_NOT_VIDEO_SQL = [
  '.mov',
  '.mp4',
  '.avi',
  '.mkv',
  '.wmv',
  '.m4v',
  '.3gp',
  '.webm',
  '.mts',
  '.m2ts',
]
  .map((ext) => `LOWER(i.filepath) NOT LIKE '%${ext}'`)
  .join(' AND ');

/**
 * Keep condemned frames out of a scoring selection (#298).
 *
 * `void` only, not the `illegible` half of the flagged pair: an illegible frame
 * still has a subject to judge, while a void one is a lens cap. An override row is
 * the user saying the detector was wrong, which puts the frame back in.
 */
const VOID_SUBSTANCE_SCORING_EXCLUDE_SQL = `
    NOT EXISTS (
        SELECT 1
        FROM image_frame_substance fs
        WHERE fs.image_key = i.key
          AND fs.verdict = 'void'
          AND NOT EXISTS (
              SELECT 1
              FROM frame_substance_overrides o
              WHERE o.image_key = fs.image_key
          )
    )
`;

/** Keys per query: well under SQLite's bound-parameter limit. */
const KEYS_PER_QUERY = 500;

/**
 * Drop condemned frames from a selection that already exists.
 *
 * `selectCatalogKeys`'s `excludeVoidSubstance` does the same thing in SQL, and is
 * what a standalone `batch_score` uses. The culling step before describe and score
 * cannot: the verdicts it filters on are written by its own frame-substance pass,
 * after the selection was made. Void frames are neither described nor scored.
 *
 * One query per 500 keys: a whole-catalog selection is past SQLite's
 * bound-parameter cap in a single `IN (...)`.
 */
export function filterVoidSubstanceFromScoringSelection(
  db: Db,
  selection: readonly (readonly [string, string])[],
): (readonly [string, string])[] {
  if (selection.length === 0) return [...selection];
  const keys = [...new Set(selection.map(([k]) => k))];
  const condemned = new Set<string>();
  for (let i = 0; i < keys.length; i += KEYS_PER_QUERY) {
    const chunk = keys.slice(i, i + KEYS_PER_QUERY);
    const rows = db
      .prepare(
        'SELECT fs.image_key AS image_key FROM image_frame_substance fs ' +
          `WHERE fs.image_key IN (${chunk.map(() => '?').join(',')}) ` +
          "AND fs.verdict = 'void' " +
          'AND NOT EXISTS (SELECT 1 FROM frame_substance_overrides o WHERE o.image_key = fs.image_key)',
      )
      .all(...(chunk as never[])) as { image_key: string }[];
    for (const r of rows) condemned.add(r.image_key);
  }
  if (condemned.size === 0) return [...selection];
  return selection.filter(([k]) => !condemned.has(k));
}

/** Photos of a selection not sent to kimi because of their cull verdict, by reason. */
export interface CullHeldBack {
  filtered_by_culling_profile: number;
  filtered_by_score_forecast: number;
  /** A stage still unanswered (Laya failed on it, or no image to read): retried by the next job. */
  pending: number;
  /** Never culled: only when the culling step could not reach the photo. */
  no_verdict: number;
}

/**
 * Keep only the photos culling passed: verdict `passed`, or sent by hand whatever the verdict.
 *
 * Reads the summary rows as they are — the culling step before describe and score has just made them
 * current for every photo in scope. `sentByHandKept` names the kept photos the user sent by hand, so
 * the step can count the ones the stages alone would have filtered.
 */
export function dropFilteredPhotosFromDescribeAndScoringSelection<T extends readonly [string, string]>(
  db: Db,
  selection: readonly T[],
): { kept: T[]; heldBack: CullHeldBack; sentByHandKept: string[] } {
  const verdicts = loadCullVerdictsForKeys(db, [...new Set(selection.map(([k]) => k))]);
  const heldBack: CullHeldBack = { filtered_by_culling_profile: 0, filtered_by_score_forecast: 0, pending: 0, no_verdict: 0 };
  const kept: T[] = [];
  const sentByHandKept: string[] = [];
  for (const pair of selection) {
    const v = verdicts.get(pair[0]);
    if (v?.sentByHand) {
      kept.push(pair);
      sentByHandKept.push(pair[0]);
    } else if (v?.verdict === 'passed') kept.push(pair);
    else if (v === undefined) heldBack.no_verdict += 1;
    else if (v.verdict === 'pending') heldBack.pending += 1;
    else if (v.filteredBy === 'score_forecast') heldBack.filtered_by_score_forecast += 1;
    else heldBack.filtered_by_culling_profile += 1;
  }
  return { kept, heldBack, sentByHandKept };
}

/**
 * Where a pass keeps the units it has finished, so an interrupted run resumes.
 *
 * Three genuinely different answers, which is why this is a union rather than an
 * optional key. `flat` is a pass running as its own job, writing the checkpoint
 * on its job row. `nested` is a `batch_analyze` stage, whose set lives in a
 * sub-object of the composite's checkpoint. `none` is a `catalog_cache_build`
 * stage: that chain is re-runnable end to end, and a checkpoint written under the
 * composite's job id would be read back by whichever stage ran last.
 */
export type PassCheckpoint =
  | { mode: 'flat' }
  | { mode: 'nested'; key: AnalyzeStage }
  | { mode: 'none' }
  | { mode: 'step'; host: 'batch_describe' | 'batch_score' };

/**
 * Everything a pass needs to know about the job it is running inside.
 *
 * Every pass owns a band of the progress bar and a log prefix; a pass running
 * standalone owns the whole bar and an empty prefix, which is why this is
 * required rather than an optional "am I a stage" argument. The only real
 * question is who settles the job at the end — `job` means this pass calls
 * `completeJob`/`failJob` and returns null, `stage` means it hands its summary
 * back for the composite to combine.
 */
export interface PassContext {
  progressRange: readonly [number, number];
  logPrefix: string;
  settle: 'job' | 'stage';
  checkpoint: PassCheckpoint;
}

/** A pass that is the whole job: the full bar, no prefix, its own checkpoint. */
export const OWN_JOB: PassContext = {
  progressRange: [0, 100],
  logPrefix: '',
  settle: 'job',
  checkpoint: { mode: 'flat' },
};

/** A `catalog_cache_build` stage: a band of the bar, and no resume state. */
export function chainStage(
  progressRange: readonly [number, number],
  logPrefix: string,
): PassContext {
  return { progressRange, logPrefix, settle: 'stage', checkpoint: { mode: 'none' } };
}

/** A `batch_analyze` stage, which resumes into a sub-object of the composite's. */
export function analyzeStage(
  progressRange: readonly [number, number],
  logPrefix: string,
  key: AnalyzeStage,
): PassContext {
  return { progressRange, logPrefix, settle: 'stage', checkpoint: { mode: 'nested', key } };
}

/** The in-job cull step inside `batch_describe` / `batch_score` (checkpoint sub-object). */
export function cullStep(
  progressRange: readonly [number, number],
  logPrefix: string,
  host: 'batch_describe' | 'batch_score',
): PassContext {
  return { progressRange, logPrefix, settle: 'stage', checkpoint: { mode: 'step', host } };
}

/** Map a pass's own 0–100 onto the slice of the bar it was given. */
export function mapPassProgress(ctx: PassContext, pct: number): number {
  const [lo, hi] = ctx.progressRange;
  return Math.trunc(lo + ((hi - lo) * pct) / 100);
}

/** Legacy `date_filter` tokens, still sent by older clients and checkpoints. */
const LEGACY_DATE_FILTER_MONTHS: Record<string, number> = {
  '3months': 3,
  '6months': 6,
  '12months': 12,
};

export interface DateWindow {
  months: number | null;
  year: string | null;
}

/**
 * Normalize the date-range metadata into `(months, year)`.
 *
 * `last_months` wins over `year` deliberately: ANDing both would silently
 * intersect them into a window narrower than either, which no caller means.
 */
export function resolveDateWindow(metadata: Record<string, unknown>): DateWindow {
  let months: number | null = null;
  let year: string | null = null;

  const rawLastMonths = metadata['last_months'];
  if (typeof rawLastMonths !== 'boolean') {
    const n = readIntOrNull(rawLastMonths);
    if (n !== null && n > 0) months = n;
  }

  if (months === null) {
    const rawYear = metadata['year'];
    if (typeof rawYear === 'number' && rawYear >= 1900 && rawYear <= 9999) {
      year = String(rawYear);
    } else if (typeof rawYear === 'string' && /^\d{4}$/.test(rawYear.trim())) {
      year = rawYear.trim();
    }
  }

  if (months === null && year === null) {
    const dateFilter = String(metadata['date_filter'] ?? 'all');
    months = LEGACY_DATE_FILTER_MONTHS[dateFilter] ?? null;
  }

  return { months, year };
}

export interface CatalogSelectionOptions {
  months: number | null;
  year: string | null;
  minRating: number | null;
  /** Skip images that already carry a catalog description. */
  undescribedOnly: boolean;
  /** Skip frames the detector called void, unless the user overrode it. */
  excludeVoidSubstance?: boolean;
}

/** Newest first, undated last — the order the UI lists the catalog in. */
const CATALOG_SELECTION_ORDER =
  ' ORDER BY (i.date_taken IS NULL) DESC, i.date_taken DESC, i.key DESC';

/** `(key, 'catalog')` pairs matching the window. */
export function selectCatalogKeys(
  db: Db,
  opts: CatalogSelectionOptions,
): [string, string][] {
  const params: unknown[] = [];
  const conditions = [CATALOG_NOT_VIDEO_SQL];

  // A description made from a since-turned cache image counts as undescribed.
  let sql = opts.undescribedOnly
    ? "SELECT i.key AS key FROM images i " +
      "LEFT JOIN image_descriptions d ON i.key = d.image_key AND d.image_type = 'catalog' " +
      'WHERE (d.image_key IS NULL OR EXISTS (SELECT 1 FROM vision_stale vs ' +
      "WHERE vs.image_key = i.key AND vs.output = 'description'))"
    : 'SELECT i.key AS key FROM images i WHERE 1=1';

  if (opts.excludeVoidSubstance) conditions.push(VOID_SUBSTANCE_SCORING_EXCLUDE_SQL);
  if (opts.months) {
    conditions.push("i.date_taken >= date('now', ?)");
    params.push(`-${opts.months} months`);
  }
  if (opts.year !== null) {
    conditions.push("strftime('%Y', i.date_taken) = ?");
    params.push(opts.year);
  }
  if (opts.minRating !== null) {
    conditions.push('i.rating >= ?');
    params.push(opts.minRating);
  }

  sql += ` AND ${conditions.join(' AND ')}${CATALOG_SELECTION_ORDER}`;
  const rows = db.prepare(sql).all(...(params as never[])) as { key: string }[];
  return rows.map((r) => [r.key, 'catalog']);
}

/** Narrow a job to explicit catalog keys (send-by-hand and similar). */
export function selectionFromImageKeys(db: Db, keys: readonly string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < keys.length; i += KEYS_PER_QUERY) {
    const chunk = keys.slice(i, i + KEYS_PER_QUERY);
    const rows = db
      .prepare(`SELECT key FROM images WHERE key IN (${chunk.map(() => '?').join(',')})`)
      .all(...(chunk as never[])) as { key: string }[];
    for (const r of rows) out.push([r.key, 'catalog']);
  }
  return out;
}

export function readImageKeysFromMetadata(raw: unknown): string[] | null {
  return Array.isArray(raw) && raw.length > 0 ? raw.map((k) => String(k)) : null;
}

/**
 * Catalog images whose description row predates the visual-tag columns.
 *
 * `dominant_colors IS NULL` is the marker: those rows were written before the
 * colour and mood fields existed, and a backfill re-describes exactly them.
 */
export function selectCatalogKeysMissingVisualTags(
  db: Db,
  opts: Omit<CatalogSelectionOptions, 'undescribedOnly'>,
): [string, string][] {
  const params: unknown[] = [];
  const conditions = [CATALOG_NOT_VIDEO_SQL];

  if (opts.months) {
    conditions.push("i.date_taken >= date('now', ?)");
    params.push(`-${opts.months} months`);
  }
  if (opts.year !== null) {
    conditions.push("strftime('%Y', i.date_taken) = ?");
    params.push(opts.year);
  }
  if (opts.minRating !== null) {
    conditions.push('i.rating >= ?');
    params.push(opts.minRating);
  }

  const sql =
    'SELECT i.key AS key FROM images i WHERE EXISTS (' +
    '  SELECT 1 FROM image_descriptions d' +
    "  WHERE d.image_key = i.key AND d.image_type = 'catalog' AND d.dominant_colors IS NULL" +
    `) AND ${conditions.join(' AND ')}${CATALOG_SELECTION_ORDER}`;
  const rows = db.prepare(sql).all(...(params as never[])) as { key: string }[];
  return rows.map((r) => [r.key, 'catalog']);
}
