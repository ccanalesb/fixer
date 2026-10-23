/**
 * Library schema 13: the cull vocabulary renamed in stored tables and values. Culling recipes
 * become culling profiles, verdicts `cut` / `sent` become `filtered` / `passed`, and the factory
 * profile `recipe-7h47` becomes `recipe-culling`.
 *
 * Answers, level probabilities and content hashes are copied as they are: a stage's hash is its model
 * and questions, neither of which changes, so no stored answer reads as stale afterwards. The tables
 * whose CHECK lists change are rebuilt; ids and AUTOINCREMENT sequences are carried over.
 */
import type { Db } from '../connection.js';

const SEED_SLUG_V12 = 'recipe-7h47';
const SEED_SLUG = 'recipe-culling';
const SEED_NAME_V12 = 'Recipe 7H47';
const SEED_NAME = 'Recipe culling';

/** v12 name → v13 name, rebuilt in this order (parents before children). */
const REBUILT = [
  ['cull_recipes', 'cull_profiles'],
  ['cull_recipe_versions', 'cull_profile_versions'],
  ['cull_stage_versions', 'cull_stage_versions'],
  ['cull_stage_answers', 'cull_stage_answers'],
  ['cull_verdicts', 'cull_verdicts'],
  ['cull_user_actions', 'cull_user_actions'],
] as const;

const V12_INDEXES = [
  'uq_cull_recipe_versions_current',
  'uq_cull_stage_versions_current',
  'idx_cull_stage_answers_stage',
  'idx_cull_verdicts_verdict',
  'idx_cull_user_actions_image',
];

const JSON_KEYS: Record<string, string> = {
  culling_recipes: 'culling_profiles',
  recipe_slug: 'profile_slug',
  cut_rule: 'filter_rule',
  run_after_cut: 'run_after_filtered',
};

function tableExists(db: Db, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

/** Keys renamed in place, order kept; the factory slug follows when it moves. */
function renameJson(value: unknown, moveSeed: boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => renameJson(v, moveSeed));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => {
      const key = JSON_KEYS[k] ?? k;
      if (key === 'profile_slug' && moveSeed && v === SEED_SLUG_V12) return [key, SEED_SLUG];
      return [key, renameJson(v, moveSeed)];
    }),
  );
}

/** Carry a rebuilt table's AUTOINCREMENT high-water mark, so a deleted row's id is never reused. */
function carrySequence(db: Db, from: string, to: string): void {
  const row = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(from) as { seq: number } | undefined;
  if (!row) return;
  db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(to);
  db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(to, row.seq);
}

/**
 * Bring v12 cull and Lightroom write-back tables to v13. A no-op on tables already at v13 (a library
 * upgraded from below 11 gets them from `cullSql` directly). Runs inside the caller's transaction.
 */
