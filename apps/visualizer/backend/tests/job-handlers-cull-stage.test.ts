/**
 * In-job cull step before kimi: describe, score, and analyze handlers.
 */
import {
  getKimiJobModels,
  prepareKimiJobCull,
  resetKimiJobModels,
  writeKimiJobConfig,
} from './helpers/kimi-job-models.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { LibraryFixture } from './helpers/library-fixture.js';
import { writeFakePhoto } from './helpers/fake-app-models.js';
import { closeAppModels } from '../src/app-models/app-models.js';
import { createJob, getJob, initJobsDb } from '../src/db/jobs/jobs.js';
import type { Db } from '../src/db/connection.js';
import { openLibraryDb } from '../src/db/connection.js';
import { JobRunner } from '../src/jobs/runner.js';
import { tick } from '../src/jobs/processor.js';
import { fingerprintBatchScore } from '../src/jobs/checkpoint.js';
import { recordCullUserAction } from '../src/db/library/cull-user-actions.js';
import { saveProfileDefinition, getCullProfile } from '../src/db/library/cull-profiles.js';
import { APP_MODEL_SETUP_COMMAND } from '../src/app-models/files.js';

const RUBRIC = 'RUBRIC-SENTINEL';

type Script = { levels: [number, number, number, number]; p8: number };
const PASS: Script = { levels: [5, 5, 6, 6], p8: 0.5 };
const PROFILE_CUT: Script = { levels: [5, 5, 2, 3], p8: 0.5 };
const FORECAST_CUT: Script = { levels: [5, 5, 6, 6], p8: 0.05 };

let fx: LibraryFixture;
let dir: string;
let jobsDbPath: string;
let modelsDir: string;
let server: Server;
let port: number;

let reply: { status: number; body: unknown } = { status: 200, body: {} };
let describeReply: { status: number; body: unknown };
let scoreReply: { status: number; body: unknown };
let onRequest: (() => void) | null = null;

const completion = (content: string) => ({
  status: 200,
  body: { choices: [{ message: { content } }] },
});

const fakeModels = () => getKimiJobModels();

function pushKimi(kind: 'describe' | 'score', key: string): void {
  fakeModels().sequence.push(`kimi:${kind}:${key}`);
}

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        onRequest?.();
        const scoring = raw.includes(RUBRIC);
        if (scoring) {
          const m = raw.match(/"image_key"\s*:\s*"([^"]+)"/);
          pushKimi('score', m?.[1] ?? '?');
        } else {
          const m = raw.match(/"image_key"\s*:\s*"([^"]+)"/);
          pushKimi('describe', m?.[1] ?? '?');
        }
        const body = scoring ? scoreReply : describeReply ?? reply;
        res.writeHead(body.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body.body));
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

async function withJobsDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const db = initJobsDb(jobsDbPath);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

async function runJob(type: string, metadata: Record<string, unknown> = {}) {
  return withJobsDb(async (db) => {
    const jobId = createJob(db, type, metadata);
    await tick(db, new JobRunner(db));
    return getJob(db, jobId)!;
  });
}

async function seedCullPhoto(key: string, script: Script): Promise<void> {
  const path = join(dir, 'vision', `${key}.jpg`);
  await writeFakePhoto(path, key);
  fx.addImage({ key, filepath: `/missing/${key}.NEF`, date_taken: '2024-01-01' }).addVisionCache(key, path);
  fakeModels().scripts.set(key, script);
}

async function seedVoidBlack(key: string): Promise<void> {
  const filepath = join(dir, `${key}-void.jpg`);
  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000' } })
    .jpeg()
    .toFile(filepath);
  fx.addImage({ key, filepath });
}

function markDescribed(...keys: string[]): void {
  for (const key of keys) {
    fx.exec(
      `INSERT INTO image_descriptions (image_key, image_type, summary, model_used, described_at)
       VALUES (?, 'catalog', 'done', 'local:vision-1', datetime('now'))`,
      key,
    );
  }
}

async function seedHeldBackQuartet(): Promise<void> {
  await seedCullPhoto('pass', PASS);
  await seedCullPhoto('profile', PROFILE_CUT);
  await seedCullPhoto('forecast', FORECAST_CUT);
  await seedCullPhoto('void', PASS);
  fx.addFrameSubstance('void', 'void');
}

function lastModelCallBeforeFirstKimi(): boolean {
  const seq = fakeModels().sequence;
  const li = seq.reduce((best, s, i) => (s.startsWith('model:') ? i : best), -1);
  const ki = seq.findIndex((s) => s.startsWith('kimi:'));
  return li >= 0 && ki >= 0 && li < ki;
}

