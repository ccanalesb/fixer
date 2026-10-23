/**
 * `cull-import`, on small fixtures in the answer files' line format:
 * synthetic keys and paths, real-shaped probabilities, a 7-level run appended after the 10-level one
 * and still being written.
 */
import { appendFileSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadLibraryConfig } from '../src/config.js';
import { run } from '../src/cli/main.js';
import { openLibraryDb, type Db } from '../src/db/connection.js';
import { importResearchRuns } from '../src/cull/import-research.js';
import { createPipelineSettingVersion, getCurrentPipelineSetting } from '../src/db/library/cull-pipeline.js';
import { LAYA_BASE_RESEARCH_MODEL_ID } from '../src/laya/model-id.js';
import { LibraryFixture } from './helpers/library-fixture.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'cull');
const MODEL_IDS = { base: LAYA_BASE_RESEARCH_MODEL_ID, new: 'laya-new@sha256:test' };
const KEYS = ['fx-001-pass', 'fx-002-profile', 'fx-003-forecast', 'fx-004-no7'];

let fx: LibraryFixture;
let dir: string;
let layaNewPath: string;
let profilePath: string;

beforeEach(() => {
  fx = new LibraryFixture().cullingStagesOn();
  fx.addImages(...KEYS);
  dir = mkdtempSync(join(tmpdir(), 'lt-cull-import-'));
  layaNewPath = join(dir, 'laya_new_catalog.jsonl');
  profilePath = join(dir, 'laya_cull_catalog_all.jsonl');
  copyFileSync(join(FIXTURES, 'laya_new_catalog.sample.jsonl'), layaNewPath);
  copyFileSync(join(FIXTURES, 'laya_cull_catalog_all.sample.jsonl'), profilePath);
});

