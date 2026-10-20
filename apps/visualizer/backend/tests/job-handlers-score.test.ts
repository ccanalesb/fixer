import { prepareKimiJobCull, resetKimiJobLaya, writeKimiJobConfig } from './helpers/kimi-job-laya.js';
/**
 * The `single_score` job handler and the scoring service behind it.
 *
 * Driven through `tick()` and a real `jobs` row, like the describe suite, so the
 * registry entry, the runner's lifecycle writes and the handler's own outcome
 * calls are all exercised together.
 *
 * The provider is a real HTTP server serving a queue of replies, because the
 * repair path needs a *second* call to answer differently from the first — that
 * is the whole mechanism `repaired_from_malformed` records, and mocking the
 * client would test the mock.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { LibraryFixture } from './helpers/library-fixture.js';
import { createJob, getJob, initJobsDb } from '../src/db/jobs/jobs.js';
import type { Db } from '../src/db/connection.js';
import { JobRunner } from '../src/jobs/runner.js';
import { tick } from '../src/jobs/processor.js';
import { computePromptVersion } from '../src/vision/scoring-service.js';
import { fingerprintBatchScore } from '../src/jobs/checkpoint.js';
import { openLibraryDb } from '../src/db/connection.js';
import { recordCullUserAction } from '../src/db/library/cull-user-actions.js';

let fx: LibraryFixture;
let dir: string;
let jobsDbPath: string;
let server: Server;
let port: number;

/** Replies are consumed in order; the last one repeats once the queue drains. */
let replies: { status: number; body: unknown }[] = [];
let requestBodies: string[] = [];

/** Fires as each provider call arrives, so a test can cancel mid-run. */
let onRequest: (() => void) | null = null;

const completion = (content: string) => ({
  status: 200,
  body: { choices: [{ message: { content } }] },
});

const scoreJson = (
  slug: string,
  score: number,
  extra: Record<string, unknown> = {},
): string => JSON.stringify({ perspective_slug: slug, score, rationale: 'because', ...extra });

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        requestBodies.push(raw);
        onRequest?.();
        const reply = replies.length > 1 ? replies.shift()! : (replies[0] ?? completion('{}'));
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

/** Enqueue, run one processor pass, and hand back the settled job. */
async function runJobOfType(type: string, metadata: Record<string, unknown>) {
  return withJobsDb(async (db) => {
    const jobId = createJob(db, type, metadata);
    await tick(db, new JobRunner(db));
    return getJob(db, jobId)!;
  });
}

const runJob = (metadata: Record<string, unknown>) => runJobOfType('single_score', metadata);
const runBatch = (metadata: Record<string, unknown> = {}) => runJobOfType('batch_score', metadata);

/** Seed catalog rows all pointing at one real JPEG, so every one is scorable. */
async function seedPhotos(...keys: string[]): Promise<void> {
  const filepath = await writePhoto();
  for (const key of keys) fx.addImage({ key, filepath });
}

const logMessages = (job: { logs: { message: string }[] }): string[] =>
  job.logs.map((l) => l.message);

interface StoredScore {
  perspective_slug: string;
  score: number;
  rationale: string | null;
  model_used: string | null;
  prompt_version: string;
  scored_at: string;
  is_current: number;
  repaired_from_malformed: number;
  not_attempted: number;
}

const storedScores = (key: string): StoredScore[] =>
  fx.query<StoredScore>(
    'SELECT * FROM image_scores WHERE image_key = ? ORDER BY id ASC',
    key,
  );

