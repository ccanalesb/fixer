/**
 * Frame substance batch driver and batch_frame_substance job — real greyscale JPEGs
 * and library.db; flat black and fixed-seed noise fixtures produce stable verdicts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { LibraryFixture } from './helpers/library-fixture.js';
import { openLibraryDb, type Db } from '../src/db/connection.js';
import { VISION_CACHE_OVERSIZED_SENTINEL } from '../src/db/library/vision-cache.js';
import { createJob, getJob, initJobsDb } from '../src/db/jobs/jobs.js';
import { JobRunner } from '../src/jobs/runner.js';
import { tick } from '../src/jobs/processor.js';
import {
  ABSOLUTE_FLAGGED_BOUND,
  evaluateBreach,
  runFrameSubstanceDetection,
  type FrameSubstanceRunResult,
} from '../src/jobs/handlers/frame-substance.js';
import { detectorVersion } from '../src/imaging/frame-substance-detector.js';
import { nowIsoLocal, storedInstantMs } from '../src/utils/datetime.js';
import {
  isFrameSubstanceVerdictStale,
  listCatalogImagesForFrameSubstance,
} from '../src/db/library/frame-substance.js';

let fx: LibraryFixture;
let dir: string;
let jobsDbPath: string;

/** A 64x64 greyscale JPEG, big enough for the detector's 32x32 tile grid. */
async function writeGreyJpeg(name: string, pixel: (x: number, y: number) => number) {
  const side = 64;
  const data = Buffer.alloc(side * side);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) data[y * side + x] = pixel(x, y);
  }
  const path = join(dir, name);
  await sharp(data, { raw: { width: side, height: side, channels: 1 } })
    .jpeg({ quality: 100 })
    .toFile(path);
  return path;
}

/** A lens cap: flat black, so every statistic collapses and the verdict is void. */
const writeVoidJpeg = (name: string) => writeGreyJpeg(name, () => 0);

/** A photograph: mid-grey noise with enough structure to read as ok. */
function writeOkJpeg(name: string) {
  let seed = 12345;
  return writeGreyJpeg(name, () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return 80 + (seed % 96);
  });
}

/** Seed a catalog row pointed at `compressedPath`, or at nothing when null. */
function seedImage(key: string, compressedPath: string | null): void {
  fx.addImage({ key });
  if (compressedPath !== null) fx.addVisionCache(key, compressedPath);
}

async function withLibrary<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const db = openLibraryDb(fx.dbPath);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

type DetectOptions = Parameters<typeof runFrameSubstanceDetection>[1];

const detect = (opts: DetectOptions = {}) =>
  withLibrary((db) => runFrameSubstanceDetection(db, opts));

/** `detect` for the runs that are not expected to be cancelled. */
async function detectOk(opts: DetectOptions = {}): Promise<FrameSubstanceRunResult> {
  const result = await detect(opts);
  expect(result).not.toBeNull();
  return result!;
}

interface VerdictRow {
  image_key: string;
  verdict: string;
  unknown_reason: string;
  detector_version: string;
  run_id: number;
  lap_var: number | null;
}

const verdictRows = (): VerdictRow[] =>
  fx.query<VerdictRow>('SELECT * FROM image_frame_substance ORDER BY image_key');

const verdictFor = (key: string): VerdictRow | undefined =>
  verdictRows().find((r) => r.image_key === key);

/** Enqueue, run one processor pass, and hand back the settled job. */
async function runJob() {
  const db = initJobsDb(jobsDbPath);
  try {
    const jobId = createJob(db, 'batch_frame_substance', {});
    await tick(db, new JobRunner(db));
    return getJob(db, jobId)!;
  } finally {
    db.close();
  }
}

const verdicts = (...pairs: [string, string][]) =>
  new Map(pairs.map(([key, verdict]) => [key, { verdict }]));

/** `k0…kN-1`, each carrying the verdict `at` gives for its index. */
const numberedVerdicts = (count: number, at: (i: number) => string) =>
  verdicts(...Array.from({ length: count }, (_, i): [string, string] => [`k${i}`, at(i)]));