afterEach(() => {
  fx.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const db = openLibraryDb(fx.dbPath);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

const importAll = (dryRun = false) =>
  withDb((db) => importResearchRuns(db, { layaNewPath, profilePath, modelIds: MODEL_IDS, dryRun }));

const verdicts = () =>
  fx.query<{ image_key: string; verdict: string; filtered_by: string | null }>(
    'SELECT image_key, verdict, filtered_by FROM cull_verdicts ORDER BY image_key',
  );

describe('cull-import', () => {
  it('stores both files under the stages a job would use, and decides every photo', async () => {
    const r = await importAll();
    expect(r).toMatchObject({
      photos: 4,
      missing_from_library: 1,
      missing_keys_sample: ['fx-999-not-in-db'],
      truncated_tail: { profile: true, laya_new: false },
      inserted: {
        'culling_profile:recipe-culling:10': 4,
        'culling_profile:recipe-culling:7': 3,
        score_forecast: 4,
      },
      verdicts: { filtered_by_culling_profile: 1, filtered_by_score_forecast: 1, pending: 1, passed: 1 },
    });
    expect(verdicts()).toEqual([
      { image_key: 'fx-001-pass', verdict: 'passed', filtered_by: null },
      { image_key: 'fx-002-profile', verdict: 'filtered', filtered_by: 'culling_profile' },
      // Ticket 15's example: the profile passes it, the Score forecast (0.036) filters it.
      { image_key: 'fx-003-forecast', verdict: 'filtered', filtered_by: 'score_forecast' },
      // No 7-level answer: the profile cannot filter it yet.
      { image_key: 'fx-004-no7', verdict: 'pending', filtered_by: null },
    ]);
    expect(fx.query("SELECT COUNT(*) AS n FROM cull_stage_answers WHERE image_key = 'fx-999-not-in-db'")).toEqual([{ n: 0 }]);
  });

  it('rebuilds the framing excusal and marks the rows as imported', async () => {
    await importAll();
    const [row] = fx.query<{ answers_json: string; source: string; produced_by: string; model_id: string; image_path: string }>(
      `SELECT a.answers_json, a.source, a.produced_by, v.model_id, a.image_path FROM cull_stage_answers a
       JOIN cull_stage_versions v ON v.id = a.stage_version_id
       WHERE a.image_key = 'fx-003-forecast' AND v.stage_key = 'score_forecast'`,
    );
    const answers = JSON.parse(row!.answers_json) as Record<string, number[]>;
    expect(answers['framing-excusal']![0]).toBeCloseTo(0.8);
    expect(answers['framing-excusal']![1]).toBeCloseTo(0.2);
    expect(Object.keys(answers).sort()).toEqual([
      'compositional-cleanliness',
      'environmental-context-legibility',
      'framing',
      'framing-excusal',
      'intensity-suggestion',
    ]);
    expect(row).toMatchObject({ source: 'research_import', model_id: MODEL_IDS.new, image_path: '/research/vision/fx-003-forecast.jpg' });
    expect(row!.produced_by).toContain('research');
    const [base] = fx.query<{ model_id: string }>(
      "SELECT model_id FROM cull_stage_versions WHERE stage_key = 'culling_profile:recipe-culling:7'",
    );
    expect(base!.model_id).toBe(LAYA_BASE_RESEARCH_MODEL_ID);
    expect(fx.query("SELECT kind, finished_at IS NOT NULL AS finished FROM cull_runs")).toEqual([
      { kind: 'research_import', finished: 1 },
    ]);
  });

  it('a second import writes nothing; after the 7-level run ends it adds only the new answers', async () => {
    await importAll();
    const again = await importAll();
    expect(again.inserted).toEqual({});
    expect(again.already_stored).toMatchObject({ 'culling_profile:recipe-culling:10': 4, score_forecast: 4 });

    // The run finishes: the half-written line is complete and fx-004 has its 7-level answers.
    const lines = (await import('node:fs')).readFileSync(profilePath, 'utf8').split('\n');
    lines.pop();
    const sevenLevels = Object.fromEntries(
      ['immediate-impact', 'visual-structure', 'point-of-tension', 'connotation'].map((d, i) => [
        `7|${d}`,
        { probabilities: i < 2 ? [0, 0, 0, 1, 0, 0, 0] : [0, 1, 0, 0, 0, 0, 0] },
      ]),
    );
    writeFileSync(profilePath, lines.join('\n') + '\n');
    appendFileSync(
      profilePath,
      JSON.stringify({ key: 'fx-004-no7', image: '/research/vision/fx-004-no7.jpg', copied_from: null, answers: sevenLevels }) + '\n',
    );
    const done = await importAll();
    expect(done.inserted).toEqual({ 'culling_profile:recipe-culling:7': 1 });
    expect(done.truncated_tail.profile).toBe(false);
    expect(verdicts().find((v) => v.image_key === 'fx-004-no7')).toEqual({
      image_key: 'fx-004-no7',
      verdict: 'filtered',
      filtered_by: 'culling_profile',
    });
  });

  it('a later incomplete Laya new line keeps the earlier complete answer; incomplete photos are counted once', async () => {
    const partialLine = { key: 'fx-001-pass', image: '/research/vision/fx-001-pass.jpg', rows: [{ slug: 'framing', probs: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0] }] };
    appendFileSync(layaNewPath, JSON.stringify(partialLine) + '\n' + JSON.stringify(partialLine) + '\n');
    const r = await importAll();
    expect(r.inserted['score_forecast']).toBe(4);
    // fx-001 still has its complete answer, so it is not counted as incomplete.
    expect(r.partial).toBe(0);
    appendFileSync(layaNewPath, JSON.stringify({ ...partialLine, key: 'fx-new-partial' }) + '\n');
    expect((await importAll()).partial).toBe(1);
    expect(verdicts().find((v) => v.image_key === 'fx-001-pass')!.verdict).toBe('passed');
  });

  it('never overwrites answers a job stored', async () => {
    await importAll();
    fx.exec("UPDATE cull_stage_answers SET source = 'job', answers_json = '{\"kept\":[1]}' WHERE image_key = 'fx-001-pass'");
    await importAll();
    expect(fx.query("SELECT DISTINCT answers_json FROM cull_stage_answers WHERE image_key = 'fx-001-pass'")).toEqual([
      { answers_json: '{"kept":[1]}' },
    ]);
  });

  it('refuses a malformed line that is not the last one, and writes nothing', async () => {
    writeFileSync(layaNewPath, '{"key": "x", broken\n{"key": "fx-001-pass", "image": "a", "rows": []}\n');
    await expect(importAll()).rejects.toThrow(/line 1 is not JSON/);
    expect(fx.query("SELECT name FROM sqlite_master WHERE name = 'cull_stage_answers'")).toHaveLength(1);
    expect(fx.query('SELECT COUNT(*) AS n FROM cull_stage_answers')).toEqual([{ n: 0 }]);
  });

  it('a dry run reports the same and writes nothing', async () => {
    const r = await importAll(true);
    expect(r.inserted['score_forecast']).toBe(4);
    expect(r.run_id).toBeNull();
    expect(fx.query('SELECT COUNT(*) AS n FROM cull_stage_answers')).toEqual([{ n: 0 }]);
    expect(fx.query('SELECT COUNT(*) AS n FROM cull_pipeline_settings')).toEqual([{ n: 1 }]);
  });

  it('refuses while the Score forecast is off, saying where to turn it on, and writes no answer', async () => {
    await withDb(async (db) => {
      const { config } = getCurrentPipelineSetting(db);
      createPipelineSettingVersion(db, { ...config, score_forecast: { ...config.score_forecast, enabled: false } });
    });
    await expect(importAll()).rejects.toThrow(
      'the Score forecast is off; turn it on in Processing → Settings → Culling models, then import',
    );
    expect(fx.query('SELECT COUNT(*) AS n FROM cull_stage_answers')).toEqual([{ n: 0 }]);
  });

  it('refuses a new library, where both stages start off', async () => {
    const fresh = new LibraryFixture();
    const db = openLibraryDb(fresh.dbPath);
    try {
      await expect(importResearchRuns(db, { layaNewPath, profilePath, modelIds: MODEL_IDS, dryRun: false })).rejects.toThrow(
        'the culling profile and the Score forecast are off; turn them on in Processing → Settings → Culling models, then import',
      );
    } finally {
      db.close();
      fresh.cleanup();
    }
  });

  it('refuses when the profile text is no longer the one the answers were asked', async () => {
    await withDb(async (db) => {
      const { seedCullingDefaults, getCullProfile, saveProfileDefinition } = await import('../src/db/library/cull-profiles.js');
      seedCullingDefaults(db);
      const def = structuredClone(getCullProfile(db, 'recipe-culling')!.definition);
      def.dimensions[0]!.question = 'Something else';
      saveProfileDefinition(db, 'recipe-culling', def);
    });
    await expect(importAll()).rejects.toThrow(/profile's text is no longer the one these answers were asked/);
  });

  it('into a library with no Score forecast questions it stores the ones the answers were asked', async () => {
    await importAll();
    const { getForecastQuestions } = await import('../src/db/library/score-forecast-questions.js');
    const ids = await withDb(async (db) => getForecastQuestions(db).questions.map((q) => q.id));
    expect(ids).toEqual(['framing', 'compositional-cleanliness', 'environmental-context-legibility', 'intensity-suggestion']);
  });

  it('refuses when the Score forecast questions are no longer the ones the answers were asked', async () => {
    await withDb(async (db) => {
      const { saveForecastQuestions, layaNewForecastQuestions } = await import('../src/db/library/score-forecast-questions.js');
      saveForecastQuestions(
        db,
        layaNewForecastQuestions(db).map((q) => (q.id === 'framing' ? { ...q, instructions: 'Something else' } : q)),
      );
    });
    await expect(importAll()).rejects.toThrow(/Score forecast questions are no longer the ones these answers were asked/);
    expect(fx.query('SELECT COUNT(*) AS n FROM cull_stage_answers')).toEqual([{ n: 0 }]);
  });

  it('the CLI prints the counts', async () => {
    const lines: string[] = [];
    const config = loadLibraryConfig('/nonexistent/config.yaml');
    const code = await run(
      ['cull-import', '--db', fx.dbPath, '--laya-new', layaNewPath, '--culling-profile', profilePath, '--laya-new-model-id', 'm', '--dry-run'],
      { out: (l) => lines.push(l), config },
    );
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('Dry run');
    expect(text).toContain('Photos: 4 in the library, 1 not in it');
    expect(text).toContain('culling_profile:recipe-culling:7: 3 new, 0 already stored');
    expect(text).toContain('Verdicts: filtered by the culling profile 1, filtered by the Score forecast 1, pending 1, passed 1');
  });

  it('the CLI needs both files and a database', async () => {
    const lines: string[] = [];
    const config = loadLibraryConfig('/nonexistent/config.yaml');
    expect(await run(['cull-import', '--db', fx.dbPath], { out: (l) => lines.push(l), config })).toBe(1);
    expect(lines.join('\n')).toContain('--laya-new');
    const missingDb = await run(
      ['cull-import', '--db', join(dir, 'nope.db'), '--laya-new', layaNewPath, '--culling-profile', profilePath, '--laya-new-model-id', 'm'],
      { out: (l) => lines.push(l), config },
    );
    expect(missingDb).toBe(1);
    expect(lines.join('\n')).toContain('Database not found');
  });
});
