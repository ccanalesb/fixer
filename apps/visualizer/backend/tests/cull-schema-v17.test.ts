/**
 * Library schema 17: imported culling answers and their run say `import`, what produced them says
 * `cull-import`, an image path outside the vision cache is not kept, and run details use the culling
 * vocabulary. Answers, verdicts, decisions and stage versions are copied as they are.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLibraryDb, type Db } from '../src/db/connection.js';
import { initLibraryDb, LIBRARY_SCHEMA_VERSION } from '../src/db/library/bootstrap.js';
import { DEFAULT_CULLING_PROFILE_SLUG } from '../src/db/library/cull-profiles.js';
import { getOrCreateStageVersion } from '../src/db/library/cull-stages.js';
import { LAYA_QUESTIONS } from '../src/laya/questions.js';

const V16_SQL = readFileSync(join(import.meta.dirname, 'fixtures', 'cull', 'schema-v16-runs-answers.sql'), 'utf8');
const [V16_IMPORT] = /'job','(\w+)','redecide'/.exec(V16_SQL)!.slice(1);

let dir: string;
let path: string;
let cache: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-cull-v17-'));
  path = join(dir, 'library.db');
  cache = join(dir, 'vision');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const IMPORT_DETAIL = {
  lines: { laya_new: 2, recipe: 4 },
  truncated_tail: { laya_new: false, recipe: false },
  inserted: { 'culling_recipe:old-seed:7': 2, 'culling_recipe:mine:10': 1, score_forecast: 2 },
  verdicts: { cut_by_culling_recipe: 1, cut_by_score_forecast: 0, pending: 0, sent: 1 },
};
const JOB_DETAIL = {
  total: 3,
  culled: 1,
  cut_by_culling_recipe: 0,
  cut_by_score_forecast: 1,
  sent: 2,
  sent_by_hand_passed: 0,
  stage_versions: { 'culling_recipe:old-seed:7': 1, score_forecast: 2 },
};

/** A v16 library: an import run and a job run, imported answers in and out of the vision cache, a job's answer. */
function writeV16Library(): void {
  const db = initLibraryDb(path);
  const stage = getOrCreateStageVersion(db, {
    stageKey: `culling_profile:${DEFAULT_CULLING_PROFILE_SLUG}:7`,
    kind: 'culling_profile',
    profileSlug: DEFAULT_CULLING_PROFILE_SLUG,
    levelSet: '7',
    modelId: 'thaitea/laya-vision@8b318c9',
    questions: LAYA_QUESTIONS.new,
  });
  db.prepare(
    "INSERT INTO cull_profiles (slug, name, model, rule_json, created_at, updated_at) VALUES ('mine', 'Mine', 'laya-base', '{}', 't', 't')",
  ).run();
  db.prepare("INSERT INTO vision_cache (key, compressed_path) VALUES ('a', ?), ('b', ?)").run(
    join(cache, 'a.jpg'),
    join(cache, 'b.jpg'),
  );
  db.exec('DROP INDEX idx_cull_stage_answers_stage; DROP TABLE cull_stage_answers; DROP TABLE cull_runs;');
  db.exec(V16_SQL);
  const run = db.prepare(
    'INSERT INTO cull_runs (run_id, kind, job_id, started_at, finished_at, pipeline_setting_version, detail_json) VALUES (?, ?, ?, ?, ?, 1, ?)',
  );
  run.run(1, V16_IMPORT, null, 't1', 't2', JSON.stringify(IMPORT_DETAIL));
  run.run(3, 'job', 'j1', 't3', 't4', JSON.stringify(JOB_DETAIL));
  run.run(4, 'redecide', 'j2', 't5', null, '{}');
  db.prepare("UPDATE sqlite_sequence SET seq = 9 WHERE name = 'cull_runs'").run();
  const answer = db.prepare(
    `INSERT INTO cull_stage_answers (image_key, stage_version_id, answers_json, verdict, decision_json,
       pipeline_setting_version, source, produced_by, image_path, image_signature, run_id, answered_at, decided_at)
     VALUES (?, ?, '{"x":[1]}', ?, '{"d":1}', 1, ?, ?, ?, ?, ?, 'ta', 'td')`,
  );
  answer.run('a', stage, 'passed', V16_IMPORT, 'old producer; copied from elsewhere', join(cache, 'a.jpg'), '10:1', 1);
  answer.run('c', stage, 'filtered', V16_IMPORT, 'old producer', join(dir, 'elsewhere', 'c.jpg'), '20:2', 1);
  answer.run('b', stage, 'passed', 'job', 'this_app', join(cache, 'b.jpg'), '30:3', 3);
  db.pragma('user_version = 16');
  db.close();
}

