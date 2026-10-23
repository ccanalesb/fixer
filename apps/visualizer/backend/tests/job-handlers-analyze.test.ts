import { prepareKimiJobCull, resetKimiJobLaya, writeKimiJobConfig } from './helpers/kimi-job-laya.js';
/**
 * The `batch_analyze` handler: describe and score as two stages of one job.
 *
 * Driven through `tick()` and a real `jobs` row like the other handler suites,
 * against a real provider server. The server answers by inspecting the request:
 * the scoring prompt embeds the perspective's rubric, so a sentinel in that
 * markdown is enough to tell the two stages apart, and neither reply schema
 * tolerates the other's fields — the score parser is `.strict()`.
 *
 * What is worth pinning here is everything the composite adds on top of two
 * passes that are already covered: the shared selection, the split progress
 * bands, the nested checkpoint, and the combined result.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { LibraryFixture } from './helpers/library-fixture.js';
import { createJob, getJob, initJobsDb } from '../src/db/jobs/jobs.js';
import type { Db } from '../src/db/connection.js';
import { JobRunner } from '../src/jobs/runner.js';
import { tick } from '../src/jobs/processor.js';
import { fingerprintBatchDescribe } from '../src/jobs/checkpoint.js';

/** Appears in the rubric, therefore in the scoring prompt and nowhere else. */
const RUBRIC = 'RUBRIC-SENTINEL';

let fx: LibraryFixture;
let dir: string;
let jobsDbPath: string;
let server: Server;
let port: number;

let describeReply: { status: number; body: unknown };
let scoreReply: { status: number; body: unknown };
let describeCalls = 0;
let scoreCalls = 0;

/** Fires as each scoring call arrives, so a test can cancel mid-stage. */
let onScoreRequest: (() => void) | null = null;

const completion = (content: string) => ({
  status: 200,
  body: { choices: [{ message: { content } }] },
});

const descriptionJson = (summary = 'A street scene') =>
  completion(JSON.stringify({ summary, subjects: ['bicycle'] }));

const scoreJson = (slug = 'street', score = 7) =>
  completion(JSON.stringify({ perspective_slug: slug, score, rationale: 'because' }));

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const scoring = raw.includes(RUBRIC);
        if (scoring) {
          scoreCalls += 1;
          onScoreRequest?.();
        } else {
          describeCalls += 1;
        }
        const reply = scoring ? scoreReply : describeReply;
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
}

function writeProviders(): void {
  writeFileSync(
    join(dir, 'providers.json'),
    JSON.stringify({
      retry_defaults: { max_retries: 1, backoff_seconds: [0] },
      fallback_order: ['local'],
      defaults: { description: { provider: 'local', model: 'vision-1' } },
      providers: {
        local: {
          name: 'Local',
          base_url: `http://127.0.0.1:${port}/v1`,
          api_key: 'test-key',
          tool_calling: false,
          auto_discover: false,
          models: [{ id: 'vision-1', name: 'Vision One', vision: true }],
        },
      },
    }),
  );
}

async function writePhoto(name = 'photo.jpg'): Promise<string> {
  const path = join(dir, name);
  await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .jpeg()
    .toFile(path);
  return path;
}

async function withJobsDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const db = initJobsDb(jobsDbPath);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/** Every `(progress, step)` the runner emitted, in order. */
let progressEvents: { progress: number; step: string }[] = [];

/** Enqueue, run one processor pass, and hand back the settled job. */
async function runAnalyze(metadata: Record<string, unknown> = {}) {
  return withJobsDb(async (db) => {
    const jobId = createJob(db, 'batch_analyze', metadata);
    const runner = new JobRunner(db, (_id, progress, step) =>
      progressEvents.push({ progress, step }),
    );
    await tick(db, runner);
    return getJob(db, jobId)!;
  });
}

/** Seed catalog rows all pointing at one real JPEG, so every one is analyzable. */
async function seedPhotos(...keys: string[]): Promise<void> {
  const filepath = await writePhoto();
  for (const key of keys) fx.addImage({ key, filepath });
}

/**
 * A catalog row whose photo the frame substance stage will condemn: flat black,
 * and large enough for the detector's 32x32 tile grid, which `writePhoto`'s 8x8
 * thumbnail is not.
 */
async function seedVoidPhoto(key: string): Promise<void> {
  const filepath = join(dir, `${key}-void.jpg`);
  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000' } })
    .jpeg()
    .toFile(filepath);
  fx.addImage({ key, filepath });
}

