/**
 * Library schema 17: imported culling answers and their runs say `import`, what produced the answers
 * says `cull-import`, an imported answer keeps its image path only inside the vision cache, and run
 * details use the culling vocabulary.
 *
 * Answers, verdicts, decisions, stage versions and content hashes are copied as they are. The two
 * tables whose CHECK lists change are rebuilt; run ids and the run id sequence are carried over.
 */
import { dirname, isAbsolute } from 'node:path';
import type { Db } from '../connection.js';
import { DEFAULT_CULLING_PROFILE_SLUG } from './cull-profiles.js';

const DETAIL_KEYS: Record<string, string> = {
  cut_by_culling_recipe: 'filtered_by_culling_profile',
  cut_by_score_forecast: 'filtered_by_score_forecast',
  sent: 'passed',
  recipe: 'profile',
};

const RECIPE_STAGE_KEY = /^culling_recipe:([^:]+):([^:]+)$/;

/** Only the seeded profile's slug changed when culling recipes became culling profiles. */
function stageKey(key: string, slugs: ReadonlySet<string>): string {
  const m = RECIPE_STAGE_KEY.exec(key);
  if (!m) return key;
  return `culling_profile:${slugs.has(m[1]!) ? m[1] : DEFAULT_CULLING_PROFILE_SLUG}:${m[2]}`;
}

function renameDetail(value: unknown, slugs: ReadonlySet<string>): unknown {
  if (typeof value === 'string') return stageKey(value, slugs);
  if (Array.isArray(value)) return value.map((v) => renameDetail(v, slugs));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [DETAIL_KEYS[k] ?? stageKey(k, slugs), renameDetail(v, slugs)]),
  );
}

function carrySequence(db: Db, from: string, to: string): void {
  const row = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(from) as { seq: number } | undefined;
  if (!row) return;
  db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(to);
  db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(to, row.seq);
}

/** Runs inside the caller's transaction. */
export function upgradeCullImports(db: Db, cullSql: string): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_cull_stage_answers_stage;
    ALTER TABLE cull_runs RENAME TO cull_runs_v16;
    ALTER TABLE cull_stage_answers RENAME TO cull_stage_answers_v16;
  `);
  db.exec(cullSql);
  db.exec(`
    INSERT INTO cull_runs (run_id, kind, job_id, started_at, finished_at, pipeline_setting_version, detail_json)
    SELECT run_id, CASE WHEN kind IN ('job', 'redecide') THEN kind ELSE 'import' END, job_id, started_at,
           finished_at, pipeline_setting_version, detail_json
    FROM cull_runs_v16;

    INSERT INTO cull_stage_answers
      (image_key, stage_version_id, answers_json, verdict, decision_json, pipeline_setting_version, source,
       produced_by, image_path, image_signature, run_id, answered_at, decided_at)
    SELECT image_key, stage_version_id, answers_json, verdict, decision_json, pipeline_setting_version,
           CASE source WHEN 'job' THEN 'job' ELSE 'import' END,
           CASE source WHEN 'job' THEN produced_by ELSE 'cull-import' END,
           image_path, image_signature, run_id, answered_at, decided_at
    FROM cull_stage_answers_v16;
  `);
  carrySequence(db, 'cull_runs_v16', 'cull_runs');
  db.exec('DROP TABLE cull_stage_answers_v16; DROP TABLE cull_runs_v16;');

  const cacheDirs = new Set(
    (db.prepare('SELECT DISTINCT compressed_path AS p FROM vision_cache WHERE compressed_path IS NOT NULL').all() as { p: string }[])
      .filter((r) => isAbsolute(r.p))
      .map((r) => dirname(r.p)),
  );
  db.function('outside_vision_cache', { deterministic: true }, (p: unknown) => (cacheDirs.has(dirname(String(p))) ? 0 : 1));
  db.exec(`
    UPDATE cull_stage_answers SET image_path = '', image_signature = NULL
    WHERE source = 'import' AND image_path != '' AND outside_vision_cache(image_path)
  `);

  const slugs = new Set((db.prepare('SELECT slug FROM cull_profiles').all() as { slug: string }[]).map((r) => r.slug));
  const update = db.prepare('UPDATE cull_runs SET detail_json = ? WHERE run_id = ?');
  for (const r of db.prepare('SELECT run_id, detail_json FROM cull_runs').all() as { run_id: number; detail_json: string }[]) {
    const renamed = JSON.stringify(renameDetail(JSON.parse(r.detail_json), slugs));
    if (renamed !== r.detail_json) update.run(renamed, r.run_id);
  }
}
