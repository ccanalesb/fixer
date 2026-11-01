/**
 * The catalog cache check every photo job runs first — real stages, CLIP stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { stringify as stringifyYaml } from 'yaml';
import { makeFakeCatalog, type CatalogFile } from './helpers/fake-catalog.js';
import { LibraryFixture } from './helpers/library-fixture.js';
import type { Db } from '../src/db/connection.js';
import { createJob, getJob, initJobsDb } from '../src/db/jobs/jobs.js';
import { JobRunner } from '../src/jobs/runner.js';
import { tick } from '../src/jobs/processor.js';
import { ensureCatalogCache } from '../src/jobs/handlers/catalog-cache.js';

vi.unmock('../src/jobs/handlers/catalog-cache.js');

const enc = vi.hoisted(() => ({ modelLoadFails: false, encoded: 0 }));

vi.mock('../src/imaging/clip-embed.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/imaging/clip-embed.js')>();
  return {
    ...actual,
    loadClipModel: async (): Promise<void> => {
      if (enc.modelLoadFails) throw new Error(actual.CLIP_MODEL_DOWNLOAD_FAILED_MESSAGE);
    },
    encodeImages: async (paths: string[]): Promise<Float32Array[]> =>
      paths.map(() => {
        enc.encoded += 1;
        return new Float32Array(512).fill(1);
      }),
  };
});

let fx: LibraryFixture;
let dir: string;
let photoDir: string;
let lrcatPath: string;
let jobsDbPath: string;

function withJobsDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const db = initJobsDb(jobsDbPath);
  return fn(db).finally(() => db.close());
}

async function seedCatalog(names: string[]): Promise<void> {
  const files: CatalogFile[] = names.map((baseName, i) => ({
    id: i + 1,
    baseName,
    captureTime: `2024-06-01T1${i}:00:00`,
  }));
  rmSync(lrcatPath, { force: true });
  makeFakeCatalog(lrcatPath, files, { rootPath: `${dir}/` });
  for (const name of names) {
    await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .jpeg()
      .toFile(join(photoDir, `${name}.jpg`));
  }
}

/** Start a job row and run the check in it, the way the processor does. */
async function check(jobType = 'batch_cull_photos_before_scoring') {
  return withJobsDb(async (db) => {
    const runner = new JobRunner(db);
    const jobId = createJob(db, jobType, {});
    runner.startJob(jobId, jobType);
    const ready = await ensureCatalogCache(runner, jobId, jobType);
    if (ready) runner.updateProgress(jobId, 0, 'own work starts');
    const job = getJob(db, jobId)!;
    return { ready, job, messages: job.logs.map((l) => l.message) };
  });
}

const countOf = (table: string): number =>
  Number(fx.query<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)[0]!.c);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-cache-check-'));
  photoDir = join(dir, '2024');
  mkdirSync(photoDir);
  jobsDbPath = join(dir, 'visualizer.db');
  lrcatPath = join(dir, 'catalog.lrcat');
  const cfgPath = join(dir, 'config.yaml');
  fx = new LibraryFixture().activate();
  enc.modelLoadFails = false;
  enc.encoded = 0;
  process.env.DATABASE_PATH = jobsDbPath;
  writeFileSync(
    cfgPath,
    stringifyYaml({ catalog_path: lrcatPath, vision_cache_dir: join(dir, 'vision') }),
  );
  process.env.LT_CONFIG_YAML = cfgPath;
});

afterEach(() => {
  delete process.env.DATABASE_PATH;
  delete process.env.LT_CONFIG_YAML;
  fx.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe('the catalog cache check', () => {
  it('builds a missing cache before the job and logs it', async () => {
    await seedCatalog(['shot-a', 'shot-b']);

    const { ready, messages } = await check();

    expect(ready).toBe(true);
    expect(countOf('images')).toBe(2);
    expect(countOf('image_clip_embeddings')).toBe(2);
    expect(countOf('vision_cache')).toBe(2);
    expect(messages).toContain(
      '[cache] checking the catalog cache before batch_cull_photos_before_scoring',
    );
    expect(messages).toContain(
      '[cache] cache built: added=2 stale=0 embedded=2 skipped=0 failed=0',
    );
    expect(messages).toContain('[cache] stage=stack status=start');
  });

  it('starts the job after the check on the bar', async () => {
    await seedCatalog(['shot-a']);

    const { job } = await check();

    expect(job.progress).toBe(20);
  });

  it('finds an unchanged cache up to date without ranking again', async () => {
    await seedCatalog(['shot-a', 'shot-b']);
    await check();
    enc.encoded = 0;

    const { ready, messages } = await check();

    expect(ready).toBe(true);
    expect(enc.encoded).toBe(0);
    expect(messages).toContain('[cache] cache up to date');
    expect(messages.some((m) => m.includes('stage=stack'))).toBe(false);
  });

  it('builds what a photo added in Lightroom is missing', async () => {
    await seedCatalog(['shot-a']);
    await check();
    await seedCatalog(['shot-a', 'shot-b']);

    const { messages } = await check();

    expect(countOf('image_clip_embeddings')).toBe(2);
    expect(messages).toContain(
      '[cache] cache built: added=1 stale=0 embedded=1 skipped=0 failed=0',
    );
  });

  it('fails the job when the cache cannot be built', async () => {
    await seedCatalog(['shot-a']);
    enc.modelLoadFails = true;

    const { ready, job } = await check();

    expect(ready).toBe(false);
    expect(job.status).toBe('failed');
    expect(job.error).toBe(
      'Could not download the image model (about 350 MB) from huggingface.co. Check the internet connection and retry.',
    );
  });

  it('keeps the job from running when the check fails', async () => {
    await seedCatalog(['shot-a']);
    enc.modelLoadFails = true;

    const job = await withJobsDb(async (db) => {
      const jobId = createJob(db, 'batch_frame_substance', {});
      await tick(db, new JobRunner(db));
      return getJob(db, jobId)!;
    });

    expect(job.status).toBe('failed');
    const own = job.logs
      .map((l) => l.message)
      .filter((m) => !m.startsWith('[cache]') && !m.startsWith('Job ') && m !== job.error);
    expect(own).toEqual([]);
  });
});