export function renameCullVocabulary(db: Db, cullSql: string): void {
  let moveSeed = false;
  if (tableExists(db, 'cull_recipes')) {
    const slugTaken = (slug: string) => db.prepare('SELECT 1 FROM cull_recipes WHERE slug = ?').get(slug) !== undefined;
    moveSeed = slugTaken(SEED_SLUG_V12) && !slugTaken(SEED_SLUG);

    const slug = (col: string) => (moveSeed ? `CASE ${col} WHEN '${SEED_SLUG_V12}' THEN '${SEED_SLUG}' ELSE ${col} END` : col);
    const stageKey = (col: string) => {
      const renamed = `replace(${col}, 'culling_recipe:', 'culling_profile:')`;
      return moveSeed
        ? `replace(${renamed}, 'culling_profile:${SEED_SLUG_V12}:', 'culling_profile:${SEED_SLUG}:')`
        : renamed;
    };
    const verdict = (col: string) => `CASE ${col} WHEN 'cut' THEN 'filtered' WHEN 'sent' THEN 'passed' ELSE ${col} END`;
    const kind = (col: string) => `CASE ${col} WHEN 'culling_recipe' THEN 'culling_profile' ELSE ${col} END`;

    for (const index of V12_INDEXES) db.exec(`DROP INDEX IF EXISTS ${index}`);
    for (const [v12] of REBUILT) db.exec(`ALTER TABLE ${v12} RENAME TO ${v12}_v12`);
    db.exec(cullSql);

    db.exec(`
      INSERT INTO cull_profiles (id, slug, name, model, active, rule_json, measured, source_filename, created_at, updated_at)
      SELECT id, ${slug('slug')},
             CASE WHEN ${moveSeed ? 1 : 0} AND slug = '${SEED_SLUG_V12}' AND name = '${SEED_NAME_V12}' THEN '${SEED_NAME}' ELSE name END,
             model, active, rule_json, measured,
             CASE source_filename WHEN '${SEED_SLUG_V12}.json' THEN '${SEED_SLUG}.json' ELSE source_filename END,
             created_at, updated_at
      FROM cull_recipes_v12;

      INSERT INTO cull_profile_versions (id, profile_id, version, definition_json, content_hash, is_current, created_at)
      SELECT id, recipe_id, version, definition_json, content_hash, is_current, created_at FROM cull_recipe_versions_v12;

      INSERT INTO cull_stage_versions
        (id, stage_key, kind, profile_slug, level_set, model_id, questions_json, content_hash, is_current, created_at)
      SELECT id, ${stageKey('stage_key')}, ${kind('kind')}, ${slug('recipe_slug')}, level_set, model_id, questions_json,
             content_hash, is_current, created_at
      FROM cull_stage_versions_v12;

      INSERT INTO cull_stage_answers
        (image_key, stage_version_id, answers_json, verdict, decision_json, pipeline_setting_version, source,
         produced_by, image_path, image_signature, run_id, answered_at, decided_at)
      SELECT image_key, stage_version_id, answers_json, ${verdict('verdict')},
             replace(decision_json, '"cut_rule":', '"filter_rule":'), pipeline_setting_version, source,
             produced_by, image_path, image_signature, run_id, answered_at, decided_at
      FROM cull_stage_answers_v12;

      INSERT INTO cull_verdicts
        (image_key, verdict, filtered_by, filtered_by_stage_key, sent_by_hand, pending_stages, pending_reason,
         score_forecast_off, score_forecast_p8, pipeline_setting_version, stage_version_ids, run_id, decided_at)
      SELECT image_key, ${verdict('verdict')}, ${kind('cut_by')}, ${stageKey('cut_by_stage_key')}, sent_by_hand,
             ${stageKey('pending_stages')}, pending_reason, score_forecast_off, score_forecast_p8,
             pipeline_setting_version, stage_version_ids, run_id, decided_at
      FROM cull_verdicts_v12;

      INSERT INTO cull_user_actions
        (id, image_key, action, acted_at, answered_verdict, answered_filtered_by, answered_pipeline_setting_version,
         answered_stage_version_ids)
      SELECT id, image_key,
             CASE action WHEN 'agrees_with_cut' THEN 'agrees_with_filter'
                         WHEN 'should_have_been_cut' THEN 'should_have_been_filtered' ELSE action END,
             acted_at, ${verdict('answered_verdict')}, ${kind('answered_cut_by')}, answered_pipeline_setting_version,
             answered_stage_version_ids
      FROM cull_user_actions_v12;
    `);

    const updateRule = db.prepare('UPDATE cull_profiles SET rule_json = ? WHERE id = ?');
    for (const r of db.prepare('SELECT id, rule_json FROM cull_profiles').all() as { id: number; rule_json: string }[]) {
      updateRule.run(JSON.stringify(renameJson(JSON.parse(r.rule_json), moveSeed)), r.id);
    }
    const updateConfig = db.prepare('UPDATE cull_pipeline_settings SET config_json = ? WHERE version = ?');
    for (const p of db.prepare('SELECT version, config_json FROM cull_pipeline_settings').all() as {
      version: number;
      config_json: string;
    }[]) {
      updateConfig.run(JSON.stringify(renameJson(JSON.parse(p.config_json), moveSeed)), p.version);
    }

    for (const [v12, v13] of REBUILT) carrySequence(db, `${v12}_v12`, v13);
    for (const [v12] of [...REBUILT].reverse()) db.exec(`DROP TABLE ${v12}_v12`);
  }

  if (tableExists(db, 'lr_writeback_settings') && hasColumn(db, 'lr_writeback_settings', 'stars_recipe_slug')) {
    db.exec('ALTER TABLE lr_writeback_settings RENAME COLUMN stars_recipe_slug TO stars_profile_slug');
    if (moveSeed) {
      db.prepare('UPDATE lr_writeback_settings SET stars_profile_slug = ? WHERE stars_profile_slug = ?').run(SEED_SLUG, SEED_SLUG_V12);
    }
  }
  if (tableExists(db, 'lr_writeback_state') && hasColumn(db, 'lr_writeback_state', 'stars_recipe_version_id')) {
    db.exec('ALTER TABLE lr_writeback_state RENAME COLUMN stars_recipe_version_id TO stars_profile_version_id');
  }
}