const emptySkipCounts = {
  no_row: 0,
  empty_path: 0,
  unresolved_or_missing: 0,
  encode_failed: 0,
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lt-score-job-'));
  jobsDbPath = join(dir, 'visualizer.db');
  fx = new LibraryFixture().activate();
  resetKimiJobLaya();
  replies = [completion(scoreJson('street', 7))];
  requestBodies = [];
  onRequest = null;
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

describe('computePromptVersion', () => {
  /** prompt_version is pinned to slug:sha256-prefix so rubric edits invalidate scores. */
  it('is the slug and the first 16 hex of the markdown sha256', () => {
    const markdown = '# Street\nIs the moment decisive?';
    const expected = createHash('sha256').update(markdown, 'utf8').digest('hex').slice(0, 16);
    expect(computePromptVersion({ slug: 'street', prompt_markdown: markdown })).toBe(
      `street:${expected}`,
    );
  });

  it('treats absent markdown as empty rather than throwing', () => {
    expect(computePromptVersion({ slug: 'street', prompt_markdown: '' })).toBe(
      'street:' + createHash('sha256').update('', 'utf8').digest('hex').slice(0, 16),
    );
  });
});

/** A cull summary row, as the cull job would leave it. */
function cullVerdict(key: string, verdict: 'cut' | 'sent' | 'pending'): void {
  fx.exec(
    `INSERT INTO cull_verdicts (image_key, verdict, cut_by, pipeline_setting_version, decided_at)
     VALUES (?, ?, ?, 1, '2026-10-19T00:00:00+00:00')`,
    key,
    verdict,
    verdict === 'cut' ? 'culling_recipe' : null,
  );
}

describe('the last check: a photo the cull cut is not scored', () => {
  it('skips a cut photo without calling the provider', async () => {
    const filepath = await writePhoto();
    fx.addImage({ key: 'a', filepath }).addPerspectives({ slug: 'street' });
    cullVerdict('a', 'cut');

    const job = await runJob({ image_key: 'a' });

    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({ scored: 0, skipped: 1 });
    expect(requestBodies).toEqual([]);
    expect(storedScores('a')).toEqual([]);
  });

  it('scores a cut photo the user sent by hand', async () => {
    const filepath = await writePhoto();
    fx.addImage({ key: 'a', filepath }).addPerspectives({ slug: 'street' });
    cullVerdict('a', 'cut');
    const db = openLibraryDb(fx.dbPath);
    recordCullUserAction(db, 'a', 'sent_by_hand');
    db.close();

    const job = await runJob({ image_key: 'a' });

    expect(job.result).toMatchObject({ scored: 1 });
  });

  it('refuses only a cut: a pending or never-culled photo is scored', async () => {
    const filepath = await writePhoto();
    fx.addImage({ key: 'p', filepath }).addImage({ key: 'n', filepath }).addPerspectives({ slug: 'street' });
    cullVerdict('p', 'pending');

    expect((await runJob({ image_key: 'p' })).result).toMatchObject({ scored: 1 });
    expect((await runJob({ image_key: 'n' })).result).toMatchObject({ scored: 1 });
  });
});

describe('the single_score handler', () => {
  it('scores the image and completes the job', async () => {
    const filepath = await writePhoto();
    fx.addImage({ key: 'a', filepath }).addPerspectives({ slug: 'street' });

    const job = await runJob({ image_key: 'a' });

    expect(job.status).toBe('completed');
    expect(job.progress).toBe(100);
    expect(job.result).toEqual({
      image_key: 'a',
      image_type: 'catalog',
      scored: 1,
      skipped: 0,
      failed: 0,
      skip_reason_counts: emptySkipCounts,
    });

    const rows = storedScores('a');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      perspective_slug: 'street',
      score: 7,
      rationale: 'because',
      model_used: 'local:vision-1',
      is_current: 1,
      repaired_from_malformed: 0,
      not_attempted: 0,
    });
  });

  /** scored_at uses whole-second UTC; text sort breaks if milliseconds appear. */
  it('writes scored_at in second-precision UTC', async () => {
    const filepath = await writePhoto();
    fx.addImage({ key: 'a', filepath }).addPerspectives({ slug: 'street' });

    await runJob({ image_key: 'a' });

    expect(storedScores('a')[0]!.scored_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
  });

  it('sends the perspective rubric as the user prompt', async () => {
    const filepath = await writePhoto();
    fx.addImage({ key: 'a', filepath }).addPerspectives({
      slug: 'street',
      display_name: 'Street',
      prompt_markdown: '# Street\nIs the moment decisive?',
    });

    await runJob({ image_key: 'a' });

    expect(requestBodies[0]).toContain('Is the moment decisive?');
    expect(requestBodies[0]).toContain('perspective_slug');
  });

  it('scores every active perspective when none are named', async () => {
    const filepath = await writePhoto();
    fx.addImage({ key: 'a', filepath }).addPerspectives(
      { slug: 'street' },
      { slug: 'light' },
      { slug: 'retired', active: false },
    );
    replies = [completion(scoreJson('street', 7))];

    const job = await runJob({ image_key: 'a' });

    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({ scored: 2, skipped: 0 });
    // Ordered by slug, because that is the order `listPerspectives` returns.
    expect(storedScores('a').map((r) => r.perspective_slug)).toEqual(['light', 'street']);
  });

  it('fails without touching the catalog when image_key is missing', async () => {
    const job = await runJob({});

    expect(job.status).toBe('failed');
    expect(job.error).toBe('image_key is required in metadata');
  });

  it('refuses a non-catalog image_type', async () => {
    const job = await runJob({ image_key: 'a', image_type: 'dump' });

    expect(job.status).toBe('failed');
    expect(job.error).toBe('image_type must be catalog');
  });

  /**
   * Not a silent success: "scored 0 perspectives, completed" is indistinguishable
   * in the UI from a scored image, so an empty rubric set has to be an error.
   */
  it('fails when there is nothing to score against', async () => {
    const filepath = await writePhoto();
    fx.addImage({ key: 'a', filepath });

    const job = await runJob({ image_key: 'a' });

    expect(job.status).toBe('failed');
    expect(job.error).toContain('No perspectives to score');
  });

  it('fails on an unknown perspective slug', async () => {
    const filepath = await writePhoto();
    fx.addImage({ key: 'a', filepath }).addPerspectives({ slug: 'street' });

    const job = await runJob({ image_key: 'a', perspective_slugs: ['nope'] });

    expect(job.status).toBe('failed');
    expect(job.error).toBe("Unknown perspective slug: 'nope'");
  });

  it('fails on an explicitly named inactive perspective', async () => {
    const filepath = await writePhoto();
    fx.addImage({ key: 'a', filepath }).addPerspectives({ slug: 'retired', active: false });

    const job = await runJob({ image_key: 'a', perspective_slugs: ['retired'] });

    expect(job.status).toBe('failed');
    expect(job.error).toBe("Perspective 'retired' is not active");
  });

  /** The first hard failure stops the run; a half-scored image is worse than none. */
  it('stops at the first failing perspective', async () => {
    const filepath = await writePhoto();
    fx.addImage({ key: 'a', filepath }).addPerspectives({ slug: 'street' }, { slug: 'light' });

    const job = await runJob({ image_key: 'a', perspective_slugs: ['nope', 'street'] });

    expect(job.status).toBe('failed');
    expect(storedScores('a')).toHaveLength(0);
  });

  it('skips an image whose key is not in the catalog', async () => {
    fx.addPerspectives({ slug: 'street' });

    const job = await runJob({ image_key: 'missing' });

    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({ scored: 0, skipped: 1 });
  });

  it('skips a video file without calling the provider', async () => {
    fx.addImage({ key: 'a', filepath: join(dir, 'clip.mov') }).addPerspectives({ slug: 'street' });

    const job = await runJob({ image_key: 'a' });

    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({ scored: 0, skipped: 1 });
    expect(requestBodies).toHaveLength(0);
  });
});

