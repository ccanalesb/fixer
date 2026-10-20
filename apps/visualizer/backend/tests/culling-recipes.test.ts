/**
 * Culling recipes HTTP routes.
 */
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { initLibraryDb } from '../src/db/library/bootstrap.js';
import { getJob, getPendingJobs, initJobsDb } from '../src/db/jobs/jobs.js';
import { BATCH_CULL_JOB_TYPE } from '../src/jobs/handlers/cull.js';
import { BATCH_REDECIDE_JOB_TYPE } from '../src/jobs/handlers/redecide.js';
import { getCurrentPipelineSetting } from '../src/db/library/cull-pipeline.js';
import { LibraryFixture } from './helpers/library-fixture.js';

let fx: LibraryFixture;
let jobsDir: string;
let jobsDbPath: string;
const app = createApp();

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

function writeMinimalLaya(modelsDir: string): void {
  const base = join(modelsDir, 'laya-base');
  mkdirSync(join(base, 'tokenizer'), { recursive: true });
  writeFileSync(join(base, 'tokenizer', 'tokenizer.json'), JSON.stringify({ model: { vocab: { x: 1 } } }));
  writeFileSync(join(base, 'tokenizer', 'tokenizer_config.json'), '{}');
  writeFileSync(
    join(base, 'model.json'),
    JSON.stringify({
      temperature: [1, 1, 1],
      temperature_by_options: {},
      max_len: 512,
      head_max_len: 128,
      image_token_id: 1,
      pad_token_id: 0,
      prefix_ids: [1],
    }),
  );
}

beforeEach(() => {
  jobsDir = mkdtempSync(join(tmpdir(), 'lt-cull-recipes-jobs-'));
  jobsDbPath = join(jobsDir, 'visualizer.db');
  const modelsDir = join(jobsDir, 'models');
  writeMinimalLaya(modelsDir);
  writeFileSync(join(jobsDir, 'config.yaml'), `laya_models_dir: ${modelsDir}\n`);
  process.env.DATABASE_PATH = jobsDbPath;
  process.env.LT_CONFIG_YAML = join(jobsDir, 'config.yaml');
  fx = new LibraryFixture().activate();
  initLibraryDb(fx.dbPath);
});

afterEach(() => {
  delete process.env.DATABASE_PATH;
  delete process.env.LT_CONFIG_YAML;
  fx.cleanup();
  rmSync(jobsDir, { recursive: true, force: true });
});

describe('GET /api/culling-recipes/pipeline', () => {
  it('returns pipeline setting without matching a recipe slug', async () => {
    const res = await app.request('/api/culling-recipes/pipeline');
    expect(res.status).toBe(200);
    const body = await json<{ version: number; config: { score_forecast: { threshold: number } } }>(res);
    expect(body.version).toBeGreaterThan(0);
    expect(body.config.score_forecast.threshold).toBeDefined();
  });
});

describe('GET /api/culling-recipes/', () => {
  it('lists seeded recipe 7H47', async () => {
    const res = await app.request('/api/culling-recipes/');
    expect(res.status).toBe(200);
    const body = await json<{ recipes: { slug: string; in_pipeline: boolean }[] }>(res);
    expect(body.recipes.some((r) => r.slug === 'recipe-7h47' && r.in_pipeline)).toBe(true);
  });
});

describe('PUT /api/culling-recipes/{slug}/rule', () => {
  it('enqueues re-decide when pipeline version changes', async () => {
    const recipe = await json<{ rule: Record<string, unknown> }>(
      await app.request('/api/culling-recipes/recipe-7h47'),
    );
    const rule = { ...recipe.rule, combine: recipe.rule.combine === 'every' ? 'any' : 'every' };
    const res = await app.request('/api/culling-recipes/recipe-7h47/rule', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rule }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ pipeline_setting_version: number | null; redecide_job_id: string | null }>(res);
    expect(body.pipeline_setting_version).toBeGreaterThan(1);
    const jobsDb = initJobsDb(jobsDbPath);
    const pending = getPendingJobs(jobsDb).filter((j) => j.type === BATCH_REDECIDE_JOB_TYPE);
    jobsDb.close();
    expect(pending.length + (body.redecide_job_id ? 1 : 0)).toBeGreaterThan(0);
  });
});

