/**
 * Frame substance detection: the batch driver and the `batch_frame_substance`
 * job.
 *
 * The driver lives beside the handler so composite jobs can chain it as a stage;
 * the detector itself stays free of database imports.
 *
 * A run rewrites every verdict it judges and records a `frame_substance_runs`
 * row. The guard is advisory by design: a run that trips it still writes its
 * verdicts, because a detector that suddenly condemns a tenth of the catalog is
 * something the user has to *see* before anyone can tell whether the thresholds
 * moved or the previews did.
 */
import { statSync } from 'node:fs';
import type { Db } from '../../db/connection.js';
import { FLAGGED_VERDICTS } from '../../db/library/frame-substance-sql.js';
import {
  finishFrameSubstanceRun,
  insertFrameSubstanceRun,
  listCatalogImagesForFrameSubstance,
  loadFrameSubstanceVerdictMap,
  upsertFrameSubstanceVerdicts,
  type FrameSubstanceVerdictInput,
} from '../../db/library/frame-substance.js';
import { VISION_CACHE_OVERSIZED_SENTINEL } from '../../db/library/vision-cache.js';
import { libraryWrite } from '../../db/library/write.js';
import {
  classifyVerdict,
  computeStatisticsFromPath,
  detectorVersion,
  type UnknownReason,
  type Verdict,
} from '../../imaging/frame-substance-detector.js';
import type { JobRunner } from '../runner.js';
import { failureSeverityFromError, resolveLibraryDbOrFail, withLibraryDb } from './common.js';

/** A run flagging more than this many frames is reported as a breach outright. */
export const ABSOLUTE_FLAGGED_BOUND = 250;
/** …or more than this multiple of what the previous run flagged on the same images. */
export const RATIO_FLAGGED_MULTIPLIER = 3.0;

/** Rows are flushed and progress reported every this many images. */
const PROGRESS_EVERY = 500;

export interface FrameSubstanceRunResult {
  run_id: number | null;
  detector_version: string;
  total: number;
  count_void: number;
  count_illegible: number;
  count_ok: number;
  count_unknown: number;
  flagged: number;
  breached: boolean;
  breach_reason: string;
}

