/**
 * Library schema 13: the cull vocabulary renamed in `library.db` — culling profile,
 * filtered / passed — keeping every verdict, answer, pipeline setting, Lightroom write-back row and
 * content hash, so no stage version reads as stale.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLibraryDb, type Db } from '../src/db/connection.js';
import { initLibraryDb, LIBRARY_SCHEMA_VERSION, upgradeLibrarySchema } from '../src/db/library/bootstrap.js';
import { getCurrentPipelineSetting } from '../src/db/library/cull-pipeline.js';
import { stageContentHash } from '../src/db/library/cull-stages.js';
import { resolveCurrentStages } from '../src/cull/stages.js';
import { LAYA_QUESTIONS } from '../src/laya/questions.js';

const V12_SQL = readFileSync(join(import.meta.dirname, 'fixtures', 'cull', 'schema-v12.sql'), 'utf8');
const MODEL_IDS = { culling_profile: 'thaitea/laya-vision@8b318c9', score_forecast: 'laya-new@sha256:abc' };
const NOW = '2026-10-20T00:00:00Z';

const DEFINITION = {
  dimensions: [
    { slug: 'point-of-tension', name: 'Point of tension', question: 'Is there a point of tension?' },
    { slug: 'connotation', name: 'Connotation', question: 'Does it connote something?' },
  ],
  level_sets: [
    {
      id: '7',
      levels: {
        'point-of-tension': ['none', 'some', 'strong'],
        connotation: ['none', 'some', 'strong'],
      },
    },
  ],
};
const RULE_V12 = {
  level_sets: { '7': { fails_at_most: 1, strong_at_least: 3 } },
  combine: 'every',
  cut_rule: { type: 'all_fail', dimensions: ['point-of-tension', 'connotation'] },
  stars_strong_from: '7',
};
const RULE_V13 = {
  level_sets: { '7': { fails_at_most: 1, strong_at_least: 3 } },
  combine: 'every',
  filter_rule: { type: 'all_fail', dimensions: ['point-of-tension', 'connotation'] },
  stars_strong_from: '7',
};
const MINE_RULE_V12 = { level_sets: { '7': { fails_at_most: 2, strong_at_least: 3 } }, combine: 'any', cut_rule: { type: 'n_fail_unless_strong', n: 2 } };
const MINE_RULE_V13 = { level_sets: { '7': { fails_at_most: 2, strong_at_least: 3 } }, combine: 'any', filter_rule: { type: 'n_fail_unless_strong', n: 2 } };

const PROFILE_QUESTIONS = Object.fromEntries(
  DEFINITION.dimensions.map((d) => [
    `7|${d.slug}`,
    { type: 'score', instructions: d.question, criteria: DEFINITION.level_sets[0]!.levels[d.slug as 'connotation'] },
  ]),
);
const PROFILE_HASH = stageContentHash({ modelId: MODEL_IDS.culling_profile, questions: PROFILE_QUESTIONS as never });
const OLD_PROFILE_HASH = stageContentHash({ modelId: 'old-model', questions: PROFILE_QUESTIONS as never });
const FORECAST_HASH = stageContentHash({ modelId: MODEL_IDS.score_forecast, questions: LAYA_QUESTIONS.new });

const ANSWERS_A = '{"point-of-tension":[0.7,0.2,0.1],"connotation":[0.6,0.3,0.1]}';
const ANSWERS_B = '{"point-of-tension":[0.1,0.2,0.7],"connotation":[0.1,0.3,0.6]}';
const FORECAST_ANSWERS = '{"framing":[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]}';
const DECISION_A =
  '{"level_set":"7","bands":{"fails_at_most":1,"strong_at_least":3},"cut_rule":{"type":"all_fail","dimensions":["point-of-tension","connotation"]},"readout":{}}';

const pipelineV12 = (threshold: number, runAfterCut: boolean) =>
  JSON.stringify({
    culling_recipes: [{ recipe_slug: 'recipe-7h47', rule: RULE_V12, run_after_cut: runAfterCut }],
    score_forecast: { enabled: true, threshold, high_from_level: 8, excused_at: 0.5, run_after_cut: true },
  });

/** A v12 library the way the real one looks: the factory profile, one of the user's, every verdict kind. */
function writeV12Library(path: string): void {
  const db = initLibraryDb(path);
  const old = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'cull_%' OR name LIKE 'lr_writeback_%')")
    .all() as { name: string }[];
  db.pragma('foreign_keys = OFF');
  for (const { name } of old) db.exec(`DROP TABLE ${name}`);
  db.pragma('foreign_keys = ON');
  db.exec(V12_SQL);
  const run = (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params);

  run(
    `INSERT INTO cull_recipes (id, slug, name, model, active, rule_json, measured, source_filename, created_at, updated_at)
     VALUES (1, 'recipe-7h47', 'Recipe 7H47', 'laya-base', 1, ?, 1, 'recipe-7h47.json', ?, ?)`,
    JSON.stringify(RULE_V12), NOW, NOW,
  );
  run(
    `INSERT INTO cull_recipes (id, slug, name, model, active, rule_json, measured, source_filename, created_at, updated_at)
     VALUES (2, 'mine', 'Mine', 'laya-base', 0, ?, 0, NULL, ?, ?)`,
    JSON.stringify(MINE_RULE_V12), NOW, NOW,
  );
  run(
    `INSERT INTO cull_recipe_versions (id, recipe_id, version, definition_json, content_hash, is_current, created_at)
     VALUES (1, 1, 1, ?, 'def-hash-1', 1, ?), (2, 2, 1, ?, 'def-hash-2', 1, ?)`,
    JSON.stringify(DEFINITION), NOW, JSON.stringify(DEFINITION), NOW,
  );
  const stage = `INSERT INTO cull_stage_versions
    (id, stage_key, kind, recipe_slug, level_set, model_id, questions_json, content_hash, is_current, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  run(stage, 1, 'culling_recipe:recipe-7h47:7', 'culling_recipe', 'recipe-7h47', '7', MODEL_IDS.culling_profile, JSON.stringify(PROFILE_QUESTIONS), PROFILE_HASH, 1, NOW);
  run(stage, 2, 'culling_recipe:recipe-7h47:7', 'culling_recipe', 'recipe-7h47', '7', 'old-model', JSON.stringify(PROFILE_QUESTIONS), OLD_PROFILE_HASH, 0, NOW);
  run(stage, 3, 'score_forecast', 'score_forecast', null, null, MODEL_IDS.score_forecast, JSON.stringify(LAYA_QUESTIONS.new), FORECAST_HASH, 1, NOW);
  run(
    `INSERT INTO cull_runs (run_id, kind, job_id, started_at, finished_at, pipeline_setting_version, detail_json)
     VALUES (1, 'job', 'j1', ?, ?, 2, '{"cut_by_culling_recipe":1,"sent":2}')`,
    NOW, NOW,
  );
  const answer = `INSERT INTO cull_stage_answers
    (image_key, stage_version_id, answers_json, verdict, decision_json, pipeline_setting_version, source, produced_by,
     image_path, image_signature, run_id, answered_at, decided_at)
    VALUES (?, ?, ?, ?, ?, 2, 'job', 'research (PyTorch); recipe copied from ticket08', '/p.jpg', '1:2', 1, ?, ?)`;
  run(answer, 'a', 1, ANSWERS_A, 'cut', DECISION_A, NOW, NOW);
  run(answer, 'b', 1, ANSWERS_B, 'sent', DECISION_A.replace('"readout":{}', '"readout":{"x":1}'), NOW, NOW);
  run(answer, 'a', 3, FORECAST_ANSWERS, 'sent', '{"highest_p8":0.5,"threshold":0.2,"framing_excused":false}', NOW, NOW);
  run(answer, 'c', 2, ANSWERS_A, 'cut', DECISION_A, NOW, NOW);
  const verdict = `INSERT INTO cull_verdicts
    (image_key, verdict, cut_by, cut_by_stage_key, sent_by_hand, pending_stages, pending_reason, score_forecast_off,
     score_forecast_p8, pipeline_setting_version, stage_version_ids, run_id, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 2, '[1,3]', 1, ?)`;
  run(verdict, 'a', 'cut', 'culling_recipe', 'culling_recipe:recipe-7h47:7', 0, '[]', '', 0.5, NOW);
  run(verdict, 'b', 'sent', null, null, 0, '[]', '', 0.4, NOW);
  run(verdict, 'c', 'pending', null, null, 0, '["culling_recipe:recipe-7h47:7","score_forecast"]', 'no_image', null, NOW);
  run(verdict, 'd', 'cut', 'score_forecast', 'score_forecast', 0, '[]', '', 0.05, NOW);
  run(verdict, 'e', 'sent', null, null, 1, '[]', '', 0.01, NOW);
  const action = `INSERT INTO cull_user_actions
    (id, image_key, action, acted_at, answered_verdict, answered_cut_by, answered_pipeline_setting_version, answered_stage_version_ids)
    VALUES (?, ?, ?, ?, ?, ?, 2, '[1,3]')`;
  run(action, 1, 'a', 'agrees_with_cut', NOW, 'cut', 'culling_recipe');
  run(action, 2, 'b', 'should_have_been_cut', NOW, 'sent', null);
  run(action, 3, 'e', 'sent_by_hand', NOW, 'cut', 'score_forecast');
  run(action, 4, 'f', 'sent_by_hand', NOW, 'none', null);
  run(action, 5, 'c', 'agrees_with_cut', NOW, 'pending', null);
  run(
    `INSERT INTO cull_pipeline_settings (version, config_json, is_current, created_at, note)
     VALUES (1, ?, 0, ?, 'default'), (2, ?, 1, ?, 'rule of recipe-7h47 changed')`,
    pipelineV12(0.111, true), NOW, pipelineV12(0.2, false), NOW,
  );
  run("UPDATE lr_writeback_settings SET write_stars = 1, write_reject = 1, stars_recipe_slug = 'recipe-7h47' WHERE id = 1");
  run(
    `INSERT INTO lr_writeback_state
       (image_key, kind, status, before_pick, before_rating, written_pick, written_rating, stars_recipe_version_id, updated_at, written_at)
     VALUES ('a', 'reject', 'written', 0, 0, -1, NULL, NULL, ?, ?), ('b', 'stars', 'written', 0, 0, NULL, 2, 1, ?, ?)`,
    NOW, NOW, NOW, NOW,
  );
  db.pragma('user_version = 12');
  db.close();
}

const all = (d: Db, sql: string) => d.prepare(sql).all() as Record<string, unknown>[];
const columns = (d: Db, table: string) =>
  (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number; pk: number }[]).map(
    (c) => `${c.name} ${c.type} ${c.notnull} ${c.pk}`,
  );
const schemaOf = (d: Db) =>
  (
    d
      .prepare(
        "SELECT type, name, tbl_name FROM sqlite_master WHERE name LIKE 'cull_%' OR name LIKE 'lr_writeback_%' OR tbl_name LIKE 'cull_%' OR tbl_name LIKE 'lr_writeback_%' ORDER BY type, name",
      )
      .all() as { type: string; name: string; tbl_name: string }[]
  ).map((r) => ({ ...r, columns: r.type === 'table' ? columns(d, r.name) : [] }));

let dir: string;
let path: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-cull-v13-'));
  path = join(dir, 'library.db');
  writeV12Library(path);
  db = initLibraryDb(path);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('library schema 13', () => {
  it('has the same cull and write-back tables, columns and indexes as a fresh library', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(LIBRARY_SCHEMA_VERSION);
    const fresh = initLibraryDb(join(dir, 'fresh.db'));
    try {
      expect(schemaOf(db)).toEqual(schemaOf(fresh));
    } finally {
      fresh.close();
    }
    expect(schemaOf(db).filter((r) => r.type === 'table').map((r) => r.name)).toEqual([
      'cull_pipeline_settings',
      'cull_profile_versions',
      'cull_profiles',
      'cull_runs',
      'cull_stage_answers',
      'cull_stage_versions',
      'cull_user_actions',
      'cull_verdicts',
      'lr_writeback_settings',
      'lr_writeback_state',
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('renames culling recipes to culling profiles; the factory one becomes Recipe culling, then (v16) the Default culling profile', () => {
    expect(all(db, 'SELECT id, slug, name, active, measured, source_filename, rule_json FROM cull_profiles ORDER BY id')).toEqual([
      { id: 1, slug: 'recipe-culling', name: 'Default culling profile', active: 1, measured: 1, source_filename: 'recipe-culling.json', rule_json: JSON.stringify(RULE_V13) },
      { id: 2, slug: 'mine', name: 'Mine', active: 0, measured: 0, source_filename: null, rule_json: JSON.stringify(MINE_RULE_V13) },
    ]);
    expect(all(db, 'SELECT id, profile_id, version, definition_json, content_hash, is_current FROM cull_profile_versions ORDER BY id')).toEqual([
      { id: 1, profile_id: 1, version: 1, definition_json: JSON.stringify(DEFINITION), content_hash: 'def-hash-1', is_current: 1 },
      { id: 2, profile_id: 2, version: 1, definition_json: JSON.stringify(DEFINITION), content_hash: 'def-hash-2', is_current: 1 },
    ]);
  });

  it('keeps every stage version and content hash, under culling_profile stage keys', () => {
    expect(all(db, 'SELECT id, stage_key, kind, profile_slug, level_set, model_id, content_hash, is_current FROM cull_stage_versions ORDER BY id')).toEqual([
      { id: 1, stage_key: 'culling_profile:recipe-culling:7', kind: 'culling_profile', profile_slug: 'recipe-culling', level_set: '7', model_id: MODEL_IDS.culling_profile, content_hash: PROFILE_HASH, is_current: 1 },
      { id: 2, stage_key: 'culling_profile:recipe-culling:7', kind: 'culling_profile', profile_slug: 'recipe-culling', level_set: '7', model_id: 'old-model', content_hash: OLD_PROFILE_HASH, is_current: 0 },
      { id: 3, stage_key: 'score_forecast', kind: 'score_forecast', profile_slug: null, level_set: null, model_id: MODEL_IDS.score_forecast, content_hash: FORECAST_HASH, is_current: 1 },
    ]);
  });

  it('no stage version becomes stale: resolving the current pipeline reuses the stored versions', () => {
    const stages = resolveCurrentStages(db, getCurrentPipelineSetting(db).config, MODEL_IDS);
    expect(stages.map((s) => [s.stageKey, s.versionId])).toEqual([
      ['culling_profile:recipe-culling:7', 1],
      ['score_forecast', 3],
    ]);
    expect(all(db, 'SELECT COUNT(*) AS n FROM cull_stage_versions')).toEqual([{ n: 3 }]);
  });

  it('keeps every answer byte for byte; stage verdicts become filtered / passed', () => {
    expect(
      all(db, 'SELECT image_key, stage_version_id, answers_json, verdict, decision_json, produced_by FROM cull_stage_answers ORDER BY image_key, stage_version_id'),
    ).toEqual([
      { image_key: 'a', stage_version_id: 1, answers_json: ANSWERS_A, verdict: 'filtered', decision_json: DECISION_A.replace('"cut_rule"', '"filter_rule"'), produced_by: 'research (PyTorch); recipe copied from ticket08' },
      { image_key: 'a', stage_version_id: 3, answers_json: FORECAST_ANSWERS, verdict: 'passed', decision_json: '{"highest_p8":0.5,"threshold":0.2,"framing_excused":false}', produced_by: 'research (PyTorch); recipe copied from ticket08' },
      { image_key: 'b', stage_version_id: 1, answers_json: ANSWERS_B, verdict: 'passed', decision_json: DECISION_A.replace('"cut_rule"', '"filter_rule"').replace('"readout":{}', '"readout":{"x":1}'), produced_by: 'research (PyTorch); recipe copied from ticket08' },
      { image_key: 'c', stage_version_id: 2, answers_json: ANSWERS_A, verdict: 'filtered', decision_json: DECISION_A.replace('"cut_rule"', '"filter_rule"'), produced_by: 'research (PyTorch); recipe copied from ticket08' },
    ]);
  });

  it('keeps every photo verdict: filtered by the culling profile or the Score forecast, passed, pending', () => {
    expect(
      all(db, `SELECT image_key, verdict, filtered_by, filtered_by_stage_key, sent_by_hand, pending_stages, pending_reason,
                      score_forecast_p8, pipeline_setting_version, stage_version_ids, run_id FROM cull_verdicts ORDER BY image_key`),
    ).toEqual([
      { image_key: 'a', verdict: 'filtered', filtered_by: 'culling_profile', filtered_by_stage_key: 'culling_profile:recipe-culling:7', sent_by_hand: 0, pending_stages: '[]', pending_reason: '', score_forecast_p8: 0.5, pipeline_setting_version: 2, stage_version_ids: '[1,3]', run_id: 1 },
      { image_key: 'b', verdict: 'passed', filtered_by: null, filtered_by_stage_key: null, sent_by_hand: 0, pending_stages: '[]', pending_reason: '', score_forecast_p8: 0.4, pipeline_setting_version: 2, stage_version_ids: '[1,3]', run_id: 1 },
      { image_key: 'c', verdict: 'pending', filtered_by: null, filtered_by_stage_key: null, sent_by_hand: 0, pending_stages: '["culling_profile:recipe-culling:7","score_forecast"]', pending_reason: 'no_image', score_forecast_p8: null, pipeline_setting_version: 2, stage_version_ids: '[1,3]', run_id: 1 },
      { image_key: 'd', verdict: 'filtered', filtered_by: 'score_forecast', filtered_by_stage_key: 'score_forecast', sent_by_hand: 0, pending_stages: '[]', pending_reason: '', score_forecast_p8: 0.05, pipeline_setting_version: 2, stage_version_ids: '[1,3]', run_id: 1 },
      { image_key: 'e', verdict: 'passed', filtered_by: null, filtered_by_stage_key: null, sent_by_hand: 1, pending_stages: '[]', pending_reason: '', score_forecast_p8: 0.01, pipeline_setting_version: 2, stage_version_ids: '[1,3]', run_id: 1 },
    ]);
  });

  it('keeps every user action and the verdict it answered', () => {
    expect(
      all(db, 'SELECT id, image_key, action, answered_verdict, answered_filtered_by, answered_pipeline_setting_version FROM cull_user_actions ORDER BY id'),
    ).toEqual([
      { id: 1, image_key: 'a', action: 'agrees_with_filter', answered_verdict: 'filtered', answered_filtered_by: 'culling_profile', answered_pipeline_setting_version: 2 },
      { id: 2, image_key: 'b', action: 'should_have_been_filtered', answered_verdict: 'passed', answered_filtered_by: null, answered_pipeline_setting_version: 2 },
      { id: 3, image_key: 'e', action: 'sent_by_hand', answered_verdict: 'filtered', answered_filtered_by: 'score_forecast', answered_pipeline_setting_version: 2 },
      { id: 4, image_key: 'f', action: 'sent_by_hand', answered_verdict: 'none', answered_filtered_by: null, answered_pipeline_setting_version: 2 },
      { id: 5, image_key: 'c', action: 'agrees_with_filter', answered_verdict: 'pending', answered_filtered_by: null, answered_pipeline_setting_version: 2 },
    ]);
  });

  it('keeps every pipeline-setting version, with the renamed keys (and the switches of schema 14)', () => {
    const current = (threshold: number) => ({
      culling_profiles_enabled: true,
      culling_profiles_filter_enabled: true,
      culling_profiles: [{ profile_slug: 'recipe-culling', rule: RULE_V13 }],
      score_forecast: { enabled: true, threshold, high_from_level: 8, excused_at: 0.5 },
    });
    const rows = all(db, 'SELECT version, config_json, is_current, created_at, note FROM cull_pipeline_settings ORDER BY version');
    expect(rows.map((r) => ({ ...r, config_json: JSON.parse(r.config_json as string) }))).toEqual([
      { version: 1, config_json: current(0.111), is_current: 0, created_at: NOW, note: 'default' },
      { version: 2, config_json: current(0.2), is_current: 1, created_at: NOW, note: 'rule of recipe-7h47 changed' },
    ]);
  });

  it('leaves the Lightroom write-back switches and per-photo state as they were', () => {
    expect(all(db, 'SELECT id, write_stars, write_reject, stars_profile_slug FROM lr_writeback_settings')).toEqual([
      { id: 1, write_stars: 1, write_reject: 1, stars_profile_slug: 'recipe-culling' },
    ]);
    expect(
      all(db, `SELECT image_key, kind, status, before_pick, before_rating, written_pick, written_rating, stars_profile_version_id,
                      updated_at, written_at FROM lr_writeback_state ORDER BY image_key`),
    ).toEqual([
      { image_key: 'a', kind: 'reject', status: 'written', before_pick: 0, before_rating: 0, written_pick: -1, written_rating: null, stars_profile_version_id: null, updated_at: NOW, written_at: NOW },
      { image_key: 'b', kind: 'stars', status: 'written', before_pick: 0, before_rating: 0, written_pick: null, written_rating: 2, stars_profile_version_id: 1, updated_at: NOW, written_at: NOW },
    ]);
  });

  it('leaves the run history as written', () => {
    expect(all(db, 'SELECT run_id, detail_json FROM cull_runs')).toEqual([
      { run_id: 1, detail_json: '{"cut_by_culling_recipe":1,"sent":2}' },
    ]);
  });

  it('runs once: a second upgrade changes nothing', () => {
    const before = all(db, 'SELECT * FROM cull_verdicts ORDER BY image_key');
    db.close();
    db = openLibraryDb(path);
    db.pragma('user_version = 12');
    upgradeLibrarySchema(db);
    expect(db.pragma('user_version', { simple: true })).toBe(LIBRARY_SCHEMA_VERSION);
    expect(all(db, 'SELECT * FROM cull_verdicts ORDER BY image_key')).toEqual(before);
  });
});

describe('library schema 13, the factory profile', () => {
  it('keeps a renamed factory profile’s name, and still moves its slug', () => {
    db.close();
    rmSync(path);
    writeV12Library(path);
    const raw = openLibraryDb(path);
    raw.prepare("UPDATE cull_recipes SET name = 'My cull' WHERE id = 1").run();
    raw.close();
    db = initLibraryDb(path);
    expect(all(db, 'SELECT slug, name FROM cull_profiles WHERE id = 1')).toEqual([{ slug: 'recipe-culling', name: 'My cull' }]);
  });

  it('leaves the slug alone when recipe-culling is already taken', () => {
    db.close();
    rmSync(path);
    writeV12Library(path);
    const raw = openLibraryDb(path);
    raw.prepare("UPDATE cull_recipes SET slug = 'recipe-culling' WHERE id = 2").run();
    raw.close();
    db = initLibraryDb(path);
    expect(all(db, 'SELECT id, slug FROM cull_profiles ORDER BY id')).toEqual([
      { id: 1, slug: 'recipe-7h47' },
      { id: 2, slug: 'recipe-culling' },
    ]);
    expect(all(db, "SELECT DISTINCT stage_key FROM cull_stage_versions WHERE kind = 'culling_profile'")).toEqual([
      { stage_key: 'culling_profile:recipe-7h47:7' },
    ]);
  });
});