const addRubric = (slug = 'street'): void => {
  fx.addPerspectives({ slug, prompt_markdown: `# ${slug}\n${RUBRIC}` });
};

const logMessages = (job: { logs: { message: string }[] }): string[] =>
  job.logs.map((l) => l.message);

interface AnalyzeResult {
  describe_total: number;
  describe_succeeded: number;
  describe_failed: number;
  score_total: number;
  score_succeeded: number;
  score_failed: number;
  skip_reason_counts: Record<string, number>;
}

const analyzeResult = (job: { result: unknown }): AnalyzeResult => job.result as AnalyzeResult;

const describedKeys = (): string[] =>
  fx
    .query<{ image_key: string }>('SELECT image_key FROM image_descriptions ORDER BY image_key')
    .map((r) => r.image_key);

const scoredKeys = (): string[] =>
  fx
    .query<{ image_key: string }>(
      'SELECT image_key FROM image_scores WHERE is_current = 1 ORDER BY image_key',
    )
    .map((r) => r.image_key);

const emptySkipCounts = {
  no_row: 0,
  empty_path: 0,
  unresolved_or_missing: 0,
  encode_failed: 0,
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lt-analyze-job-'));
  jobsDbPath = join(dir, 'visualizer.db');
  fx = new LibraryFixture().addForecastQuestions().activate();
  resetKimiJobLaya();
  describeReply = descriptionJson();
  scoreReply = scoreJson();
  describeCalls = 0;
  scoreCalls = 0;
  onScoreRequest = null;
  progressEvents = [];
  process.env.DATABASE_PATH = jobsDbPath;
  await startServer();
  writeProviders();
  const modelsDir = prepareKimiJobCull(fx.dbPath, dir);
  writeKimiJobConfig(dir, modelsDir);
  process.env.LT_PROVIDERS_JSON = join(dir, 'providers.json');
  process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
});