type Recipe = {
  definition: { dimensions: { slug: string }[]; level_sets: { id: string; levels: Record<string, string[]> }[] };
  rule: { level_sets: Record<string, { fails_at_most: number; strong_at_least: number }> };
};

describe('PUT /api/culling-recipes/{slug}/definition', () => {
  it('save_only returns JSON with hours impact (F16)', async () => {
    const recipe = await json<{ definition: Record<string, unknown> }>(
      await app.request('/api/culling-recipes/recipe-7h47'),
    );
    const res = await app.request('/api/culling-recipes/recipe-7h47/definition', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definition: recipe.definition, mode: 'save_only' }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
    const body = JSON.parse(text) as { impact: { photos: number; hours_estimate: number } };
    expect(body.impact.photos).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(body.impact.hours_estimate)).toBe(true);
  });

  it('returns validation_errors when Laya rejects the definition', async () => {
    const baseModel = join(jobsDir, 'models', 'laya-base', 'model.json');
    writeFileSync(
      baseModel,
      JSON.stringify({
        temperature: [1, 1, 1],
        temperature_by_options: {},
        max_len: 20,
        head_max_len: 8,
        image_token_id: 1,
        pad_token_id: 0,
        prefix_ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      }),
    );
    const recipe = await json<{ definition: Record<string, unknown> }>(
      await app.request('/api/culling-recipes/recipe-7h47'),
    );
    const bad = structuredClone(recipe.definition) as {
      dimensions: { slug: string; name: string; question: string }[];
      level_sets: { id: string; levels: Record<string, string[]> }[];
    };
    bad.dimensions[0]!.question = 'This question is too long for the Laya row budget.';
    const res = await app.request('/api/culling-recipes/recipe-7h47/definition', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definition: bad, mode: 'save_only' }),
    });
    expect(res.status).toBe(400);
    const body = await json<{ validation_errors: { field: string; message: string }[] }>(res);
    expect(body.validation_errors.length).toBeGreaterThan(0);
  });

  it('save_and_queue_cull enqueues whole-catalog cull job', async () => {
    const recipe = await json<{ definition: Record<string, unknown> }>(
      await app.request('/api/culling-recipes/recipe-7h47'),
    );
    const res = await app.request('/api/culling-recipes/recipe-7h47/definition', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definition: recipe.definition, mode: 'save_and_queue_cull' }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ cull_job_id: string | null }>(res);
    expect(body.cull_job_id).toBeTruthy();
    const jobsDb = initJobsDb(jobsDbPath);
    const job = getJob(jobsDb, body.cull_job_id!);
    jobsDb.close();
    expect(job!.type).toBe(BATCH_CULL_JOB_TYPE);
    expect(job!.metadata).toEqual({});
  });

  const putDefinition = (body: unknown) =>
    app.request('/api/culling-recipes/recipe-7h47/definition', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('refuses an empty level text with its set|dimension|level field', async () => {
    const recipe = await json<Recipe>(await app.request('/api/culling-recipes/recipe-7h47'));
    const def = structuredClone(recipe.definition);
    const dim = def.dimensions[0]!.slug;
    def.level_sets[0]!.levels[dim]![2] = '  ';
    const res = await putDefinition({ definition: def, mode: 'save_only' });
    expect(res.status).toBe(400);
    const body = await json<{ validation_errors: { field: string }[] }>(res);
    expect(body.validation_errors.map((e) => e.field)).toEqual([`${def.level_sets[0]!.id}|${dim}|2`]);
  });

  it('saves a new level set together with its bands and re-decides on save_only', async () => {
    const recipe = await json<Recipe>(await app.request('/api/culling-recipes/recipe-7h47'));
    const def = structuredClone(recipe.definition);
    const src = def.level_sets[0]!;
    const levels = Object.fromEntries(Object.entries(src.levels).map(([k, v]) => [k, v.slice(0, 5)]));
    def.level_sets.push({ id: '5', levels });
    const rule = { ...recipe.rule, level_sets: { ...recipe.rule.level_sets, '5': { fails_at_most: 2, strong_at_least: 4 } } };

    const withoutBands = await putDefinition({ definition: def, mode: 'save_only' });
    expect(withoutBands.status).toBe(400);

    const res = await putDefinition({ definition: def, rule, mode: 'save_only' });
    expect(res.status).toBe(200);
    const saved = await json<Recipe>(await app.request('/api/culling-recipes/recipe-7h47'));
    expect(saved.definition.level_sets.map((s) => s.id)).toContain('5');
    expect(saved.rule.level_sets['5']).toEqual({ fails_at_most: 2, strong_at_least: 4 });
    const jobsDb = initJobsDb(jobsDbPath);
    const redecide = getPendingJobs(jobsDb).filter((j) => j.type === BATCH_REDECIDE_JOB_TYPE);
    jobsDb.close();
    expect(redecide.length).toBe(1);
  });
});