describe('re-scoring', () => {
  it('skips an image already scored under the same rubric version', async () => {
    const filepath = await writePhoto();
    fx.addImage({ key: 'a', filepath }).addPerspectives({ slug: 'street' });
    expect((await runJob({ image_key: 'a' })).status).toBe('completed');
    requestBodies = [];

    const job = await runJob({ image_key: 'a' });

    expect(job.result).toMatchObject({ scored: 0, skipped: 1 });
    expect(requestBodies).toHaveLength(0);
    expect(storedScores('a')).toHaveLength(1);
  });

  /**
   * Force replaces the row for *this* rubric version rather than stacking a
   * second current one beside it, which the `is_current` filter could not choose
   * between.
   */
  it('replaces the existing row when forced', async () => {
    const filepath = await writePhoto();
    fx.addImage({ key: 'a', filepath }).addPerspectives({ slug: 'street' });
    await runJob({ image_key: 'a' });
    replies = [completion(scoreJson('street', 3))];

    const job = await runJob({ image_key: 'a', force: true });

    expect(job.result).toMatchObject({ scored: 1, skipped: 0 });
    const rows = storedScores('a');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ score: 3, is_current: 1 });
  });

  /**
   * Editing the rubric makes the old score stale without deleting it: the history
   * view still shows what the previous wording produced, but only the new row is
   * current.
   */
  it('supersedes a score written under an older rubric', async () => {
    const filepath = await writePhoto();
    fx.addImage({ key: 'a', filepath }).addPerspectives({
      slug: 'street',
      prompt_markdown: '# v1',
    });
    await runJob({ image_key: 'a' });

    fx.exec("UPDATE perspectives SET prompt_markdown = '# v2' WHERE slug = 'street'");
    replies = [completion(scoreJson('street', 9))];
    const job = await runJob({ image_key: 'a' });

    expect(job.result).toMatchObject({ scored: 1 });
    const rows = storedScores('a');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ score: 7, is_current: 0 });
    expect(rows[1]).toMatchObject({ score: 9, is_current: 1 });
    expect(rows[0]!.prompt_version).not.toBe(rows[1]!.prompt_version);
  });
});

