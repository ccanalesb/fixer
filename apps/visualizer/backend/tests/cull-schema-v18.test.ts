/**
 * Library schema 18: the seeded culling profile's slug is `default`, everywhere a stage key or profile
 * slug is stored, and a culling profile names no model (each stage's model is in `culling_models`).
 * Answers, decisions, stage versions and their hashes are kept as they are.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLibraryDb, type Db } from '../src/db/connection.js';
import { initLibraryDb, LIBRARY_SCHEMA_VERSION } from '../src/db/library/bootstrap.js';
import { getCurrentPipelineSetting } from '../src/db/library/cull-pipeline.js';
import { DEFAULT_CULLING_PROFILE_SLUG } from '../src/db/library/cull-profiles.js';
import { factoryForecastQuestions, saveForecastQuestions } from '../src/db/library/score-forecast-questions.js';
import { resolveCurrentStages } from '../src/cull/stages.js';
import { seedCullingStagesOn } from './helpers/culling-stages.js';

const OLD = 'recipe-culling';
const MODELS = { culling_profile: 'culling-model@abc', score_forecast: 'forecast-model@def' };

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-cull-v18-'));
  path = join(dir, 'library.db');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const RUN_DETAIL = {
  lines: { laya_new: 2, profile: 4 },
  truncated_tail: { laya_new: false, profile: false },
  inserted: { [`culling_profile:${OLD}:7`]: 2, 'culling_profile:mine:7': 1, score_forecast: 2 },
  stage_versions: { [`culling_profile:${OLD}:10`]: 2, score_forecast: 3 },
  laya_seconds: { prep: 0, vision: 0 },
  laya_started: false,
  passed: 1,
};

/** Every stored slug at `default` taken back to the old one, plus a model column and a user's profile. */
function writeV17Library(): void {
  const db = initLibraryDb(path);
  seedCullingStagesOn(db);
  saveForecastQuestions(db, factoryForecastQuestions(db));
  const stages = resolveCurrentStages(db, getCurrentPipelineSetting(db).config, MODELS);
  const [seven] = stages;
  db.prepare("INSERT INTO cull_runs (kind, started_at, pipeline_setting_version, detail_json) VALUES ('job', 't', 1, ?)").run(
    JSON.stringify(RUN_DETAIL),
  );
  db.prepare(
    `INSERT INTO cull_stage_answers (image_key, stage_version_id, answers_json, verdict, decision_json,
       pipeline_setting_version, source, produced_by, run_id, answered_at, decided_at)
     VALUES ('a', ?, '{"x":[1]}', 'filtered', '{"d":1}', 1, 'job', 'this_app', 1, 'ta', 'td')`,
  ).run(seven!.versionId);
  db.prepare(
    `INSERT INTO cull_verdicts (image_key, verdict, filtered_by, filtered_by_stage_key, pending_stages, pipeline_setting_version, decided_at)
     VALUES ('a', 'filtered', 'culling_profile', ?, '[]', 1, 't'), ('b', 'pending', NULL, NULL, ?, 1, 't')`,
  ).run(seven!.stageKey, JSON.stringify(stages.map((s) => s.stageKey)));
  db.prepare('UPDATE lr_writeback_settings SET stars_profile_slug = ?').run(DEFAULT_CULLING_PROFILE_SLUG);
  db.exec(`
    ALTER TABLE cull_profiles ADD COLUMN model TEXT NOT NULL DEFAULT 'culling-model';
    INSERT INTO cull_profiles (slug, name, rule_json, created_at, updated_at) VALUES ('mine', 'Mine', '{}', 't', 't');
    UPDATE cull_profiles SET slug = '${OLD}', source_filename = '${OLD}.json' WHERE slug = 'default';
    UPDATE cull_stage_versions SET stage_key = replace(stage_key, ':default:', ':${OLD}:'), profile_slug = '${OLD}'
      WHERE profile_slug = 'default';
    UPDATE cull_verdicts SET filtered_by_stage_key = replace(filtered_by_stage_key, ':default:', ':${OLD}:'),
      pending_stages = replace(pending_stages, ':default:', ':${OLD}:');
    UPDATE cull_pipeline_settings SET config_json = replace(config_json, '"default"', '"${OLD}"');
    UPDATE lr_writeback_settings SET stars_profile_slug = '${OLD}';
  `);
  db.pragma('user_version = 17');
  db.close();
}