interface JobCullResult {
  cull?: Record<string, unknown>;
  held_back?: Record<string, number>;
  durations_s?: Record<string, number>;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lt-cull-stage-'));
  jobsDbPath = join(dir, 'visualizer.db');
  fx = new LibraryFixture().cullingStagesOn().addForecastQuestions().activate();
  resetKimiJobModels();
  onRequest = null;
  describeReply = completion(JSON.stringify({ summary: 'A scene', subjects: ['x'] }));
  scoreReply = completion(JSON.stringify({ perspective_slug: 'street', score: 7, rationale: 'ok' }));
  reply = describeReply;
  process.env.DATABASE_PATH = jobsDbPath;
  await startServer();
  writeProviders();
  modelsDir = prepareKimiJobCull(fx.dbPath, dir);
  writeKimiJobConfig(dir, modelsDir);
  process.env.LT_PROVIDERS_JSON = join(dir, 'providers.json');
  process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
  fx.addPerspectives({ slug: 'street', prompt_markdown: `# street\n${RUBRIC}` });
});

afterEach(async () => {
  await closeAppModels();
  delete process.env.DATABASE_PATH;
  delete process.env.LT_PROVIDERS_JSON;
  delete process.env.LT_CONFIG_YAML;
  fx.cleanup();
  rmSync(dir, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
});

describe('in-job cull step (batch_describe)', () => {
  it('describes only PASS; held_back void and both filter reasons', async () => {
    await seedHeldBackQuartet();
    const job = await runJob('batch_describe', { max_workers: 1 });
    expect(job.status).toBe('completed');
    const r = job.result as JobCullResult;
    expect(r.held_back).toMatchObject({
      void: 1,
      filtered_by_culling_profile: 1,
      filtered_by_score_forecast: 1,
    });
    const described = fx.query<{ image_key: string }>('SELECT image_key FROM image_descriptions').map((x) => x.image_key);
    expect(described).toEqual(['pass']);
    expect(fakeModels().calls.some((c) => c.file.includes('/void.jpg'))).toBe(false);
    expect(fakeModels().sequence.some((s) => s.startsWith('kimi:describe:void'))).toBe(false);
  });
});

describe('in-job cull step (batch_score)', () => {
  it('scores only PASS; filtered and void photos have no score row', async () => {
    await seedHeldBackQuartet();
    markDescribed('pass', 'profile', 'forecast', 'void');
    const job = await runJob('batch_score', { max_workers: 1, perspective_slugs: ['street'] });
    expect(job.status).toBe('completed');
    expect((job.result as JobCullResult).held_back).toMatchObject({
      filtered_by_culling_profile: 1,
      filtered_by_score_forecast: 1,
    });
    expect(fx.query('SELECT image_key FROM image_scores WHERE is_current = 1').map((r) => r.image_key)).toEqual([
      'pass',
    ]);
  });
});

describe('in-job cull step (batch_analyze)', () => {
  it('neither describes nor scores filtered or void photos', async () => {
    await seedHeldBackQuartet();
    const job = await runJob('batch_analyze', { max_workers: 1 });
    expect(job.status).toBe('completed');
    expect((job.result as JobCullResult).held_back).toMatchObject({
      void: 1,
      filtered_by_culling_profile: 1,
      filtered_by_score_forecast: 1,
    });
    expect(fx.query('SELECT image_key FROM image_descriptions').map((r) => r.image_key)).toEqual(['pass']);
    expect(fx.query('SELECT image_key FROM image_scores WHERE is_current = 1').map((r) => r.image_key)).toEqual([
      'pass',
    ]);
  });
});

describe('culling before kimi ordering', () => {
  it('batch_describe finishes every fakeModels call before the first kimi call', async () => {
    await seedHeldBackQuartet();
    await runJob('batch_describe', { max_workers: 1 });
    expect(lastModelCallBeforeFirstKimi()).toBe(true);
  });

  it('batch_score finishes every fakeModels call before the first kimi call', async () => {
    await seedCullPhoto('pass', PASS);
    markDescribed('pass');
    await runJob('batch_score', { max_workers: 1, perspective_slugs: ['street'] });
    expect(lastModelCallBeforeFirstKimi()).toBe(true);
  });

  it('batch_analyze finishes every fakeModels call before the first kimi call', async () => {
    await seedHeldBackQuartet();
    await runJob('batch_analyze', { max_workers: 1 });
    expect(lastModelCallBeforeFirstKimi()).toBe(true);
  });
});

describe('score work list fixed at start', () => {
  it('checkpoint fingerprint matches kept triples; mid-job sent_by_hand does not add work', async () => {
    await seedCullPhoto('pass', PASS);
    await seedCullPhoto('profile', PROFILE_CUT);
    markDescribed('pass', 'profile');
    let flipped = false;
    const metadata = { max_workers: 1, perspective_slugs: ['street'] };
    let capturedFp: string | undefined;
    let jobStatus = '';
    await withJobsDb(async (db) => {
      const jobId = createJob(db, 'batch_score', metadata);
      const runner = new JobRunner(db);
      const persist = runner.persistCheckpoint.bind(runner);
      runner.persistCheckpoint = (id, body) => {
        if (id === jobId && body['processed_triplets']) capturedFp = String(body['fingerprint']);
        persist(id, body);
      };
      onRequest = () => {
        if (flipped) return;
        flipped = true;
        const lib = openLibraryDb(fx.dbPath);
        recordCullUserAction(lib, 'profile', 'sent_by_hand');
        lib.close();
      };
      await tick(db, runner);
      const job = getJob(db, jobId)!;
      jobStatus = job.status;
    });
    const keptTriples: [string, string, string][] = [['pass', 'catalog', 'street']];
    expect(capturedFp).toBe(await fingerprintBatchScore(metadata, keptTriples));
    expect(jobStatus).toBe('completed');
    expect(fx.query("SELECT image_key FROM image_scores WHERE is_current = 1 AND image_key = 'profile'")).toEqual([]);
    expect(fx.query("SELECT image_key FROM image_scores WHERE is_current = 1").map((r) => r.image_key)).toEqual(['pass']);
  });
});

describe('sent by hand across stage versions', () => {
  it('scores a profile-filtered photo sent by hand after profile text changes', async () => {
    await seedCullPhoto('hand', PROFILE_CUT);
    markDescribed('hand');
    const lib = openLibraryDb(fx.dbPath);
    recordCullUserAction(lib, 'hand', 'sent_by_hand');
    lib.close();
    await runJob('batch_score', { max_workers: 1, perspective_slugs: ['street'] });
    fakeModels().calls.length = 0;
    const db = openLibraryDb(fx.dbPath);
    const def = getCullProfile(db, 'default')!.definition;
    saveProfileDefinition(db, 'default', def);
    db.close();
    const job = await runJob('batch_score', { force: true, max_workers: 1, perspective_slugs: ['street'] });
    expect(job.status).toBe('completed');
    expect((job.result as JobCullResult).held_back?.sent_by_hand_passed).toBe(1);
    expect(fx.query("SELECT verdict FROM cull_verdicts WHERE image_key = 'hand'")[0]?.verdict).toBe('passed');
    expect(fx.query("SELECT image_key FROM image_scores WHERE image_key = 'hand' AND is_current = 1")).toHaveLength(1);
  });
});

describe('no re-cull when verdicts are current', () => {
  it('second batch_score does not start the models', async () => {
    await seedCullPhoto('pass', PASS);
    markDescribed('pass');
    await runJob('batch_score', { max_workers: 1, perspective_slugs: ['street'] });
    fakeModels().calls.length = 0;
    fakeModels().starts = 0;
    await runJob('batch_score', { max_workers: 1, perspective_slugs: ['street'] });
    expect(fakeModels().calls.length).toBe(0);
    expect(fakeModels().starts).toBe(0);
  });
});

describe('batch_analyze force_cull', () => {
  it('asks the models again on photos already culled and described, but not on those sent by hand', async () => {
    await seedCullPhoto('pass', PASS);
    await seedCullPhoto('hand', PROFILE_CUT);
    const lib = openLibraryDb(fx.dbPath);
    recordCullUserAction(lib, 'hand', 'sent_by_hand');
    lib.close();
    await runJob('batch_analyze', { max_workers: 1, perspective_slugs: ['street'] });
    expect(fx.query("SELECT verdict FROM cull_verdicts WHERE image_key = 'pass'")[0]?.verdict).toBe('passed');

    fakeModels().scripts.set('pass', PROFILE_CUT);
    fakeModels().calls.length = 0;
    await runJob('batch_analyze', { max_workers: 1, perspective_slugs: ['street'] });
    expect(fakeModels().calls).toHaveLength(0);

    const job = await runJob('batch_analyze', { max_workers: 1, perspective_slugs: ['street'], force_cull: true });
    expect(job.status).toBe('completed');
    expect([...new Set(fakeModels().calls.map((c) => c.file.split(/[/\\]/).at(-1)))]).toEqual(['pass.jpg']);
    expect(fx.query("SELECT verdict FROM cull_verdicts WHERE image_key = 'pass'")[0]?.verdict).toBe('filtered');
    expect(fx.query("SELECT verdict FROM cull_verdicts WHERE image_key = 'hand'")[0]?.verdict).toBe('passed');
  });
});

describe('culling stage setup failures fail the job', () => {
  it('batch_describe fails with warning when models are missing', async () => {
    await seedCullPhoto('pass', PASS);
    rmSync(modelsDir, { recursive: true, force: true });
    const job = await runJob('batch_describe', { max_workers: 1 });
    expect(job.status).toBe('failed');
    expect(job.error).toContain(APP_MODEL_SETUP_COMMAND);
    expect(job.error_severity).toBe('warning');
    expect(fakeModels().sequence.some((s) => s.startsWith('kimi:'))).toBe(false);
  });

  it('batch_score fails with warning when models are missing', async () => {
    await seedCullPhoto('pass', PASS);
    markDescribed('pass');
    rmSync(modelsDir, { recursive: true, force: true });
    const job = await runJob('batch_score', { max_workers: 1, perspective_slugs: ['street'] });
    expect(job.status).toBe('failed');
    expect(job.error_severity).toBe('warning');
    expect(fakeModels().sequence.some((s) => s.startsWith('kimi:'))).toBe(false);
  });

  it('start check failure fails describe with no provider call', async () => {
    await seedCullPhoto('pass', PASS);
    fakeModels().startError = new Error('start failed');
    const job = await runJob('batch_describe', { max_workers: 1 });
    expect(job.status).toBe('failed');
    expect(fakeModels().sequence.some((s) => s.startsWith('kimi:'))).toBe(false);
  });
});

describe('per-photo model failure', () => {
  it('stays pending, held back, retried on the next job', async () => {
    await seedCullPhoto('pass', PASS);
    await seedCullPhoto('bad', PASS);
    fakeModels().failOn = 'bad';
    const job = await runJob('batch_describe', { max_workers: 1 });
    expect((job.result as JobCullResult).held_back?.pending).toBe(1);
    expect(fakeModels().sequence.some((s) => s.startsWith('kimi:describe:bad'))).toBe(false);
    fakeModels().failOn = null;
    fakeModels().calls.length = 0;
    await runJob('batch_describe', { max_workers: 1 });
    expect(fakeModels().calls.some((c) => c.file.includes('/bad.jpg'))).toBe(true);
  });
});

describe('G3 void without cache', () => {
  it('cull builds cache, recheck finds void, photo is not described', async () => {
    await seedVoidBlack('black');
    const job = await runJob('batch_describe', { max_workers: 1 });
    expect(job.status).toBe('completed');
    expect(fx.query('SELECT image_key FROM image_descriptions')).toEqual([]);
    expect((job.result as JobCullResult).held_back?.void).toBe(1);
    expect(fakeModels().sequence.some((s) => s.startsWith('kimi:'))).toBe(false);
  });

  it('unknown with no image is not re-detected on a second describe job', async () => {
    fx.addImage({ key: 'noghost', filepath: '/missing/noghost.NEF', date_taken: '2024-01-01' });
    await runJob('batch_describe', { max_workers: 1 });
    const runAfterFirst = fx.query<{ run_id: number }>(
      'SELECT run_id FROM image_frame_substance WHERE image_key = ?',
      'noghost',
    )[0]?.run_id;
    expect(runAfterFirst).toBeTruthy();
    await runJob('batch_describe', { max_workers: 1 });
    expect(fx.query('SELECT run_id FROM image_frame_substance WHERE image_key = ?', 'noghost')[0]?.run_id).toBe(
      runAfterFirst,
    );
  });
});

describe('job result shape', () => {
  it('includes cull, held_back, durations_s and the held_back log line', async () => {
    await seedCullPhoto('pass', PASS);
    const job = await runJob('batch_describe', { max_workers: 1 });
    const r = job.result as JobCullResult;
    expect(r.cull).toBeTruthy();
    expect(r.held_back).toBeTruthy();
    expect(r.durations_s).toMatchObject({
      frame_substance: expect.any(Number),
      cull: expect.any(Number),
      describe: expect.any(Number),
      score: 0,
      total: expect.any(Number),
    });
    expect(job.logs.some((l) => l.message.includes('[cull] status=complete') && l.message.includes('held_back'))).toBe(
      true,
    );
  });
});

describe('cancel during cull step', () => {
  it('no kimi, checkpoint keeps failed_keys', async () => {
    await seedCullPhoto('a', PASS);
    await seedCullPhoto('b', PASS);
    await withJobsDb(async (db) => {
      const jobId = createJob(db, 'batch_describe', { max_workers: 1 });
      const runner = new JobRunner(db);
      fakeModels().cancelAfter = () => runner.signalCancel(jobId);
      await tick(db, runner);
      const job = getJob(db, jobId)!;
      expect(job.status).toBe('cancelled');
      expect(fakeModels().sequence.some((s) => s.startsWith('kimi:'))).toBe(false);
      expect((job.metadata.checkpoint as Record<string, unknown> | null)?.['cull']).toBeTruthy();
    });
  });
});