describe('frame substance', () => {
  it('skips a frame the detector called void', async () => {
    const filepath = await writePhoto();
    fx.addImage({ key: 'a', filepath })
      .addPerspectives({ slug: 'street' })
      .addFrameSubstance('a', 'void');

    const job = await runJob({ image_key: 'a' });

    expect(job.result).toMatchObject({ scored: 0, skipped: 1 });
    expect(requestBodies).toHaveLength(0);
  });

  it('scores a void frame the user reinstated', async () => {
    const filepath = await writePhoto();
    fx.addImage({ key: 'a', filepath })
      .addPerspectives({ slug: 'street' })
      .addFrameSubstance('a', 'void')
      .addFrameSubstanceOverride('a');

    const job = await runJob({ image_key: 'a' });

    expect(job.result).toMatchObject({ scored: 1, skipped: 0 });
  });

  it('scores a frame with any other verdict', async () => {
    const filepath = await writePhoto();
    fx.addImage({ key: 'a', filepath })
      .addPerspectives({ slug: 'street' })
      .addFrameSubstance('a', 'illegible');

    expect((await runJob({ image_key: 'a' })).result).toMatchObject({ scored: 1 });
  });
});

describe('malformed model output', () => {
  it('repairs invalid JSON through a second call and records that it did', async () => {
    const filepath = await writePhoto();
    fx.addImage({ key: 'a', filepath }).addPerspectives({ slug: 'street' });
    replies = [completion('here you go: {{{ not json'), completion(scoreJson('street', 4))];

    const job = await runJob({ image_key: 'a' });

    expect(job.status).toBe('completed');
    expect(storedScores('a')[0]).toMatchObject({ score: 4, repaired_from_malformed: 1 });
    // The repair prompt goes to the same provider and model that failed.
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1]).toContain('JSON repair tool');
  });

  it('fails the job when the repair is also invalid', async () => {
    const filepath = await writePhoto();
    fx.addImage({ key: 'a', filepath }).addPerspectives({ slug: 'street' });
    replies = [completion('{{{ not json')];

    const job = await runJob({ image_key: 'a' });

    expect(job.status).toBe('failed');
    expect(job.error).toContain('Score response validation failed');
    expect(storedScores('a')).toHaveLength(0);
  });

  it('rejects a score outside 1–10 rather than clamping it', async () => {
    const filepath = await writePhoto();
    fx.addImage({ key: 'a', filepath }).addPerspectives({ slug: 'street' });
    replies = [completion(scoreJson('street', 42))];

    const job = await runJob({ image_key: 'a' });

    expect(job.status).toBe('failed');
    expect(storedScores('a')).toHaveLength(0);
  });

  /**
   * Only one perspective was requested and the score is always stored under it,
   * so an echoed slug that does not match is a logged discrepancy, not a reason
   * to throw away a provider call that produced a usable judgment.
   */
  it('persists under the requested slug when the model echoes a different one', async () => {
    const filepath = await writePhoto();
    fx.addImage({ key: 'a', filepath }).addPerspectives({
      slug: 'street',
      display_name: 'Street Photography (documentary)',
    });
    replies = [completion(scoreJson('Street Photography (documentary)', 6))];

    const job = await runJob({ image_key: 'a' });

    expect(job.status).toBe('completed');
    expect(storedScores('a')[0]).toMatchObject({ perspective_slug: 'street', score: 6 });
    expect(logMessages(job).some((m) => m.includes('Slug mismatch'))).toBe(true);
  });

  it('stores not_attempted when the model excuses an optional perspective', async () => {
    const filepath = await writePhoto();
    fx.addImage({ key: 'a', filepath }).addPerspectives({ slug: 'street', optional: true });
    replies = [completion(scoreJson('street', 2, { not_attempted: true }))];

    await runJob({ image_key: 'a' });

    expect(storedScores('a')[0]).toMatchObject({ not_attempted: 1, score: 2 });
  });
});

