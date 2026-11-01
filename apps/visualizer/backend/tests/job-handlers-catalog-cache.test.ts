/**
 * The `catalog_cache_build` chain via the processor — real stages end to end,
 * CLIP stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { stringify as stringifyYaml } from 'yaml';
import { makeFakeCatalog } from './helpers/fake-catalog.js';
import { LibraryFixture } from './helpers/library-fixture.js';
import type { Db } from '../src/db/connection.js';
import { createJob, getJob, initJobsDb, updateJobStatus } from '../src/db/jobs/jobs.js';
import { JobRunner } from '../src/jobs/runner.js';
import { tick } from '../src/jobs/processor.js';
import type { CatalogCacheBuildResult } from '../src/jobs/handlers/catalog-cache.js';

/** Hoisted so the `vi.mock` factory can close over it. */
const enc = vi.hoisted(() => ({
  paths: [] as string[],
  /** Runs per encoded path; the cancellation test uses it as its only hook. */
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
        // Identical vectors, so every pair is a perfect match and the similarity
        // stage has something to group.
        return new Float32Array(512).fill(1);
      }),
  };
});

let fx: LibraryFixture;
let dir: string;
let photoDir: string;
let lrcatPath: string;
let cfgPath: string;
let jobsDbPath: string;

async function withJobsDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const db = initJobsDb(jobsDbPath);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/** Enqueue a chain, run one processor pass, and hand back the settled job. */
async function runChain(metadata: Record<string, unknown> = {}) {
  return withJobsDb(async (db) => {
    const jobId = createJob(db, 'catalog_cache_build', metadata);
    await tick(db, new JobRunner(db));
    return getJob(db, jobId)!;
  });
}

const logMessages = (job: { logs: { message: string }[] }): string[] =>
  job.logs.map((l) => l.message);

/** Only the chain's own banners, in order — the stage passes log around them. */
const banners = (job: { logs: { message: string }[] }): string[] =>
  logMessages(job).filter((m) => m.startsWith('[catalog-cache-build] '));

const countOf = (table: string): number =>
  Number(fx.query<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)[0]!.c);

const result = (job: { result: unknown }): CatalogCacheBuildResult =>
  job.result as CatalogCacheBuildResult;

/**
 * A photo where the catalog says it is: root folder plus `2024/` plus the name.
 * Embed reads a compressed copy from the vision cache rather than this file, but
 * the original has to exist for the path to resolve at all.
 */
async function writePhoto(name: string): Promise<void> {
  await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .jpeg()
    .toFile(join(photoDir, name));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-cache-chain-'));
  photoDir = join(dir, '2024');
  mkdirSync(photoDir);
  jobsDbPath = join(dir, 'visualizer.db');
  lrcatPath = join(dir, 'catalog.lrcat');
  cfgPath = join(dir, 'config.yaml');
  fx = new LibraryFixture().activate();
  enc.paths = [];
  enc.onEncode = null;
  enc.modelLoadFails = false;
  process.env.DATABASE_PATH = jobsDbPath;
  writeFileSync(
    cfgPath,
    stringifyYaml({
      catalog_path: lrcatPath,
      vision_cache_dir: join(dir, 'vision'),
      stack_burst_delta_ms: 2000,
    }),
  );
  process.env.LT_CONFIG_YAML = cfgPath;
});

