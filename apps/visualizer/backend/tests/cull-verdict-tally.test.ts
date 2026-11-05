import { prepareKimiJobCull, resetKimiJobModels, writeKimiJobConfig, getKimiJobModels } from './helpers/kimi-job-models.js';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PhotoDecision } from '../src/cull/types.js';
import { addDecision, emptyVerdictTally } from '../src/cull/verdict-tally.js';
import { closeAppModels } from '../src/app-models/app-models.js';
import { createJob, getJob, initJobsDb } from '../src/db/jobs/jobs.js';
import type { Db } from '../src/db/connection.js';
import { openLibraryDb } from '../src/db/connection.js';
import { JobRunner } from '../src/jobs/runner.js';
import { tick } from '../src/jobs/processor.js';
import { BATCH_REDECIDE_JOB_TYPE } from '../src/jobs/handlers/redecide.js';
import { recordCullUserAction } from '../src/db/library/cull-user-actions.js';
import { createPipelineSettingVersion, getCurrentPipelineSetting } from '../src/db/library/cull-pipeline.js';
import { LibraryFixture } from './helpers/library-fixture.js';
import { writeFakePhoto, type FakeModelScript } from './helpers/fake-app-models.js';

function decision(overrides: Partial<PhotoDecision>): PhotoDecision {
  return {
    verdict: 'passed',
    filteredBy: null,
    filteredByStageKey: null,
    pendingStages: [],
    scoreForecastP8: null,
    sentByHandOverride: false,
    cullingProfileVerdict: null,
    stages: {},
    ...overrides,
  };
}

const PASS: FakeModelScript = { levels: [5, 5, 6, 6], p8: 0.5 };
const PROFILE_CUT: FakeModelScript = { levels: [5, 5, 2, 3], p8: 0.5 };

let fx: LibraryFixture;
let dir: string;
let jobsDbPath: string;
let server: Server | undefined;
let port: number;

async function bootFixture(): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'lt-verdict-tally-'));
  jobsDbPath = join(dir, 'visualizer.db');
  fx = new LibraryFixture().cullingStagesOn().addForecastQuestions().activate();
  resetKimiJobModels();
  process.env.DATABASE_PATH = jobsDbPath;
  if (!server) {
    await startServer();
    writeProviders();
  }
  const modelsDir = prepareKimiJobCull(fx.dbPath, dir);
  writeKimiJobConfig(dir, modelsDir);
  process.env.LT_PROVIDERS_JSON = join(dir, 'providers.json');
  process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
  fx.addPerspectives({ slug: 'street', prompt_markdown: '# street\nRUBRIC' });
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

async function seedPhoto(key: string, script: FakeModelScript): Promise<void> {
  const path = join(dir, 'vision', `${key}.jpg`);
  await writeFakePhoto(path, key);
  fx.addImage({ key, filepath: `/missing/${key}.NEF`, date_taken: '2024-01-01' }).addVisionCache(key, path);
  getKimiJobModels().scripts.set(key, script);
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

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    const httpServer = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'ok', subjects: ['x'] }) } }] }));
      });
    });
    server = httpServer;
    httpServer.listen(0, '127.0.0.1', () => {
      port = (httpServer.address() as { port: number }).port;
      resolve();
    });
  });
}

async function seedSentByHandTrio(opts: { sentByHandBeforeCull?: boolean } = {}): Promise<void> {
  await seedPhoto('plain', PASS);
  await seedPhoto('hand-pass', PASS);
  await seedPhoto('override', PROFILE_CUT);
  if (opts.sentByHandBeforeCull) {
    const lib = openLibraryDb(fx.dbPath);
    recordCullUserAction(lib, 'hand-pass', 'sent_by_hand');
    recordCullUserAction(lib, 'override', 'sent_by_hand');
    lib.close();
  }
}

describe('addDecision', () => {
  it('counts pending', () => {
    const tally = emptyVerdictTally();
    addDecision(tally, decision({ verdict: 'pending' }));
    expect(tally).toEqual({ ...emptyVerdictTally(), pending: 1 });
  });

  it('counts passed', () => {
    const tally = emptyVerdictTally();
    addDecision(tally, decision({ verdict: 'passed' }));
    expect(tally).toEqual({ ...emptyVerdictTally(), passed: 1 });
  });

  it('counts filtered by culling profile', () => {
    const tally = emptyVerdictTally();
    addDecision(
      tally,
      decision({ verdict: 'filtered', filteredBy: 'culling_profile', filteredByStageKey: 'culling_profile:default:7' }),
    );
    expect(tally).toEqual({ ...emptyVerdictTally(), filtered_by_culling_profile: 1 });
  });

  it('counts filtered by score forecast', () => {
    const tally = emptyVerdictTally();
    addDecision(tally, decision({ verdict: 'filtered', filteredBy: 'score_forecast', filteredByStageKey: 'score_forecast' }));
    expect(tally).toEqual({ ...emptyVerdictTally(), filtered_by_score_forecast: 1 });
  });

  it('counts sent-by-hand override separately from passed', () => {
    const tally = emptyVerdictTally();
    addDecision(tally, decision({ verdict: 'passed', sentByHandOverride: true }));
    expect(tally).toEqual({ ...emptyVerdictTally(), passed: 1, sent_by_hand_passed: 1 });
  });
});