interface BatchResult {
  scored: number;
  skipped: number;
  failed: number;
  total: number;
  image_type: string;
  date_filter: string;
  force: boolean;
}

const batchResult = (job: { result: unknown }) => job.result as unknown as BatchResult;

/** Every current score in the catalog, as `key|slug`. */
const currentScores = (): string[] =>
  fx
    .query<{ image_key: string; perspective_slug: string }>(
      'SELECT image_key, perspective_slug FROM image_scores WHERE is_current = 1 ' +
        'ORDER BY image_key, perspective_slug',
    )
    .map((r) => `${r.image_key}|${r.perspective_slug}`);

describe('the batch_score handler', () => {
  it('scores every image against every active perspective', async () => {
    await seedPhotos('a', 'b');
    fx.addPerspectives({ slug: 'light' }, { slug: 'street' }, { slug: 'retired', active: false });

    const job = await runBatch();

    expect(job.status).toBe('completed');
    expect(batchResult(job)).toMatchObject({ scored: 4, skipped: 0, failed: 0, total: 4 });
    expect(currentScores()).toEqual(['a|light', 'a|street', 'b|light', 'b|street']);
  });

  it('scores only the perspectives named in the metadata', async () => {
    await seedPhotos('a');
    fx.addPerspectives({ slug: 'light' }, { slug: 'street' });

    const job = await runBatch({ perspective_slugs: ['street'] });

    expect(batchResult(job).total).toBe(1);
    expect(currentScores()).toEqual(['a|street']);
  });

  /**
   * The pre-filter is one SQL query standing in for a provider round-trip per
   * triple. On a catalog that is already scored it is the difference between a
   * no-op and tens of thousands of paid calls.
   */
  it('excludes already-scored triples in SQL rather than one at a time', async () => {
    await seedPhotos('a', 'b');
    fx.addPerspectives({ slug: 'street' });
    expect((await runBatch()).status).toBe('completed');
    requestBodies = [];

    const job = await runBatch();

    expect(batchResult(job)).toMatchObject({ scored: 0, total: 0 });
    expect(requestBodies).toHaveLength(0);
  });

  /** A score made from a cache image that was since turned upright is not done. */
  it('re-scores a stale triple without force, and clears the mark', async () => {
    await seedPhotos('a', 'b');
    fx.addPerspectives({ slug: 'street' });
    expect((await runBatch()).status).toBe('completed');
    fx.exec("INSERT INTO vision_stale (image_key, output) VALUES ('a', 'score:street')");
    requestBodies = [];
    replies = [completion(scoreJson('street', 9))];

    const job = await runBatch();

    expect(batchResult(job)).toMatchObject({ scored: 1, total: 1 });
    expect(requestBodies).toHaveLength(1);
    expect(currentScores()).toEqual(['a|street', 'b|street']);
    expect(fx.query('SELECT * FROM vision_stale')).toEqual([]);
  });

  /** An edited rubric is a different question, so the answers stop counting. */
  it('re-scores when the perspective markdown changed', async () => {
    await seedPhotos('a');
    fx.addPerspectives({ slug: 'street', prompt_markdown: '# v1' });
    await runBatch();

    fx.exec("UPDATE perspectives SET prompt_markdown = '# v2' WHERE slug = 'street'");
    replies = [completion(scoreJson('street', 9))];
    const job = await runBatch();

    expect(batchResult(job).scored).toBe(1);
    expect(storedScores('a').map((r) => r.is_current)).toEqual([0, 1]);
  });

  it('re-scores everything when force is set', async () => {
    await seedPhotos('a');
    fx.addPerspectives({ slug: 'street' });
    await runBatch();
    replies = [completion(scoreJson('street', 3))];

    const job = await runBatch({ force: true });

    expect(batchResult(job).scored).toBe(1);
    expect(storedScores('a')).toHaveLength(1);
    expect(storedScores('a')[0]).toMatchObject({ score: 3, is_current: 1 });
  });

  /**
   * A void frame is a lens cap: scoring it would put a number on an empty frame
   * and let it compete in the ranking. The gate is in the selection SQL, so such a
   * frame is not even counted as a skip.
   */
  it('leaves condemned frames out of the selection entirely', async () => {
    await seedPhotos('good', 'void');
    fx.addPerspectives({ slug: 'street' }).addFrameSubstance('void', 'void');

    const job = await runBatch();

    expect(batchResult(job).total).toBe(1);
    expect(currentScores()).toEqual(['good|street']);
  });

  it('scores a void frame the user reinstated', async () => {
    await seedPhotos('void');
    fx.addPerspectives({ slug: 'street' })
      .addFrameSubstance('void', 'void')
      .addFrameSubstanceOverride('void');

    expect(batchResult(await runBatch()).total).toBe(1);
  });

  /** Only `void`; an illegible frame still has a subject worth judging. */
  it('still scores an illegible frame', async () => {
    await seedPhotos('blurry');
    fx.addPerspectives({ slug: 'street' }).addFrameSubstance('blurry', 'illegible');

    expect(batchResult(await runBatch()).total).toBe(1);
  });

  it('honours the rating window when selecting work', async () => {
    const filepath = await writePhoto();
    fx.addImage({ key: 'low', filepath, rating: 1 });
    fx.addImage({ key: 'high', filepath, rating: 4 });
    fx.addPerspectives({ slug: 'street' });

    const job = await runBatch({ min_rating: 3 });

    expect(batchResult(job).total).toBe(1);
    expect(currentScores()).toEqual(['high|street']);
  });

  it('completes immediately when there is nothing to score', async () => {
    const job = await runBatch();

    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({
      scored: 0,
      skipped: 0,
      failed: 0,
      total: 0,
      skip_reason_counts: emptySkipCounts,
    });
  });

  /** No perspectives means no work units, not a failure — unlike `single_score`. */
  it('completes with nothing to do when no perspective is active', async () => {
    await seedPhotos('a');

    expect(batchResult(await runBatch()).total).toBe(0);
  });

  it('refuses an image_type other than catalog', async () => {
    const job = await runBatch({ image_type: 'instagram' });

    expect(job.status).toBe('failed');
    expect(job.error).toBe('image_type must be catalog');
  });

  it('counts a failing triple and carries on with the rest', async () => {
    await seedPhotos('a');
    fx.addPerspectives({ slug: 'light' }, { slug: 'street' });
    replies = [{ status: 500, body: { error: 'boom' } }, completion(scoreJson('street', 7))];

    const job = await runBatch({ max_workers: 1 });

    expect(job.status).toBe('completed');
    expect(batchResult(job)).toMatchObject({ scored: 1, failed: 1 });
  });
});