afterEach(() => {
  delete process.env.DATABASE_PATH;
  delete process.env.LT_CONFIG_YAML;
  fx.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Two bursts an hour apart, of two frames each.
 *
 * Two rather than one because the similarity stage only seeds from a stack's
 * representative: a single burst collapses to one primary grid row, which has
 * nothing left to match against.
 */
async function seedCatalogBursts(): Promise<void> {
  makeFakeCatalog(
    lrcatPath,
    [
      { id: 1, baseName: 'shot-a', captureTime: '2024-06-01T12:00:00' },
      { id: 2, baseName: 'shot-b', captureTime: '2024-06-01T12:00:00.5', rating: 5 },
      { id: 3, baseName: 'shot-c', captureTime: '2024-06-01T13:00:00' },
      { id: 4, baseName: 'shot-d', captureTime: '2024-06-01T13:00:00.5', rating: 5 },
    ],
    { rootPath: `${dir}/` },
  );
  for (const name of ['shot-a', 'shot-b', 'shot-c', 'shot-d']) await writePhoto(`${name}.jpg`);
}

describe('the catalog_cache_build handler', () => {
  it('carries four catalog rows through to stacks and similarity groups', async () => {
    await seedCatalogBursts();

    const job = await runChain();

    expect(job.status).toBe('completed');
    const r = result(job);
    expect(r.catalog_cache_build).toBe(true);
    expect(r.sync.added).toBe(4);
    expect(r.embed.embedded).toBe(4);
    // Two bursts, because the pairs are half a second apart and an hour apart.
    expect(r.stack.stacks_created).toBe(2);
    expect(r.similarity.groups_created).toBeGreaterThan(0);

    // The chain's whole point: what stage 0 fetched is what stage 3 grouped.
    expect(countOf('images')).toBe(4);
    expect(countOf('image_clip_embeddings')).toBe(4);
    expect(countOf('image_stack_members')).toBe(4);
    expect(countOf('catalog_similarity_groups')).toBe(r.similarity.groups_created);
  });

  it('completes on an empty catalog with a warning, leaving first run open', async () => {
    makeFakeCatalog(lrcatPath, [], { rootPath: `${dir}/` });

    const job = await runChain();

    expect(job.status).toBe('completed');
    expect(banners(job)).toContain(
      '[catalog-cache-build] warning=empty_catalog The Lightroom catalog has no photos yet',
    );
    const firstRun = fx.query<{ c: number }>(
      "SELECT COUNT(*) AS c FROM library_meta WHERE key = 'first_catalog_import_completed'",
    );
    expect(Number(firstRun[0]!.c)).toBe(0);
  });

  it('marks first run done once the catalog has photos', async () => {
    await seedCatalogBursts();

    await runChain();

    const firstRun = fx.query<{ c: number }>(
      "SELECT COUNT(*) AS c FROM library_meta WHERE key = 'first_catalog_import_completed'",
    );
    expect(Number(firstRun[0]!.c)).toBe(1);
  });

  it('records which knobs the run used, as a digest', async () => {
    await seedCatalogBursts();

    const job = await runChain({ force_embed: true });

    expect(result(job).fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result(job).fingerprint).not.toBe(result(await runChain()).fingerprint);
  });

  it('brackets every stage with a start and a complete banner', async () => {
    await seedCatalogBursts();

    const job = await runChain();

    expect(banners(job).map((m) => m.replace('[catalog-cache-build] ', ''))).toEqual([
      'chain_start sync→embed→stack_detect→catalog_similarity',
      'stage=sync status=start',
      expect.stringContaining('stage=sync status=complete added=4 stale=0'),
      'stage=embed status=start',
      'stage=embed status=complete embedded=4 skipped=0 failed=0',
      'stage=stack status=start',
      expect.stringContaining('stage=stack status=complete stacks_created=2'),
      'stage=similarity status=start',
      expect.stringContaining('stage=similarity status=complete groups_created='),
    ]);
  });

  it('labels each stage log with the pass that wrote it', async () => {
    await seedCatalogBursts();

    const job = await runChain();

    expect(logMessages(job).some((m) => m.startsWith('[embed] batch_embed_image:'))).toBe(true);
    expect(logMessages(job).some((m) => m.startsWith('[stack] Stack detection complete'))).toBe(
      true,
    );
    expect(
      logMessages(job).some((m) => m.startsWith('[similarity] batch_catalog_similarity')),
    ).toBe(true);
  });

  /**
   * The three stages after sync read `library.db`, which is there and still worth
   * indexing whether or not today's additions arrived — so a sync the user's own
   * configuration makes unrunnable is a logged stage result, not a failed job.
   */
  it('indexes what is already in the library when the sync cannot run', async () => {
    writeFileSync(cfgPath, stringifyYaml({ vision_cache_dir: join(dir, 'vision') }));
    await writePhoto('already.jpg');
    fx.addImage({
      key: '2024-06-01_already.jpg',
      date_taken: '2024-06-01T12:00:00',
      filepath: join(photoDir, 'already.jpg'),
    });

    const job = await runChain();

    expect(job.status).toBe('completed');
    expect(result(job).sync).toEqual({
      skipped: true,
      error: 'No catalog path configured. Set catalog_path in config.yaml.',
      added: 0,
      stale: 0,
    });
    expect(result(job).embed.embedded).toBe(1);
    expect(banners(job)).toContain(
      '[catalog-cache-build] stage=sync status=complete added=0 stale=0 locking_mode=unknown ' +
        'error=No catalog path configured. Set catalog_path in config.yaml.',
    );
  });

  it('reports a catalog it cannot read as a failed stage, not a failed job', async () => {
    writeFileSync(lrcatPath, 'not a catalog');
    await writePhoto('already.jpg');
    fx.addImage({
      key: '2024-06-01_already.jpg',
      date_taken: '2024-06-01T12:00:00',
      filepath: join(photoDir, 'already.jpg'),
    });

    const job = await runChain();

    expect(job.status).toBe('completed');
    expect(result(job).sync.failed).toBe(true);
    // SQLite's own words: the sync driver only rewrites the two failures a user
    // can act on, and a corrupt file is not one of them.
    expect(result(job).sync.error).toBe('file is not a database');
    expect(result(job).embed.embedded).toBe(1);
  });

  it('fails the job when CLIP cannot load but keeps photos synced before embed', async () => {
    await seedCatalogBursts();
    enc.modelLoadFails = true;

    const job = await runChain();

    expect(job.status).toBe('failed');
    expect(job.error).toBe(
      'Could not download the image model (about 350 MB) from huggingface.co. Check the internet connection and retry.',
    );
    expect(countOf('images')).toBe(4);
    expect(countOf('image_clip_embeddings')).toBe(0);
    expect(countOf('image_stacks')).toBe(0);
    expect(banners(job).some((m) => m.includes('stage=stack'))).toBe(false);
    expect(banners(job)).toContain('[catalog-cache-build] stage=sync status=start');
    expect(banners(job).some((m) => m.includes('stage=sync status=complete added=4'))).toBe(true);
    expect(banners(job)).toContain('[catalog-cache-build] stage=embed status=start');
  });

  /** Sync is the only forgiving stage; a later one failing is the job failing. */
  it('fails the job when a stage after sync fails', async () => {
    await seedCatalogBursts();

    const job = await runChain({ delta_ms: 'nonsense' });

    expect(job.status).toBe('failed');
    expect(job.error).toBe('Invalid delta_ms in metadata (must be integer >= 1)');
    expect(job.error_severity).toBe('warning');
    // The chain stopped where it failed rather than running on.
    expect(banners(job).some((m) => m.includes('stage=similarity'))).toBe(false);
    expect(countOf('catalog_similarity_groups')).toBe(0);
  });

  it('stops the chain when the user cancels mid-stage', async () => {
    await seedCatalogBursts();
    enc.onEncode = () => {
      withCancelledJob();
    };

    const job = await runChain();

    expect(job.status).toBe('cancelled');
    expect(logMessages(job)).toContain('Job stopped after cancel request');
    // Whatever embed finished is kept; the stages after it never started.
    expect(countOf('image_stacks')).toBe(0);
    expect(banners(job).some((m) => m.includes('stage=stack'))).toBe(false);
  });

  /**
   * Each stage reads `force` under its own name, so a chain re-run can mean
   * "re-embed" without also meaning "rebuild every stack". A bare `force` is
   * neither, which is what keeps the chain from inheriting a flag aimed at one of
   * the standalone jobs.
   */
  it('routes force_embed to embed alone, and ignores a bare force', async () => {
    await seedCatalogBursts();
    await runChain();
    enc.paths = [];

    const bare = result(await runChain({ force: true }));
    expect(bare.embed.embedded).toBe(0);
    expect(bare.stack.stacks_created).toBe(0);
    expect(enc.paths).toEqual([]);

    expect(result(await runChain({ force_embed: true })).embed.embedded).toBe(4);
    expect(result(await runChain({ force_stack: true })).stack.stacks_created).toBe(2);
  });
});

/** Cancel the one job in the jobs DB, the way the cancel route would. */
function withCancelledJob(): void {
  const db = initJobsDb(jobsDbPath);
  try {
    const row = db.prepare('SELECT id FROM jobs LIMIT 1').get() as { id: string };
    updateJobStatus(db, row.id, 'cancelled');
  } finally {
    db.close();
  }
}