const runRow = () =>
  fx.query<{ finished_at: string | null; count_void: number; breached: number }>(
    'SELECT * FROM frame_substance_runs',
  )[0]!;

const setCompressedAt = (key: string, when: string) =>
  fx.exec('UPDATE vision_cache SET compressed_at = ? WHERE key = ?', when, key);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-fs-job-'));
  jobsDbPath = join(dir, 'visualizer.db');
  fx = new LibraryFixture().activate();
  process.env.DATABASE_PATH = jobsDbPath;
});

afterEach(() => {
  delete process.env.DATABASE_PATH;
  fx.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe('runFrameSubstanceDetection', () => {
  it('judges the catalog and records the run', async () => {
    seedImage('void', await writeVoidJpeg('void.jpg'));
    seedImage('good', await writeOkJpeg('good.jpg'));

    const result = await detectOk();

    expect(result).toMatchObject({
      total: 2,
      count_void: 1,
      count_illegible: 0,
      count_ok: 1,
      count_unknown: 0,
      flagged: 1,
      breached: false,
      breach_reason: '',
      detector_version: detectorVersion(),
    });
    expect(verdictFor('void')?.verdict).toBe('void');
    expect(verdictFor('good')?.verdict).toBe('ok');

    expect(runRow()).toMatchObject({ count_void: 1, breached: 0 });
    expect(runRow().finished_at).not.toBeNull();
  });

  it('stores the statistics alongside the verdict', async () => {
    seedImage('good', await writeOkJpeg('good.jpg'));

    await detect();

    expect(verdictFor('good')!.lap_var).toBeGreaterThan(0);
  });

  it('reports an empty catalog without opening a run', async () => {
    const result = await detect();

    expect(result).toMatchObject({ run_id: null, total: 0 });
    expect(fx.query('SELECT * FROM frame_substance_runs')).toEqual([]);
  });

  /** Each of the four ways a preview can be unreadable gets its own reason. */
  it.each([
    ['no cache row at all', null, 'no_cache_row'],
    ['an empty compressed path', '', 'no_cache_row'],
    ['the oversized sentinel', VISION_CACHE_OVERSIZED_SENTINEL, 'oversized_sentinel'],
    ['a path with no file behind it', 'MISSING', 'cache_file_missing'],
    ['a file that is not an image', 'CORRUPT', 'decode_failed'],
  ])('is unknown for %s', async (_label, marker, reason) => {
    let path = marker;
    if (marker === 'MISSING') path = join(dir, 'gone.jpg');
    if (marker === 'CORRUPT') {
      path = join(dir, 'bad.jpg');
      writeFileSync(path, 'not-a-jpeg');
    }
    seedImage('probe', path);

    const result = await detectOk();

    expect(result.count_unknown).toBe(1);
    expect(verdictFor('probe')).toMatchObject({ verdict: 'unknown', unknown_reason: reason });
  });

  it('leaves a user override in place across a rerun', async () => {
    seedImage('void', await writeVoidJpeg('void.jpg'));
    await detect();
    fx.addFrameSubstanceOverride('void');

    await detect();

    expect(verdictFor('void')?.verdict).toBe('void');
    expect(
      fx.query('SELECT 1 FROM frame_substance_overrides WHERE image_key = ?', 'void'),
    ).toHaveLength(1);
  });

  it('judges only the scoped stale images in chain mode', async () => {
    seedImage('in_run', await writeOkJpeg('in_run.jpg'));
    seedImage('outside', await writeOkJpeg('outside.jpg'));
    await detect();
    const judgedBefore = verdictFor('outside')!.run_id;
    setCompressedAt('in_run', '2999-01-01T00:00:00');

    const result = await detectOk({ imageKeys: ['in_run'], staleOnly: true });

    expect(result.total).toBe(1);
    expect(verdictFor('outside')!.run_id).toBe(judgedBefore);
    expect(verdictFor('in_run')!.run_id).toBeGreaterThan(judgedBefore);
  });

  it('sees a preview rebuilt after the verdict though its local time sorts before the UTC verdict', async () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      seedImage('rebuilt', await writeOkJpeg('rebuilt.jpg'));
      seedImage('older', await writeOkJpeg('older.jpg'));
      await detect();
      const judgedMs = storedInstantMs(
        fx.query<{ judged_at: string }>('SELECT judged_at FROM image_frame_substance WHERE image_key = ?', 'rebuilt')[0]!
          .judged_at,
      );
      setCompressedAt('rebuilt', nowIsoLocal(new Date(judgedMs + 60 * 60_000)));
      setCompressedAt('older', nowIsoLocal(new Date(judgedMs - 60 * 60_000)));

      const lib = openLibraryDb(fx.dbPath);
      try {
        expect(isFrameSubstanceVerdictStale(lib, 'rebuilt')).toBe(true);
        expect(isFrameSubstanceVerdictStale(lib, 'older')).toBe(false);
        const rows = listCatalogImagesForFrameSubstance(lib, { staleOnly: true });
        expect(rows.map((r) => r.image_key)).toEqual(['rebuilt']);
      } finally {
        lib.close();
      }
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it('skips a scoped image whose verdict is already newer than its preview', async () => {
    seedImage('fresh', await writeOkJpeg('fresh.jpg'));
    await detect();
    setCompressedAt('fresh', '2000-01-01T00:00:00');

    const result = await detectOk({ imageKeys: ['fresh'], staleOnly: true });

    expect(result.total).toBe(0);
  });

  it('treats unknown (no cache row) as stale once a vision cache exists', async () => {
    fx.addImage({ key: 'cached_later', filepath: '/x/a.NEF' });
    await detectOk({ imageKeys: ['cached_later'] });
    expect(verdictFor('cached_later')?.unknown_reason).toBe('no_cache_row');
    const jpeg = await writeOkJpeg('cached_later.jpg');
    fx.addVisionCache('cached_later', jpeg);
    const lib = openLibraryDb(fx.dbPath);
    const rows = listCatalogImagesForFrameSubstance(lib, {
      imageKeys: ['cached_later'],
      staleOnly: true,
    });
    lib.close();
    expect(rows.map((r) => r.image_key)).toEqual(['cached_later']);
  });

  it('does not treat unknown as stale when vision_cache has a path but no compressed_at', async () => {
    fx.addImage({ key: 'no_ts', filepath: '/x/b.NEF' });
    await detectOk({ imageKeys: ['no_ts'] });
    const jpeg = await writeOkJpeg('no_ts.jpg');
    fx.exec(
      `INSERT INTO vision_cache (key, compressed_path, phash, compressed_at, original_mtime)
       VALUES (?, ?, NULL, NULL, 1.0)`,
      'no_ts',
      jpeg,
    );
    const lib = openLibraryDb(fx.dbPath);
    expect(isFrameSubstanceVerdictStale(lib, 'no_ts')).toBe(false);
    const rows = listCatalogImagesForFrameSubstance(lib, { imageKeys: ['no_ts'], staleOnly: true });
    lib.close();
    expect(rows).toEqual([]);
  });

  it('stops without finishing the run when cancelled mid-scan', async () => {
    seedImage('a', await writeVoidJpeg('a.jpg'));
    seedImage('b', await writeVoidJpeg('b.jpg'));

    const result = await detect({ isCancelled: () => true });

    expect(result).toBeNull();
    expect(verdictRows()).toEqual([]);
    expect(runRow().finished_at).toBeNull();
  });

  /**
   * The guard is a report, not a veto. A run that trips it has still done the work
   * and the user needs the rows to see what the detector actually did.
   */
  it('writes the verdicts of a run that trips the guard', async () => {
    const voidPath = await writeVoidJpeg('void.jpg');
    for (const key of ['v1', 'v2', 'v3', 'v4']) seedImage(key, voidPath);
    seedImage('ok', await writeOkJpeg('ok.jpg'));
    // A previous run that flagged one of the five: four is more than three times one.
    fx.addFrameSubstance('v1', 'void');
    for (const key of ['v2', 'v3', 'v4', 'ok']) fx.addFrameSubstance(key, 'ok');

    const result = await detectOk();

    expect(result.breached).toBe(true);
    expect(result.breach_reason).toContain('ratio bound');
    expect(verdictRows().filter((r) => r.verdict === 'void')).toHaveLength(4);
    expect(runRow().breached).toBe(1);
  });
});

describe('evaluateBreach', () => {
  it('trips on the absolute bound', () => {
    const rows = numberedVerdicts(ABSOLUTE_FLAGGED_BOUND + 2, (i) =>
      i <= ABSOLUTE_FLAGGED_BOUND ? 'void' : 'ok',
    );

    expect(evaluateBreach(rows, new Map())).toMatchObject({ breached: true });
    expect(evaluateBreach(rows, new Map()).reason).toContain('absolute bound');
  });

  /**
   * Raw growth would fire on any large import. Only images both runs judged, and
   * neither called `unknown`, count towards the ratio.
   */
  it('measures the ratio over the intersection, not raw growth', () => {
    const previous = verdicts(['a', 'void'], ['b', 'ok'], ['c', 'unknown']);
    const next = verdicts(
      ['a', 'void'],
      ['b', 'ok'],
      ['c', 'void'],
      ['d', 'void'],
      ['e', 'void'],
      ['f', 'void'],
    );

    expect(evaluateBreach(next, previous)).toEqual({ breached: false, reason: '' });
  });

  it('trips when the intersection itself gets three times more flagged', () => {
    const previous = numberedVerdicts(5, (i) => (i === 0 ? 'void' : 'ok'));
    const next = numberedVerdicts(5, (i) => (i < 4 ? 'void' : 'ok'));

    const { breached, reason } = evaluateBreach(next, previous);
    expect(breached).toBe(true);
    expect(reason).toBe('ratio bound: intersection flagged 4 > 3x previous 1');
  });

  it('skips the ratio guard on a first run', () => {
    const rows = numberedVerdicts(10, () => 'void');

    expect(evaluateBreach(rows, new Map())).toEqual({ breached: false, reason: '' });
  });
});

describe('the batch_frame_substance handler', () => {
  it('scans the vision cache and completes with the run summary', async () => {
    seedImage('void', await writeVoidJpeg('void.jpg'));
    seedImage('good', await writeOkJpeg('good.jpg'));

    const job = await runJob();

    expect(job.status).toBe('completed');
    expect(job.progress).toBe(100);
    expect(job.result).toMatchObject({ total: 2, count_void: 1, count_ok: 1 });
    expect(job.logs.map((l) => l.message)).toContain('Frame substance: checked 2/2 images');
  });

  it('completes with zeros when the catalog is empty', async () => {
    const job = await runJob();

    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({ run_id: null, total: 0 });
  });

  it('fails with a presentable message when the library DB is not configured', async () => {
    delete process.env.LIBRARY_DB;
    process.env.LT_CONFIG_YAML = join(dir, 'missing.yaml');

    const job = await runJob();

    expect(job.status).toBe('failed');
    expect(job.error_severity).toBe('warning');
    delete process.env.LT_CONFIG_YAML;
  });
});

describe('storedInstantMs', () => {
  it('reads an offset, Z, and no offset as local wall-clock', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const utc = Date.UTC(2026, 9, 20, 21, 14, 52, 219);
      expect(storedInstantMs('2026-10-20T21:14:52.219000+00:00')).toBe(utc);
      expect(storedInstantMs('2026-10-20T21:14:52.219Z')).toBe(utc);
      expect(storedInstantMs('2026-10-20T17:14:52.219000-04:00')).toBe(utc);
      expect(storedInstantMs('2026-10-20T17:14:52.219000')).toBe(utc);
      expect(storedInstantMs('2026-10-20 17:14:52')).toBe(utc - 219);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it('is NaN for anything else', () => {
    expect(storedInstantMs('')).toBeNaN();
    expect(storedInstantMs('yesterday')).toBeNaN();
  });
});
