/**
 * `/api/score-forecast-questions`: the Score forecast questions, edited like a culling profile's text,
 * and "Create questions from my perspectives".
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { REPO_ROOT } from '../src/config.js';
import type { ScoreForecastQuestion } from '../src/cull/forecast-questions.js';
import { initJobsDb, listJobs } from '../src/db/jobs/jobs.js';
import { LibraryFixture } from './helpers/library-fixture.js';

let fx: LibraryFixture;
let dir: string;
const app = createApp();

interface Body {
  questions: ScoreForecastQuestion[];
  version: number;
  perspectives: { slug: string; name: string }[];
}
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const get = async () => json<Body>(await app.request('/api/score-forecast-questions'));
const send = (method: 'PUT' | 'POST', path: string, body: unknown = {}) =>
  app.request(`/api/score-forecast-questions${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const markdown = (slug: string) => readFileSync(join(REPO_ROOT, 'prompts', 'perspectives', `${slug}.md`), 'utf8');

const question = (over: Partial<ScoreForecastQuestion> = {}): ScoreForecastQuestion => ({
  id: 'framing',
  name: 'Framing',
  perspective_slug: 'framing',
  instructions: 'How well does a framing device enclose the subject?',
  levels: Array.from({ length: 10 }, (_, i) => `level ${i + 1}`),
  optional: false,
  applies: null,
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-forecast-questions-'));
  process.env.DATABASE_PATH = join(dir, 'visualizer.db');
  fx = new LibraryFixture()
    .addPerspectives(
      { slug: 'framing', display_name: 'Framing', description: 'Framing devices.', prompt_markdown: markdown('framing'), optional: true },
      { slug: 'compositional-cleanliness', display_name: 'Compositional Cleanliness', description: 'Clean frames.', prompt_markdown: markdown('compositional-cleanliness') },
      { slug: 'environmental-context-legibility', display_name: 'Depth', description: 'Depth.', prompt_markdown: markdown('environmental-context-legibility') },
      { slug: 'intensity-suggestion', display_name: 'Charge', description: 'Charge.', prompt_markdown: markdown('intensity-suggestion') },
      { slug: 'street', display_name: 'Street', description: 'Street.', prompt_markdown: markdown('street'), active: false },
    )
    .activate();
});

afterEach(() => {
  delete process.env.DATABASE_PATH;
  fx.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/score-forecast-questions', () => {
  it('an empty library has none, and lists the perspectives a question can be tied to', async () => {
    const body = await get();
    expect(body.questions).toEqual([]);
    expect(body.version).toBe(0);
    expect(body.perspectives.map((p) => p.name)).toEqual(['Compositional Cleanliness', 'Depth', 'Framing', 'Charge', 'Street']);
  });
});

describe('POST /api/score-forecast-questions/from-perspectives', () => {
  it('four active perspectives, one optional: four questions and one "applies?" question', async () => {
    const res = await send('POST', '/from-perspectives');
    expect(res.status).toBe(200);
    const body = await json<Body & { skipped: string[] }>(res);
    expect(body.skipped).toEqual([]);
    expect(body.version).toBe(1);
    expect(body.questions.map((q) => [q.id, q.optional])).toEqual([
      ['compositional-cleanliness', false],
      ['environmental-context-legibility', false],
      ['framing', true],
      ['intensity-suggestion', false],
    ]);
    expect(await get()).toMatchObject({ version: 1 });
  });

  it('refuses when there are questions already', async () => {
    await send('POST', '/from-perspectives');
    const res = await send('POST', '/from-perspectives');
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toBe('There are Score forecast questions already');
  });
});

describe('PUT /api/score-forecast-questions', () => {
  it('saves a new version; the same questions again make none', async () => {
    const res = await send('PUT', '', { questions: [question()], mode: 'save_only' });
    expect(res.status).toBe(200);
    expect(await json<{ version: number; created: boolean; cull_job_id: string | null }>(res)).toMatchObject({
      version: 1,
      created: true,
      cull_job_id: null,
    });
    const again = await json<{ version: number; created: boolean }>(
      await send('PUT', '', { questions: [question()], mode: 'save_only' }),
    );
    expect(again).toMatchObject({ version: 1, created: false });
  });

  it('"Save and queue culling" queues a culling job', async () => {
    const res = await send('PUT', '', { questions: [question()], mode: 'save_and_queue_cull' });
    const body = await json<{ cull_job_id: string | null; impact: { photos: number } }>(res);
    expect(body.cull_job_id).toEqual(expect.any(String));
    expect(body.impact).toEqual({ photos: 0, hours_estimate: 0 });
    const jobs = initJobsDb(process.env.DATABASE_PATH!);
    try {
      expect(listJobs(jobs).map((j) => j.type)).toEqual(['batch_cull_photos_before_scoring']);
    } finally {
      jobs.close();
    }
  });

  it('names each problem by its field and saves nothing', async () => {
    const res = await send('PUT', '', {
      questions: [question({ instructions: '' }), question({ id: 'tied', perspective_slug: 'gone' })],
      mode: 'save_only',
    });
    expect(res.status).toBe(400);
    expect((await json<{ validation_errors: unknown[] }>(res)).validation_errors).toEqual([
      { field: 'framing.instructions', message: 'A question needs its text' },
      { field: 'tied.perspective_slug', message: 'There is no perspective gone' },
    ]);
    expect((await get()).version).toBe(0);
  });
});