describe('PUT /api/culling-recipes/{slug}/rule bands', () => {
  it('refuses strong past the top level of a set', async () => {
    const recipe = await json<Recipe>(await app.request('/api/culling-recipes/recipe-7h47'));
    const [id, bands] = Object.entries(recipe.rule.level_sets)[0]!;
    const rule = { ...recipe.rule, level_sets: { ...recipe.rule.level_sets, [id]: { ...bands, strong_at_least: 99 } } };
    const res = await app.request('/api/culling-recipes/recipe-7h47/rule', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rule }),
    });
    expect(res.status).toBe(400);
    const body = await json<{ validation_errors: { field: string }[] }>(res);
    expect(body.validation_errors.map((e) => e.field)).toEqual([`bands|${id}`]);
  });
});

describe('PUT /api/culling-recipes/pipeline/score-forecast', () => {
  it('bumps pipeline version and enqueues re-decide', async () => {
    const before = getCurrentPipelineSetting(new Database(fx.dbPath)).version;
    const res = await app.request('/api/culling-recipes/pipeline/score-forecast', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threshold: 0.12 }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ version: number; redecide_job_id: string | null }>(res);
    expect(body.version).toBeGreaterThan(before);
    expect(body.redecide_job_id).toBeTruthy();
  });
});

describe('PATCH /api/culling-recipes/{slug}', () => {
  it('deactivate enqueues re-decide', async () => {
    const res = await app.request('/api/culling-recipes/recipe-7h47', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ active: false }),
    });
    expect(res.status).toBe(200);
    const jobsDb = initJobsDb(jobsDbPath);
    const pending = getPendingJobs(jobsDb).filter((j) => j.type === BATCH_REDECIDE_JOB_TYPE);
    jobsDb.close();
    expect(pending.length).toBeGreaterThan(0);
  });
});

describe('POST /api/culling-recipes/', () => {
  it('creates F19 minimal recipe with empty texts', async () => {
    const res = await app.request('/api/culling-recipes/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'new-minimal',
        name: 'New recipe',
        model: 'laya-base',
        definition: {
          dimensions: [{ slug: 'dimension-1', name: 'Dimension 1', question: '' }],
          level_sets: [{ id: '5', levels: { 'dimension-1': ['', '', '', '', ''] } }],
        },
        rule: {
          level_sets: { '5': { fails_at_most: 2, strong_at_least: 4 } },
          combine: 'any',
          cut_rule: { type: 'all_fail', dimensions: ['dimension-1'] },
        },
        active: false,
      }),
    });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
    expect(JSON.parse(text)).toMatchObject({ slug: 'new-minimal' });
  });

  it('creates a minimal recipe (F19)', async () => {
    const res = await app.request('/api/culling-recipes/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'my-recipe',
        name: 'My recipe',
        model: 'laya-base',
        definition: {
          dimensions: [{ slug: 'dimension-1', name: 'Dimension 1', question: 'Q?' }],
          level_sets: [{ id: '5', levels: { 'dimension-1': ['', '', '', '', ''] } }],
        },
        rule: {
          level_sets: { '5': { fails_at_most: 2, strong_at_least: 4 } },
          combine: 'any',
          cut_rule: { type: 'all_fail', dimensions: ['dimension-1'] },
        },
        active: false,
      }),
    });
    expect(res.status).toBe(201);
  });
});