describe('batch_score checkpoints', () => {
  it('clears the checkpoint once the run completes', async () => {
    await seedPhotos('a');
    fx.addPerspectives({ slug: 'street' });

    expect((await runBatch()).metadata.checkpoint).toBeNull();
  });

  /**
   * The whole point of the checkpoint: a resumed run must not pay for work a
   * previous run already paid for.
   */
  it('resumes from a checkpoint and skips the triples already processed', async () => {
    await seedPhotos('a', 'b');
    fx.addPerspectives({ slug: 'street' });

    // Selection order is key DESC when no image carries a date.
    const metadata = { force: true };
    const fingerprint = await fingerprintBatchScore(metadata, [
      ['b', 'catalog', 'street'],
      ['a', 'catalog', 'street'],
    ]);
    const job = await runBatch({
      ...metadata,
      checkpoint: {
        checkpoint_version: 1,
        job_type: 'batch_score',
        fingerprint,
        processed_triplets: ['b|catalog|street'],
        total_at_start: 2,
      },
    });

    expect(batchResult(job).scored).toBe(1);
    expect(currentScores()).toEqual(['a|street']);
  });

  it('discards a checkpoint built from different inputs, and says so', async () => {
    await seedPhotos('a', 'b');
    fx.addPerspectives({ slug: 'street' });

    const job = await runBatch({
      force: true,
      checkpoint: {
        checkpoint_version: 1,
        job_type: 'batch_score',
        fingerprint: 'stale',
        processed_triplets: ['b|catalog|street'],
        total_at_start: 2,
      },
    });

    expect(batchResult(job).scored).toBe(2);
    expect(logMessages(job)).toContain(
      'checkpoint mismatch: batch_score fingerprint changed, starting fresh',
    );
  });

  /**
   * Cancel is cooperative: the work already in flight finishes, the rest is
   * abandoned, and the checkpoint keeps what was paid for.
   */
  it('stops at the next triple when a cancel arrives mid-run', async () => {
    await seedPhotos('a', 'b', 'c');
    fx.addPerspectives({ slug: 'street' });

    await withJobsDb(async (db) => {
      const jobId = createJob(db, 'batch_score', { max_workers: 1 });
      const runner = new JobRunner(db);
      onRequest = () => runner.signalCancel(jobId);

      await tick(db, runner);

      const job = getJob(db, jobId)!;
      expect(job.status).toBe('cancelled');
      expect(logMessages(job)).toContain(
        'Batch score cancel noted; finishing already-running tasks',
      );
      // Selection is key DESC, so the one triple that ran was the last key.
      expect(currentScores()).toEqual(['c|street']);
    });
  });

  /**
   * A dead provider must not burn through the whole catalog before anyone
   * notices, so the run aborts once ten scores fail back to back.
   */
  it('aborts after ten consecutive failures with nothing scored', async () => {
    await seedPhotos(...Array.from({ length: 15 }, (_, i) => `k${String(i).padStart(2, '0')}`));
    fx.addPerspectives({ slug: 'street' });
    replies = [{ status: 500, body: { error: 'upstream exploded' } }];

    const job = await runBatch({ max_workers: 1 });

    expect(job.status).toBe('failed');
    expect(job.error).toBe(
      'Aborted after 10 consecutive failures with 0 successful scores — ' +
        'check file paths and provider connectivity',
    );
    expect(currentScores()).toEqual([]);
  });
});

/**
 * The model-scoped re-do exists to migrate a catalog onto a better model without
 * paying twice for the images that model already judged.
 */
describe('batch_score with redo_unless_model', () => {
  it('skips the triples the target model already scored', async () => {
    await seedPhotos('a', 'b');
    fx.addPerspectives({ slug: 'street' });
    await runBatch();
    requestBodies = [];

    const job = await runBatch({ redo_unless_model: 'local:vision-1' });

    expect(batchResult(job)).toMatchObject({ scored: 0, total: 0 });
    expect(requestBodies).toHaveLength(0);
  });

  /** The survivors are forced, so an old model's row is replaced rather than stacked. */
  it('force-rescores what a different model produced', async () => {
    await seedPhotos('a');
    fx.addPerspectives({ slug: 'street' });
    await runBatch();
    replies = [completion(scoreJson('street', 5))];

    const job = await runBatch({ redo_unless_model: 'other:model-9' });

    expect(batchResult(job)).toMatchObject({ scored: 1, force: true });
    expect(storedScores('a')).toHaveLength(1);
    expect(storedScores('a')[0]).toMatchObject({ score: 5, is_current: 1 });
  });
});