const answers = (db: Db) =>
  db
    .prepare('SELECT image_key, source, produced_by, image_path, image_signature, run_id FROM cull_stage_answers ORDER BY image_key')
    .all();
/** What a decision reads: copied as it is. */
const decided = (db: Db) =>
  db
    .prepare(
      `SELECT image_key, stage_version_id, answers_json, verdict, decision_json, pipeline_setting_version, answered_at, decided_at
       FROM cull_stage_answers ORDER BY image_key`,
    )
    .all();
const untouched = (db: Db) =>
  Object.fromEntries(
    ['cull_stage_versions', 'cull_verdicts', 'cull_profiles', 'cull_pipeline_settings'].map((t) => [
      t,
      db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all(),
    ]),
  );

describe('library schema 17', () => {
  it('stores imports as import, by cull-import, and keeps only image paths in the vision cache', () => {
    writeV16Library();
    const raw = openLibraryDb(path);
    const before = { decided: decided(raw), untouched: untouched(raw) };
    raw.close();

    const db = initLibraryDb(path);
    try {
      expect(LIBRARY_SCHEMA_VERSION).toBe(17);
      expect(db.pragma('user_version', { simple: true })).toBe(17);
      expect(answers(db)).toEqual([
        { image_key: 'a', source: 'import', produced_by: 'cull-import', image_path: join(cache, 'a.jpg'), image_signature: '10:1', run_id: 1 },
        { image_key: 'b', source: 'job', produced_by: 'this_app', image_path: join(cache, 'b.jpg'), image_signature: '30:3', run_id: 3 },
        { image_key: 'c', source: 'import', produced_by: 'cull-import', image_path: '', image_signature: null, run_id: 1 },
      ]);
      expect(decided(db)).toEqual(before.decided);
      expect(untouched(db)).toEqual(before.untouched);
      expect(db.prepare('SELECT run_id, kind, job_id, started_at, finished_at FROM cull_runs ORDER BY run_id').all()).toEqual([
        { run_id: 1, kind: 'import', job_id: null, started_at: 't1', finished_at: 't2' },
        { run_id: 3, kind: 'job', job_id: 'j1', started_at: 't3', finished_at: 't4' },
        { run_id: 4, kind: 'redecide', job_id: 'j2', started_at: 't5', finished_at: null },
      ]);
    } finally {
      db.close();
    }
  });

  it('rewrites run details in the culling vocabulary; a slug no longer among the profiles was the seeded one', () => {
    writeV16Library();
    const db = initLibraryDb(path);
    try {
      const detail = (id: number) =>
        JSON.parse((db.prepare('SELECT detail_json FROM cull_runs WHERE run_id = ?').get(id) as { detail_json: string }).detail_json);
      expect(detail(1)).toEqual({
        lines: { laya_new: 2, profile: 4 },
        truncated_tail: { laya_new: false, profile: false },
        inserted: { 'culling_profile:recipe-culling:7': 2, 'culling_profile:mine:10': 1, score_forecast: 2 },
        verdicts: { filtered_by_culling_profile: 1, filtered_by_score_forecast: 0, pending: 0, passed: 1 },
      });
      expect(detail(3)).toEqual({
        total: 3,
        culled: 1,
        filtered_by_culling_profile: 0,
        filtered_by_score_forecast: 1,
        passed: 2,
        sent_by_hand_passed: 0,
        stage_versions: { 'culling_profile:recipe-culling:7': 1, score_forecast: 2 },
      });
      expect(detail(4)).toEqual({});
    } finally {
      db.close();
    }
  });

  it('carries the run id sequence and takes only the current values', () => {
    writeV16Library();
    const db = initLibraryDb(path);
    try {
      const id = db
        .prepare("INSERT INTO cull_runs (kind, started_at, pipeline_setting_version) VALUES ('import', 't', 1)")
        .run().lastInsertRowid;
      expect(id).toBe(10);
      expect(() =>
        db.prepare("INSERT INTO cull_runs (kind, started_at, pipeline_setting_version) VALUES (?, 't', 1)").run(V16_IMPORT),
      ).toThrow(/CHECK/);
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_cull_stage_answers_stage'").get()).toBeTruthy();
    } finally {
      db.close();
    }
  });
});