export interface FrameSubstanceRunOptions {
  /** Restrict candidates to these catalog keys. Absent means the whole catalog. */
  imageKeys?: readonly string[] | null;
  /** Skip images whose verdict is newer than their preview (chain mode). */
  staleOnly?: boolean;
  progress?: (pct: number, message: string) => void;
  isCancelled?: () => boolean;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Why the cache cannot be decoded, or `null` when there is a file to read. */
function resolveUnknownReason(compressedPath: string | null): UnknownReason | null {
  const cp = (compressedPath ?? '').trim();
  if (!cp) return 'no_cache_row';
  if (cp === VISION_CACHE_OVERSIZED_SENTINEL) return 'oversized_sentinel';
  if (!isFile(cp)) return 'cache_file_missing';
  return null;
}

function emptyVerdictRow(
  imageKey: string,
  unknownReason: UnknownReason,
  version: string,
  runId: number,
): FrameSubstanceVerdictInput {
  return {
    image_key: imageKey,
    verdict: 'unknown',
    unknown_reason: unknownReason,
    black_frac_25: null,
    blown_frac_235: null,
    lap_var: null,
    tile_max: null,
    entropy: null,
    detector_version: version,
    run_id: runId,
  };
}

async function judgeImage(
  imageKey: string,
  compressedPath: string | null,
  version: string,
  runId: number,
): Promise<FrameSubstanceVerdictInput> {
  const unknown = resolveUnknownReason(compressedPath);
  if (unknown !== null) return emptyVerdictRow(imageKey, unknown, version, runId);

  const stats = await computeStatisticsFromPath(String(compressedPath));
  if (stats === null) return emptyVerdictRow(imageKey, 'decode_failed', version, runId);

  return {
    image_key: imageKey,
    verdict: classifyVerdict(stats),
    unknown_reason: '',
    black_frac_25: stats.black_frac_25,
    blown_frac_235: stats.blown_frac_235,
    lap_var: stats.lap_var,
    tile_max: stats.tile_max,
    entropy: stats.entropy,
    detector_version: version,
    run_id: runId,
  };
}

type VerdictCounts = Record<Verdict, number>;

function countVerdicts(rows: Iterable<{ verdict: string }>): VerdictCounts {
  const counts: VerdictCounts = { void: 0, illegible: 0, ok: 0, unknown: 0 };
  for (const row of rows) {
    const verdict = row.verdict as Verdict;
    counts[verdict] = (counts[verdict] ?? 0) + 1;
  }
  return counts;
}

function flaggedCount(counts: VerdictCounts): number {
  return counts.void + counts.illegible;
}

function isFlagged(verdict: string): boolean {
  return (FLAGGED_VERDICTS as readonly string[]).includes(verdict);
}

/**
 * Whether a completed run looks like a detector regression rather than a catalog
 * that changed.
 *
 * The ratio bound is computed over the *intersection* of the two runs, ignoring
 * images either run called `unknown`. Raw growth would fire on any large catalog
 * import, which is the ordinary case this is meant to stay quiet about.
 */
export function evaluateBreach(
  newRows: ReadonlyMap<string, { verdict: string }>,
  previousRows: ReadonlyMap<string, { verdict: string }>,
): { breached: boolean; reason: string } {
  const flagged = flaggedCount(countVerdicts(newRows.values()));
  if (flagged > ABSOLUTE_FLAGGED_BOUND) {
    return {
      breached: true,
      reason: `absolute bound: ${flagged} flagged > ${ABSOLUTE_FLAGGED_BOUND}`,
    };
  }
  if (previousRows.size === 0) return { breached: false, reason: '' };

  let prevFlagged = 0;
  let newFlagged = 0;
  let intersection = 0;
  for (const [key, row] of newRows) {
    const previous = previousRows.get(key);
    if (previous === undefined) continue;
    if (previous.verdict === 'unknown' || row.verdict === 'unknown') continue;
    intersection += 1;
    if (isFlagged(previous.verdict)) prevFlagged += 1;
    if (isFlagged(row.verdict)) newFlagged += 1;
  }
  if (intersection === 0) return { breached: false, reason: '' };

  if (prevFlagged > 0 && newFlagged > RATIO_FLAGGED_MULTIPLIER * prevFlagged) {
    return {
      breached: true,
      reason:
        `ratio bound: intersection flagged ${newFlagged} > ` +
        `${RATIO_FLAGGED_MULTIPLIER}x previous ${prevFlagged}`,
    };
  }
  return { breached: false, reason: '' };
}

function emptyRunResult(): FrameSubstanceRunResult {
  return {
    run_id: null,
    detector_version: detectorVersion(),
    total: 0,
    count_void: 0,
    count_illegible: 0,
    count_ok: 0,
    count_unknown: 0,
    flagged: 0,
    breached: false,
    breach_reason: '',
  };
}

/**
 * Judge the catalog, overwrite verdict rows, and finalize the run record.
 *
 * Returns `null` when the caller's `isCancelled` went true mid-run; the rows
 * already flushed stay, and the run row stays unfinished, which is how a
 * cancelled run is told apart from a completed one.
 */
export async function runFrameSubstanceDetection(
  db: Db,
  opts: FrameSubstanceRunOptions = {},
): Promise<FrameSubstanceRunResult | null> {
  const catalogRows = listCatalogImagesForFrameSubstance(db, {
    imageKeys: opts.imageKeys ?? null,
    staleOnly: opts.staleOnly ?? false,
  });
  const total = catalogRows.length;
  if (total === 0) return emptyRunResult();

  const version = detectorVersion();
  const previousRows = loadFrameSubstanceVerdictMap(db);
  const runId = libraryWrite(db, () => insertFrameSubstanceRun(db, version));

  const newRows = new Map<string, FrameSubstanceVerdictInput>();
  let batch: FrameSubstanceVerdictInput[] = [];
  const flush = (): void => {
    if (batch.length === 0) return;
    const pending = batch;
    batch = [];
    libraryWrite(db, () => upsertFrameSubstanceVerdicts(db, pending));
  };

  for (const [i, row] of catalogRows.entries()) {
    if (opts.isCancelled?.()) return null;

    const verdictRow = await judgeImage(row.image_key, row.compressed_path, version, runId);
    newRows.set(row.image_key, verdictRow);
    batch.push(verdictRow);

    const done = i + 1;
    if (batch.length >= PROGRESS_EVERY) flush();
    if (opts.progress && (done % PROGRESS_EVERY === 0 || done === total)) {
      opts.progress(5 + Math.trunc((95 * done) / total), `Frame substance: checked ${done}/${total} images`);
    }
  }
  flush();

  const counts = countVerdicts(newRows.values());
  const { breached, reason } = evaluateBreach(newRows, previousRows);
  libraryWrite(db, () =>
    finishFrameSubstanceRun(db, runId, {
      countVoid: counts.void,
      countIllegible: counts.illegible,
      countOk: counts.ok,
      countUnknown: counts.unknown,
      breached,
      breachReason: reason,
    }),
  );

  return {
    run_id: runId,
    detector_version: version,
    total,
    count_void: counts.void,
    count_illegible: counts.illegible,
    count_ok: counts.ok,
    count_unknown: counts.unknown,
    flagged: flaggedCount(counts),
    breached,
    breach_reason: reason,
  };
}

/**
 * Scan local vision-cache previews and persist frame substance verdicts.
 *
 * Takes no metadata: the job is a whole-catalog rescan, and the two knobs the
 * driver has — a key scope and staleness — belong to the chained `batch_analyze`
 * stage, which knows which images it just touched.
 */
export async function handleBatchFrameSubstance(runner: JobRunner, jobId: string): Promise<void> {
  const dbPath = resolveLibraryDbOrFail(runner, jobId);
  if (dbPath === null) return;

  runner.updateProgress(jobId, 5, 'Scanning catalog for frame substance...');

  try {
    const result = await withLibraryDb(dbPath, (db) =>
      runFrameSubstanceDetection(db, {
        progress: (pct, message) => runner.updateProgress(jobId, pct, message),
        isCancelled: () => runner.isCancelled(jobId),
      }),
    );
    if (result === null) {
      runner.finalizeCancelled(jobId);
      return;
    }
    runner.completeJob(jobId, result);
  } catch (e) {
    runner.failJob(jobId, e instanceof Error ? e.message : String(e), failureSeverityFromError(e));
  }
}