afterEach(async () => {
  delete process.env.DATABASE_PATH;
  delete process.env.LT_PROVIDERS_JSON;
  delete process.env.LT_CONFIG_YAML;
  fx.cleanup();
  rmSync(dir, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
});

describe('the batch_analyze handler', () => {
  it('honors metadata.image_keys and only describes listed catalog keys', async () => {
    await seedPhotos('only-a', 'skip-b');
    addRubric();

    const job = await runAnalyze({
      image_keys: ['only-a'],
      image_type: 'catalog',
      max_workers: 1,
    });

    expect(job.status).toBe('completed');
    expect(analyzeResult(job).describe_total).toBe(1);
    expect(describedKeys()).toEqual(['only-a']);
  });

  it('describes then scores the same images and reports both sets of totals', async () => {
    await seedPhotos('a', 'b');
    addRubric();

    const job = await runAnalyze({ max_workers: 1 });

    expect(job.status).toBe('completed');
    expect(job.progress).toBe(100);
    expect(analyzeResult(job)).toMatchObject({
      describe_total: 2,
      describe_succeeded: 2,
      describe_failed: 0,
      score_total: 2,
      score_succeeded: 2,
      score_failed: 0,
      skip_reason_counts: emptySkipCounts,
    });
    expect(describedKeys()).toEqual(['a', 'b']);
    expect(scoredKeys()).toEqual(['a', 'b']);
  });

  /**
   * The reason the composite exists. Two back-to-back batch jobs would select
   * twice, and by the second selection every image is described — so a scoring
   * run that inherits describe's undescribed-only window would find nothing.
   */
  it('scores the images it just described, which a separate run could not', async () => {
    await seedPhotos('a');
    addRubric();

    const job = await runAnalyze({ max_workers: 1 });

    expect(analyzeResult(job).score_total).toBe(1);
    expect(scoredKeys()).toEqual(['a']);
  });

  it('labels each stage in the log so a single stream stays readable', async () => {
    await seedPhotos('a');
    addRubric();

    const messages = logMessages(await runAnalyze({ max_workers: 1 }));

    expect(messages).toContain('[describe] Describing 1/1: a');
    expect(messages).toContain('[score] Scoring 1/1: a|street');
  });

  /** Cull 2–30, describe 31–65, score 65–100 — each stage stays in its band. */
  it('keeps each stage inside its own half of the progress bar', async () => {
    await seedPhotos('a');
    addRubric();

    await runAnalyze({ max_workers: 1 });

    const describeProgress = progressEvents
      .filter((e) => e.step.startsWith('[describe] '))
      .map((e) => e.progress);
    const scoreProgress = progressEvents
      .filter((e) => e.step.startsWith('[score] '))
      .map((e) => e.progress);

    expect(describeProgress.length).toBeGreaterThan(0);
    expect(scoreProgress.length).toBeGreaterThan(0);
    expect(Math.max(...describeProgress)).toBeLessThanOrEqual(65);
    expect(Math.min(...scoreProgress)).toBeGreaterThanOrEqual(65);
  });

  /** Void frames are not described or scored (#339); only non-void work reaches kimi. */
  it('describes a condemned frame but leaves it out of the scoring selection', async () => {
    await seedPhotos('good');
    await seedVoidPhoto('void');
    fx.addFrameSubstance('void', 'void');
    addRubric();

    const job = await runAnalyze({ max_workers: 1 });

    expect(analyzeResult(job)).toMatchObject({ describe_total: 1, score_total: 1 });
    expect(describedKeys()).toEqual(['good']);
    expect(scoredKeys()).toEqual(['good']);
  });

  it('scores a condemned frame the user reinstated', async () => {
    await seedVoidPhoto('void');
    addRubric();
    fx.addFrameSubstanceOverride('void');

    expect(analyzeResult(await runAnalyze({ max_workers: 1 })).score_total).toBe(1);
  });

  /** Frame substance runs in the cull step before describe; void is held back from kimi. */
  it('judges the frames between the two passes', async () => {
    await seedVoidPhoto('void');
    fx.addFrameSubstance('void', 'void');
    addRubric();

    const job = await runAnalyze({ max_workers: 1 });

    expect(analyzeResult(job).score_total).toBe(0);
    expect(describeCalls).toBe(0);
    expect(scoreCalls).toBe(0);
  });

  it('keeps the frame substance stage inside the gap between the two halves', async () => {
    await seedVoidPhoto('void');
    addRubric();

    await runAnalyze({ max_workers: 1 });

    const band = progressEvents
      .filter((e) => e.step.includes('Frame substance'))
      .map((e) => e.progress);
    expect(band.length).toBeGreaterThan(0);
    expect(Math.max(...band)).toBeLessThanOrEqual(31);
  });

  /**
   * The detector is an optimization for the stage after it. A job that has already
   * paid for the descriptions should go on and score rather than throw them away,
   * so this stage alone logs its failure and continues.
   */
  it('scores anyway when the frame substance stage fails', async () => {
    await seedPhotos('a');
    addRubric();
    fx.exec('DROP TABLE frame_substance_runs');

    const job = await runAnalyze({ max_workers: 1 });

    expect(job.status).toBe('completed');
    expect(analyzeResult(job).score_succeeded).toBe(1);
    expect(logMessages(job).some((m) => m.includes('[frame_substance] status=failed'))).toBe(true);
  });

  /**
   * `force_describe` and `force_score` are separate knobs, and the first also
   * widens the shared selection — without it an already-described image is out of
   * scope for *both* stages, which is the price of selecting once.
   */
  it('reads the two force flags separately', async () => {
    await seedPhotos('a');
    addRubric();
    await runAnalyze({ max_workers: 1 });
    describeCalls = 0;
    scoreCalls = 0;

    const untouched = await runAnalyze({ max_workers: 1 });
    expect(analyzeResult(untouched)).toMatchObject({ describe_total: 0, score_total: 0 });
    expect(describeCalls + scoreCalls).toBe(0);

    const forced = await runAnalyze({ max_workers: 1, force_describe: true });
    expect(analyzeResult(forced)).toMatchObject({
      describe_total: 1,
      describe_succeeded: 1,
      score_total: 1,
    });
    // The score pre-filter still holds: the rubric has not changed.
    expect(analyzeResult(forced).score_succeeded).toBe(0);

    const rescored = await runAnalyze({
      max_workers: 1,
      force_describe: true,
      force_score: true,
    });
    expect(analyzeResult(rescored).score_succeeded).toBe(1);
  });

  it('completes with zero totals when nothing is in scope', async () => {
    const job = await runAnalyze();

    expect(job.status).toBe('completed');
    expect(analyzeResult(job)).toMatchObject({ describe_total: 0, score_total: 0 });
  });

  it('describes even when no perspective is active, and scores nothing', async () => {
    await seedPhotos('a');

    const job = await runAnalyze({ max_workers: 1 });

    expect(analyzeResult(job)).toMatchObject({ describe_total: 1, score_total: 0 });
    expect(describedKeys()).toEqual(['a']);
  });

  it('refuses an image_type other than catalog', async () => {
    const job = await runAnalyze({ image_type: 'instagram' });

    expect(job.status).toBe('failed');
    expect(job.error).toBe('image_type must be catalog');
  });

  /** A stage that fails some units still hands its counts to the composite. */
  it('carries the failures of a stage into the combined result', async () => {
    await seedPhotos('a');
    addRubric();
    scoreReply = { status: 500, body: { error: 'boom' } };

    const job = await runAnalyze({ max_workers: 1 });

    expect(job.status).toBe('completed');
    expect(analyzeResult(job)).toMatchObject({
      describe_succeeded: 1,
      score_total: 1,
      score_succeeded: 0,
      score_failed: 1,
    });
  });
});

describe('batch_analyze checkpoints', () => {
  it('clears the checkpoint once both stages finish', async () => {
    await seedPhotos('a');
    addRubric();

    expect((await runAnalyze({ max_workers: 1 })).metadata.checkpoint).toBeNull();
  });

  /**
   * One checkpoint holding two resume sets, because the stages are separately
   * resumable: a run interrupted while scoring must not re-describe.
   */
  it('nests both stages under one checkpoint, naming the stage in flight', async () => {
    await seedPhotos('a', 'b');
    addRubric();

    // Cancel as the first scoring call lands, leaving describe complete.
    let checkpoint: Record<string, unknown> | undefined;
    await withJobsDb(async (db) => {
      const jobId = createJob(db, 'batch_analyze', { max_workers: 1 });
      const runner = new JobRunner(db);
      onScoreRequest = () => runner.signalCancel(jobId);
      await tick(db, runner);
      checkpoint = getJob(db, jobId)!.metadata.checkpoint as Record<string, unknown>;
    });

    expect(checkpoint).toMatchObject({
      checkpoint_version: 1,
      job_type: 'batch_analyze',
      stage: 'score',
    });
    const describe = checkpoint!['describe'] as Record<string, unknown>;
    expect(describe['processed_pairs']).toEqual(['a|catalog', 'b|catalog']);
    expect(describe['total_at_start']).toBe(2);
  });

  /**
   * Re-entering a finished describe stage would be nearly free but not free: it
   * would re-run the preflight and the pre-filter over the whole selection only
   * to find no work. The fingerprint is what makes skipping it safe.
   */
  it('skips the describe stage when the checkpoint says it already ran', async () => {
    await seedPhotos('a');
    addRubric();

    const metadata = { max_workers: 1, force_describe: true };
    const fingerprint = await fingerprintBatchDescribe(
      { ...metadata, force: true },
      [['a', 'catalog']],
    );
    const job = await runAnalyze({
      ...metadata,
      checkpoint: {
        checkpoint_version: 1,
        job_type: 'batch_analyze',
        stage: 'score',
        describe: { fingerprint, processed_pairs: ['a|catalog'], total_at_start: 1 },
        score: {},
      },
    });

    expect(describeCalls).toBe(0);
    expect(analyzeResult(job)).toMatchObject({
      describe_total: 1,
      describe_succeeded: 0,
      score_total: 1,
      score_succeeded: 1,
    });
  });

  /** A moved selection is a different describe run, so the skip does not apply. */
  it('re-runs describe when the checkpointed fingerprint no longer matches', async () => {
    await seedPhotos('a');
    addRubric();

    const job = await runAnalyze({
      max_workers: 1,
      checkpoint: {
        checkpoint_version: 1,
        job_type: 'batch_analyze',
        stage: 'score',
        describe: { fingerprint: 'stale', processed_pairs: ['a|catalog'], total_at_start: 1 },
        score: {},
      },
    });

    expect(describeCalls).toBe(1);
    expect(analyzeResult(job).describe_succeeded).toBe(1);
    expect(logMessages(job)).toContain(
      '[describe] checkpoint mismatch: batch_analyze describe fingerprint changed, ' +
        'starting describe fresh',
    );
  });

  /** A `batch_describe` checkpoint is not a `batch_analyze` one; ignore it. */
  it('ignores a flat checkpoint left by a different job type', async () => {
    await seedPhotos('a');
    addRubric();

    const job = await runAnalyze({
      max_workers: 1,
      checkpoint: {
        checkpoint_version: 1,
        job_type: 'batch_describe',
        fingerprint: 'whatever',
        processed_pairs: ['a|catalog'],
        total_at_start: 1,
      },
    });

    expect(describeCalls).toBe(1);
    expect(analyzeResult(job).describe_succeeded).toBe(1);
  });
});
