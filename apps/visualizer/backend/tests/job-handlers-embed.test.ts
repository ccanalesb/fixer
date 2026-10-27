/**
 * The `batch_embed_image` handler via the processor. CLIP is stubbed; vec0, JPEGs,
 * and vision cache are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { LibraryFixture } from './helpers/library-fixture.js';
import { createJob, getJob, initJobsDb } from '../src/db/jobs/jobs.js';
import type { Db } from '../src/db/connection.js';
import { deserializeFloat32 } from '../src/db/connection.js';
import { JobRunner } from '../src/jobs/runner.js';
import { tick } from '../src/jobs/processor.js';
import { fingerprintBatchEmbedImage } from '../src/jobs/checkpoint.js';

/** Hoisted so the `vi.mock` factory can close over it. */
const enc = vi.hoisted(() => ({
  paths: [] as string[],
  /** Runs per encoded path; throw from it to simulate an unreadable file. */
  onEncode: null as null | ((path: string) => void),
  modelLoadFails: false,
}));

vi.mock('../src/imaging/clip-embed.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/imaging/clip-embed.js')>();
  return {
    ...actual,
    loadClipModel: async (): Promise<void> => {
      if (enc.modelLoadFails) {
        throw new Error(actual.CLIP_MODEL_DOWNLOAD_FAILED_MESSAGE);
      }
    },
    encodeImages: async (paths: string[]): Promise<Float32Array[]> =>
      paths.map((path) => {
        enc.paths.push(path);
        enc.onEncode?.(path);
        return new Float32Array(512).fill(1);
      }),
  };
});

let fx: LibraryFixture;
let dir: string;
let jobsDbPath: string;

interface EmbedResult {
  embedded: number;
  skipped: number;
  failed: number;
  total: number;
  skip_reason_counts: Record<string, number>;
}

async function writePhoto(name: string): Promise<string> {
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
async function runBatch(metadata: Record<string, unknown> = {}) {
  return withJobsDb(async (db) => {
    const jobId = createJob(db, 'batch_embed_image', metadata);
    await tick(db, new JobRunner(db));
    return getJob(db, jobId)!;
  });
}

const logMessages = (job: { logs: { message: string }[] }): string[] =>
  job.logs.map((l) => l.message);

/**
 * Where the vision cache lands the compressed copy of `key`.
 *
 * The encoder is fed this, not the original: the cached JPEG is what every stored
 * vector in `library.db` was computed from, so embedding the original instead
 * would drift the new vectors away from the corpus they have to rank against.
 */
const cachedPath = (key: string): string => join(dir, 'vision', `${key}.jpg`);

const embeddedKeys = (): string[] =>
  fx
    .query<{ image_key: string }>('SELECT image_key FROM image_clip_embeddings')
    .map((r) => r.image_key)
    .sort();

/** The stored vector's first component, which tells a seeded row from a fresh one. */
function firstComponent(imageKey: string): number {
  const [row] = fx.query<{ embedding: Buffer }>(
    'SELECT embedding FROM image_clip_embeddings WHERE image_key = ?',
    imageKey,
  );
  return deserializeFloat32(row!.embedding)[0]!;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-embed-job-'));
  jobsDbPath = join(dir, 'visualizer.db');
  fx = new LibraryFixture().activate();
  enc.paths = [];
  enc.onEncode = null;
  enc.modelLoadFails = false;
  process.env.DATABASE_PATH = jobsDbPath;
  writeFileSync(join(dir, 'config.yaml'), `vision_cache_dir: ${join(dir, 'vision')}\n`);
  process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
});