const kept = (db: Db) => ({
  answers: db.prepare('SELECT * FROM cull_stage_answers ORDER BY 1, 2').all(),
  versions: db.prepare('SELECT id, kind, level_set, model_id, questions_json, content_hash, is_current FROM cull_stage_versions ORDER BY id').all(),
  profileVersions: db.prepare('SELECT * FROM cull_profile_versions ORDER BY id').all(),
  verdicts: db.prepare('SELECT image_key, verdict, filtered_by, pipeline_setting_version FROM cull_verdicts ORDER BY 1').all(),
});

describe('library schema 18', () => {
  it('stores the seeded profile as default everywhere; answers, decisions and stage versions are kept', () => {
    writeV17Library();
    const before = openLibraryDb(path);
    const was = kept(before);
    before.close();

    const db = initLibraryDb(path);
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(LIBRARY_SCHEMA_VERSION);
      expect(kept(db)).toEqual(was);
      expect(db.prepare('SELECT slug, source_filename FROM cull_profiles ORDER BY id').all()).toEqual([
        { slug: 'default', source_filename: 'default.json' },
        { slug: 'mine', source_filename: null },
      ]);
      expect(db.prepare('SELECT stage_key, profile_slug FROM cull_stage_versions ORDER BY id').all()).toEqual([
        { stage_key: 'culling_profile:default:7', profile_slug: 'default' },
        { stage_key: 'culling_profile:default:10', profile_slug: 'default' },
        { stage_key: 'score_forecast', profile_slug: null },
      ]);
      expect(db.prepare('SELECT filtered_by_stage_key, pending_stages FROM cull_verdicts ORDER BY 1').all()).toEqual([
        {
          filtered_by_stage_key: null,
          pending_stages: '["culling_profile:default:7","culling_profile:default:10","score_forecast"]',
        },
        { filtered_by_stage_key: 'culling_profile:default:7', pending_stages: '[]' },
      ]);
      expect(getCurrentPipelineSetting(db).config.culling_profiles.map((p) => p.profile_slug)).toEqual(['default']);
      expect(db.prepare('SELECT stars_profile_slug FROM lr_writeback_settings').get()).toEqual({ stars_profile_slug: 'default' });
      const stages = resolveCurrentStages(db, getCurrentPipelineSetting(db).config, MODELS);
      expect(stages.map((s) => s.versionId)).toEqual([1, 2, 3]);
    } finally {
      db.close();
    }
  });

  it('rewrites run details in the current vocabulary', () => {
    writeV17Library();
    const db = initLibraryDb(path);
    try {
      const { detail_json } = db.prepare('SELECT detail_json FROM cull_runs').get() as { detail_json: string };
      expect(JSON.parse(detail_json)).toEqual({
        lines: { score_forecast: 2, profile: 4 },
        truncated_tail: { score_forecast: false, profile: false },
        inserted: { 'culling_profile:default:7': 2, 'culling_profile:mine:7': 1, score_forecast: 2 },
        stage_versions: { 'culling_profile:default:10': 2, score_forecast: 3 },
        passed: 1,
      });
    } finally {
      db.close();
    }
  });

  it('a culling profile names no model, as in a new library', () => {
    writeV17Library();
    initLibraryDb(path).close();
    const fresh = initLibraryDb(join(dir, 'new.db'));
    const db = openLibraryDb(path);
    try {
      const columns = (d: Db) => d.prepare('PRAGMA table_info(cull_profiles)').all();
      expect(columns(db)).toEqual(columns(fresh));
      expect(columns(db).map((c) => (c as { name: string }).name)).not.toContain('model');
    } finally {
      db.close();
      fresh.close();
    }
  });

  it('refuses when a profile of the user already has the slug default', () => {
    writeV17Library();
    const db = openLibraryDb(path);
    db.prepare("UPDATE cull_profiles SET slug = 'default' WHERE slug = 'mine'").run();
    db.close();
    expect(() => initLibraryDb(path)).toThrow(/a culling profile already has the slug default/);
  });
});
