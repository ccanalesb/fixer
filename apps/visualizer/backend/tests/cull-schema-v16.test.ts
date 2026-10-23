/**
 * Library schema 16: the seeded culling profile is named "Default culling profile" (it was "Recipe
 * culling"). Only the name changes: its slug, the stage keys, stage versions, answers, verdicts and the
 * pipeline setting stay as they are, and a name the user chose is kept.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLibraryDb, type Db } from '../src/db/connection.js';
import { initLibraryDb, LIBRARY_SCHEMA_VERSION } from '../src/db/library/bootstrap.js';
import { createPipelineSettingVersion, getCurrentPipelineSetting } from '../src/db/library/cull-pipeline.js';
import { DEFAULT_CULLING_PROFILE_SLUG, getCullProfile } from '../src/db/library/cull-profiles.js';
import { getOrCreateStageVersion } from '../src/db/library/cull-stages.js';
import { LAYA_QUESTIONS } from '../src/laya/questions.js';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-cull-v16-'));
  path = join(dir, 'library.db');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A v15 library whose seeded profile is called `name`, with both stages on and a stage version answered. */
function writeV15Library(name: string): void {
  const db = initLibraryDb(path);
  const { config } = getCurrentPipelineSetting(db);
  createPipelineSettingVersion(db, {
    ...config,
    culling_profiles_enabled: true,
    score_forecast: { ...config.score_forecast, enabled: true },
  });
  const stage = getOrCreateStageVersion(db, {
    stageKey: `culling_profile:${DEFAULT_CULLING_PROFILE_SLUG}:7`,
    kind: 'culling_profile',
    profileSlug: DEFAULT_CULLING_PROFILE_SLUG,
    levelSet: '7',
    modelId: 'thaitea/laya-vision@8b318c9',
    questions: LAYA_QUESTIONS.new,
  });
  db.prepare(
    `INSERT INTO cull_stage_answers (image_key, stage_version_id, answers_json, verdict, decision_json,
       pipeline_setting_version, source, produced_by, run_id, answered_at, decided_at)
     VALUES ('a', ?, '{"x":[1]}', 'passed', '{}', 2, 'job', 'this_app', 1, 't', 't')`,
  ).run(stage);
  db.prepare('UPDATE cull_profiles SET name = ? WHERE slug = ?').run(name, DEFAULT_CULLING_PROFILE_SLUG);
  db.pragma('user_version = 15');
  db.close();
}

/** Every culling row but the profiles' names. */
const snapshot = (db: Db) =>
  Object.fromEntries(
    ['cull_pipeline_settings', 'cull_profile_versions', 'cull_stage_versions', 'cull_stage_answers', 'cull_verdicts'].map(
      (t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()],
    ),
  );

describe('library schema 16', () => {
  it('names the seeded profile Default culling profile and changes nothing else', () => {
    writeV15Library('Recipe culling');
    const raw = openLibraryDb(path);
    const before = snapshot(raw);
    raw.close();

    const db = initLibraryDb(path);
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(LIBRARY_SCHEMA_VERSION);
      expect(getCullProfile(db, DEFAULT_CULLING_PROFILE_SLUG)?.name).toBe('Default culling profile');
      expect(snapshot(db)).toEqual(before);
      expect(getCurrentPipelineSetting(db).config).toMatchObject({
        culling_profiles_enabled: true,
        score_forecast: { enabled: true },
      });
    } finally {
      db.close();
    }
  });

  it('keeps a name the user chose', () => {
    writeV15Library('My culling');
    const db = initLibraryDb(path);
    try {
      expect(getCullProfile(db, DEFAULT_CULLING_PROFILE_SLUG)?.name).toBe('My culling');
    } finally {
      db.close();
    }
  });
});