afterEach(() => {
  delete process.env.DATABASE_PATH;
  delete process.env.LT_CONFIG_YAML;
  fx.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe('the batch_embed_image handler', () => {
  it('completes immediately when there is nothing to embed', async () => {
    const job = await runBatch();

    expect(job.status).toBe('completed');
    expect(job.result).toEqual({
      embedded: 0,
      skipped: 0,
      failed: 0,
      total: 0,
      skip_reason_counts: {
        no_row: 0,
        empty_path: 0,
        unresolved_or_missing: 0,
        encode_failed: 0,
      },
    });
    expect(enc.paths).toEqual([]);
  });

  it('refuses an image_type other than catalog', async () => {
    const job = await runBatch({ image_type: 'instagram' });

    expect(job.status).toBe('failed');
    expect(job.error).toBe("batch_embed_image: image_type must be 'catalog'");
    expect(job.error_severity).toBe('warning');
  });

  /**
   * The run leaves nothing a user can see, so it has to say what it was for —
   * otherwise "embedded 40,000" reads like a job that did nothing.
   */
  it('writes a vector per image and says the run only builds the index', async () => {
    fx.addImage({ key: 'a', filepath: await writePhoto('a.jpg') });

    const job = await runBatch();

    expect(job.status).toBe('completed');
    expect((job.result as unknown as EmbedResult).embedded).toBe(1);
    expect(embeddedKeys()).toEqual(['a']);
    expect(logMessages(job)).toContain('batch_embed_image: model=clip-ViT-B-32');
    expect(logMessages(job).some((m) => m.includes('builds similarity index only'))).toBe(true);
  });

  it('leaves images that already have a vector alone', async () => {
    fx.addImage({ key: 'a', date_taken: '2024-01-10', filepath: await writePhoto('a.jpg') });
    fx.addImage({ key: 'b', date_taken: '2024-01-11', filepath: await writePhoto('b.jpg') });
    fx.addClipEmbedding('a', 0);

    const job = await runBatch();

    expect((job.result as unknown as EmbedResult).embedded).toBe(1);
    expect(enc.paths).toEqual([cachedPath('b')]);
    expect(firstComponent('a')).toBe(0);
    expect(firstComponent('b')).toBe(1);
  });

  /** Newest first, so an interrupted run has covered the recent photos. */
  it('re-embeds everything newest first when force is set', async () => {
    fx.addImage({ key: 'a', date_taken: '2024-01-10', filepath: await writePhoto('a.jpg') });
    fx.addImage({ key: 'b', date_taken: '2024-01-11', filepath: await writePhoto('b.jpg') });
    fx.addClipEmbedding('a', 0);
    fx.addClipEmbedding('b', 0);

    const job = await runBatch({ force: true });

    expect((job.result as unknown as EmbedResult).embedded).toBe(2);
    expect(enc.paths).toEqual([cachedPath('b'), cachedPath('a')]);
    // A vec0 re-embed is a delete plus an insert, so a botched one would leave
    // either two rows for the key or none.
    expect(embeddedKeys()).toEqual(['a', 'b']);
    expect(firstComponent('a')).toBe(1);
  });

  it('honours the rating window when selecting work', async () => {
    fx.addImage({ key: 'low', filepath: await writePhoto('low.jpg'), rating: 1 });
    fx.addImage({ key: 'high', filepath: await writePhoto('high.jpg'), rating: 4 });

    const job = await runBatch({ min_rating: 3 });

    expect((job.result as unknown as EmbedResult).total).toBe(1);
    expect(embeddedKeys()).toEqual(['high']);
  });

  it('fails the job when the CLIP model cannot be downloaded', async () => {
    fx.addImage({ key: 'a', filepath: await writePhoto('a.jpg') });
    fx.addImage({ key: 'b', filepath: await writePhoto('b.jpg') });
    enc.modelLoadFails = true;

    const job = await runBatch();

    expect(job.status).toBe('failed');
    expect(job.error).toBe('Could not download the CLIP model from huggingface.co.');
    expect(enc.paths).toEqual([]);
    expect(embeddedKeys()).toEqual([]);
  });

  /** One unreadable file must cost one image, not the rest of the run. */
  it('counts an encoder failure without abandoning the other images', async () => {
    fx.addImage({ key: 'a', date_taken: '2024-01-10', filepath: await writePhoto('a.jpg') });
    fx.addImage({ key: 'b', date_taken: '2024-01-11', filepath: await writePhoto('b.jpg') });
    enc.onEncode = (path) => {
      if (path.endsWith('b.jpg')) throw new Error('decode blew up');
    };

    const job = await runBatch();

    const result = job.result as unknown as EmbedResult;
    expect(job.status).toBe('completed');
    expect(result).toMatchObject({ embedded: 1, failed: 1, skipped: 0, total: 2 });
    expect(result.skip_reason_counts.encode_failed).toBe(1);
    expect(embeddedKeys()).toEqual(['a']);
    expect(logMessages(job).some((m) => m.startsWith('b: skipped image embed'))).toBe(true);
  });

  /**
   * An unmounted share is the common failure. It has to be legible up front,
   * rather than as thousands of individual errors the user has to read.
   */
  it('warns in preflight and groups the reason when the files are gone', async () => {
    for (let i = 0; i < 3; i += 1) {
      fx.addImage({ key: `k${i}`, filepath: join(dir, `missing-${i}.jpg`) });
    }

    const job = await runBatch();

    const result = job.result as unknown as EmbedResult;
    expect(job.status).toBe('completed');
    expect(result).toMatchObject({ embedded: 0, skipped: 3, failed: 0, total: 3 });
    expect(result.skip_reason_counts.unresolved_or_missing).toBe(3);
    expect(enc.paths).toEqual([]);
    const messages = logMessages(job);
    expect(messages.some((m) => m.includes('batch_embed_image preflight: 3/3 sampled'))).toBe(true);
    expect(messages.some((m) => m.includes('network share is not mounted'))).toBe(true);
  });

  it('stops logging individual skips after five of a kind', async () => {
    for (let i = 0; i < 8; i += 1) {
      fx.addImage({ key: `k${i}`, filepath: join(dir, `missing-${i}.jpg`) });
    }

    const job = await runBatch();

    const perImage = logMessages(job).filter((m) => m.includes('skipped image embed'));
    expect(perImage).toHaveLength(5);
    expect(logMessages(job)).toContain(
      'additional unresolved_or_missing skip logs suppressed after 5 samples; ' +
        'see skip_reason_counts',
    );
  });

  /**
   * The motion-photo case: `prepare_catalog` cached a JPEG and Lightroom then
   * removed the original. The cache is enough, so the image must still embed.
   */
  it('embeds from the vision cache when the original is gone', async () => {
    const cached = await writePhoto('cached.jpg');
    fx.addImage({ key: 'a', filepath: join(dir, 'gone', 'original.jpg') });
    fx.addVisionCache('a', cached);

    const job = await runBatch();

    expect((job.result as unknown as EmbedResult)).toMatchObject({ embedded: 1, skipped: 0 });
    expect(enc.paths).toEqual([cached]);
  });

  it('clears the checkpoint once the run completes', async () => {
    fx.addImage({ key: 'a', filepath: await writePhoto('a.jpg') });

    const job = await runBatch();

    expect(job.metadata.checkpoint).toBeNull();
  });

  /** The point of the checkpoint: a resumed run must not redo finished work. */
  it('resumes from a checkpoint and skips the keys already processed', async () => {
    fx.addImage({ key: 'a', filepath: await writePhoto('a.jpg') });
    fx.addImage({ key: 'b', filepath: await writePhoto('b.jpg') });

    // Undated images sort by key descending.
    const fingerprint = await fingerprintBatchEmbedImage({}, ['b', 'a'], {
      resolvedMonths: null,
      resolvedYear: null,
    });
    const job = await runBatch({
      checkpoint: {
        checkpoint_version: 1,
        job_type: 'batch_embed_image',
        fingerprint,
        processed_pairs: ['b'],
        total_at_start: 2,
      },
    });

    expect((job.result as unknown as EmbedResult).embedded).toBe(1);
    expect(embeddedKeys()).toEqual(['a']);
  });

  it('discards a checkpoint built from different inputs, and says so', async () => {
    fx.addImage({ key: 'a', filepath: await writePhoto('a.jpg') });
    fx.addImage({ key: 'b', filepath: await writePhoto('b.jpg') });

    const job = await runBatch({
      checkpoint: {
        checkpoint_version: 1,
        job_type: 'batch_embed_image',
        fingerprint: 'stale',
        processed_pairs: ['b'],
        total_at_start: 2,
      },
    });

    expect((job.result as unknown as EmbedResult).embedded).toBe(2);
    expect(logMessages(job)).toContain(
      'checkpoint mismatch: batch_embed_image fingerprint changed, starting fresh',
    );
  });

  /**
   * Cancel is cooperative: the image in flight finishes and the checkpoint keeps
   * it, so a retry starts from there rather than from zero.
   */
  it('stops at the next image when a cancel arrives mid-run', async () => {
    fx.addImage({ key: 'a', filepath: await writePhoto('a.jpg') });
    fx.addImage({ key: 'b', filepath: await writePhoto('b.jpg') });

    await withJobsDb(async (db) => {
      const jobId = createJob(db, 'batch_embed_image', {});
      const runner = new JobRunner(db);
      enc.onEncode = () => runner.signalCancel(jobId);

      await tick(db, runner);

      const job = getJob(db, jobId)!;
      expect(job.status).toBe('cancelled');
      // Selection is key descending, so the one image that ran was the last key.
      expect(embeddedKeys()).toEqual(['b']);
      expect(job.metadata.checkpoint).toMatchObject({ processed_pairs: ['b'] });
    });
  });
});