describe('verdict tally in jobs', () => {
  beforeEach(async () => {
    await bootFixture();
  });

  afterEach(async () => {
    await closeAppModels();
    delete process.env.DATABASE_PATH;
    delete process.env.LT_PROVIDERS_JSON;
    delete process.env.LT_CONFIG_YAML;
    fx.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    if (server !== undefined) await new Promise((resolve) => server!.close(resolve));
  });

  it('standalone cull counts sent_by_hand_passed from stage override only', async () => {
    await seedSentByHandTrio({ sentByHandBeforeCull: true });
    const job = await runJob('batch_cull_photos_before_scoring');
    expect(job.status).toBe('completed');
    expect((job.result as Record<string, number>).sent_by_hand_passed).toBe(1);
  });

  it('re-decide matches standalone cull on the same photos', async () => {
    await seedSentByHandTrio({ sentByHandBeforeCull: true });
    await runJob('batch_cull_photos_before_scoring');
    const job = await runJob(BATCH_REDECIDE_JOB_TYPE);
    expect(job.status).toBe('completed');
    expect((job.result as Record<string, number>).sent_by_hand_passed).toBe(1);
  });

  it('describe in-job cull matches standalone cull on the same photos', async () => {
    await seedSentByHandTrio();
    await runJob('batch_cull_photos_before_scoring');
    const lib = openLibraryDb(fx.dbPath);
    recordCullUserAction(lib, 'hand-pass', 'sent_by_hand');
    recordCullUserAction(lib, 'override', 'sent_by_hand');
    createPipelineSettingVersion(lib, getCurrentPipelineSetting(lib).config);
    lib.close();
    const job = await runJob('batch_describe', { max_workers: 1 });
    expect(job.status).toBe('completed');
    const result = job.result as { cull?: Record<string, number>; held_back?: Record<string, number> };
    expect(result.cull?.sent_by_hand_passed).toBe(1);
    expect(result.held_back?.sent_by_hand_passed).toBe(1);
  });

  it('keeps today’s result JSON keys for cull, re-decide, and in-job cull / held_back', async () => {
    await seedSentByHandTrio();
    const cullKeys = Object.keys((await runJob('batch_cull_photos_before_scoring')).result as object);
    const redecideKeys = Object.keys((await runJob(BATCH_REDECIDE_JOB_TYPE)).result as object);
    const describe = (await runJob('batch_describe', { max_workers: 1 })).result as {
      cull?: object;
      held_back?: object;
    };
    expect(cullKeys.sort()).toEqual(
      [
        'culled',
        'durations_s',
        'failed',
        'filtered_by_culling_profile',
        'filtered_by_score_forecast',
        'models_started',
        'passed',
        'pending',
        'pipeline_setting_version',
        'redecided',
        'score_forecast',
        'seconds_per_photo',
        'sent_by_hand_passed',
        'stage_seconds',
        'stage_versions',
        'total',
      ].sort(),
    );
    expect(redecideKeys.sort()).toEqual(
      [
        'changed',
        'durations_s',
        'filtered_by_culling_profile',
        'filtered_by_score_forecast',
        'passed',
        'pending',
        'pipeline_setting_version',
        'sent_by_hand_passed',
        'stage_versions',
        'total',
      ].sort(),
    );
    expect(Object.keys(describe.cull ?? {}).sort()).toEqual(
      [
        'culled',
        'failed',
        'filtered_by_culling_profile',
        'filtered_by_score_forecast',
        'models_started',
        'passed',
        'pending',
        'pipeline_setting_version',
        'redecided',
        'score_forecast',
        'seconds_per_photo',
        'sent_by_hand_passed',
      ].sort(),
    );
    expect(Object.keys(describe.held_back ?? {}).sort()).toEqual(
      ['filtered_by_culling_profile', 'filtered_by_score_forecast', 'no_verdict', 'pending', 'sent_by_hand_passed', 'void'].sort(),
    );
  });
});
