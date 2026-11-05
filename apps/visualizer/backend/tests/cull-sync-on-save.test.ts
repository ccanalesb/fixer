/**
 * A stage version becomes current when what the stage is asked is saved, before anything reads it: the
 * writers in `db/library/` sync the stages, so `cull_stage_versions` already has the right current row
 * without a `resolveCurrentStages` call. (Reads becoming read-only is a later slice.)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncCurrentStages } from '../src/cull/stages.js';
import type { Db } from '../src/db/connection.js';
import { initLibraryDb } from '../src/db/library/bootstrap.js';
import { createPipelineSettingVersion, getCurrentPipelineSetting } from '../src/db/library/cull-pipeline.js';
import { getCullProfile, saveProfileDefinition } from '../src/db/library/cull-profiles.js';
import { duplicateCullProfile, setCullProfilePipelineActive } from '../src/db/library/cull-profiles-mutations.js';
import { countPhotosAnsweredByCurrentStage, upsertStageAnswer } from '../src/db/library/cull-stages.js';
import { insertCullRun } from '../src/db/library/cull-verdicts.js';
import { factoryForecastQuestions, saveForecastQuestions } from '../src/db/library/score-forecast-questions.js';
import type { ProfileDefinition } from '../src/cull/types.js';

const MODEL_IDS = { culling_profile: 'owner/vision@abc', score_forecast: 'forecast@def' };

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-cull-sync-save-'));
  db = initLibraryDb(join(dir, 'library.db'));
  saveForecastQuestions(db, factoryForecastQuestions(db));
  // Stand in for a culling job that answered each stage once, so the stages have stored model ids.
  syncCurrentStages(db, MODEL_IDS);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The current stage version's id for a stage key, read straight from the table (no resolve). */
function currentVersionId(stageKey: string): number | undefined {
  return (
    db
      .prepare('SELECT id FROM cull_stage_versions WHERE stage_key = ? AND is_current = 1')
      .get(stageKey) as { id: number } | undefined
  )?.id;
}

function stageVersionRows(stageKey: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM cull_stage_versions WHERE stage_key = ?').get(stageKey) as { n: number }).n;
}

function editLevels(setId: string, edit: (levels: string[]) => string[]): ProfileDefinition {
  const def = structuredClone(getCullProfile(db, 'default')!.definition);
  const set = def.level_sets.find((s) => s.id === setId)!;
  for (const dim of Object.keys(set.levels)) set.levels[dim] = edit(set.levels[dim]!);
  return def;
}

describe('stage versions become current at save, before any read', () => {
  it('saving a profile definition leaves its level sets with a new current version before a GET', () => {
    const before7 = currentVersionId('culling_profile:default:7')!;
    saveProfileDefinition(db, 'default', editLevels('7', (l) => [...l.slice(0, 6), 'unforgettable']));
    const after7 = currentVersionId('culling_profile:default:7');
    expect(after7).toBeDefined();
    expect(after7).not.toBe(before7);
    // The 10-level set's text did not change, so its version stays.
    expect(currentVersionId('culling_profile:default:10')).toBeDefined();
  });

  it('saving the earlier text again makes the earlier version current again, with no new row', () => {
    const original = getCullProfile(db, 'default')!.definition;
    const first = currentVersionId('culling_profile:default:7')!;
    saveProfileDefinition(db, 'default', editLevels('7', (l) => [...l, 'beyond words']));
    const rowsAfterEdit = stageVersionRows('culling_profile:default:7');
    expect(currentVersionId('culling_profile:default:7')).not.toBe(first);

    saveProfileDefinition(db, 'default', original);
    expect(currentVersionId('culling_profile:default:7')).toBe(first);
    expect(stageVersionRows('culling_profile:default:7')).toBe(rowsAfterEdit);
  });

  it('saving Score forecast questions leaves a new current score_forecast version before a GET', () => {
    const before = currentVersionId('score_forecast')!;
    const questions = factoryForecastQuestions(db);
    questions[0]!.instructions = `${questions[0]!.instructions} (edited)`;
    saveForecastQuestions(db, questions);
    const after = currentVersionId('score_forecast');
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  it('initLibraryDb brings a stale current profile stage version up to the saved text', () => {
    const stageKey = 'culling_profile:default:7';
    const good = currentVersionId(stageKey)!;
    // A row whose questions no longer match the saved profile text, marked current in its place.
    db.exec(`UPDATE cull_stage_versions SET is_current = 0 WHERE stage_key = '${stageKey}'`);
    db.prepare(
      `INSERT INTO cull_stage_versions
         (stage_key, kind, profile_slug, level_set, model_id, questions_json, content_hash, is_current, created_at)
       VALUES (?, 'culling_profile', 'default', '7', ?, '{"stale|x":{"type":"score","instructions":"old","criteria":["a"]}}', 'stalehash', 1, '2020-01-01T00:00:00Z')`,
    ).run(stageKey, MODEL_IDS.culling_profile);
    expect(currentVersionId(stageKey)).not.toBe(good);
    db.close();

    db = initLibraryDb(join(dir, 'library.db'));
    // Reopening reconciles the stage to the saved text, which is the version the job had made.
    expect(currentVersionId(stageKey)).toBe(good);
  });

  it('a pipeline-setting change re-syncs a current version for each profile level set', () => {
    const before7 = currentVersionId('culling_profile:default:7')!;
    const before10 = currentVersionId('culling_profile:default:10')!;

    const config = getCurrentPipelineSetting(db).config;
    createPipelineSettingVersion(db, { ...config, culling_profiles_enabled: true });

    // The text and model did not change, so the same versions stay current — the write did not read.
    expect(currentVersionId('culling_profile:default:7')).toBe(before7);
    expect(currentVersionId('culling_profile:default:10')).toBe(before10);
  });

  it('the answers stored under an earlier text count again once that text is saved back', () => {
    const original = getCullProfile(db, 'default')!.definition;
    const run = insertCullRun(db, { kind: 'job', jobId: null, pipelineSettingVersion: 1 });
    upsertStageAnswer(db, {
      imageKey: 'a',
      stageVersionId: currentVersionId('culling_profile:default:7')!,
      answers: { connotation: [1, 0, 0, 0, 0, 0, 0] },
      verdict: 'passed',
      decision: {},
      pipelineSettingVersion: 1,
      source: 'job',
      runId: run,
    });
    expect(countPhotosAnsweredByCurrentStage(db, 'culling_profile')).toBe(1);

    saveProfileDefinition(db, 'default', editLevels('7', (l) => [...l, 'beyond words']));
    saveProfileDefinition(db, 'default', editLevels('10', (l) => [...l, 'beyond words']));
    expect(countPhotosAnsweredByCurrentStage(db, 'culling_profile')).toBe(0);

    saveProfileDefinition(db, 'default', original);
    expect(countPhotosAnsweredByCurrentStage(db, 'culling_profile')).toBe(1);
  });

  it('adding a profile to the pipeline setting leaves a current version for each of its level sets', () => {
    duplicateCullProfile(db, 'default', 'second');
    expect(currentVersionId('culling_profile:second:7')).toBeUndefined();

    setCullProfilePipelineActive(db, 'second', true);
    expect(currentVersionId('culling_profile:second:7')).toBeDefined();
    expect(currentVersionId('culling_profile:second:10')).toBeDefined();
  });

  it('a level set added or removed together with its bands saves in one step', () => {
    const profile = getCullProfile(db, 'default')!;
    const added = structuredClone(profile.definition);
    const src = added.level_sets[0]!;
    added.level_sets.push({ id: '5', levels: Object.fromEntries(Object.entries(src.levels).map(([k, v]) => [k, v.slice(0, 5)])) });
    const withFive = { ...profile.rule, level_sets: { ...profile.rule.level_sets, '5': { fails_at_most: 2, strong_at_least: 4 } } };

    saveProfileDefinition(db, 'default', added, withFive);
    expect(currentVersionId('culling_profile:default:5')).toBeDefined();

    saveProfileDefinition(db, 'default', profile.definition, profile.rule);
    expect(getCullProfile(db, 'default')!.definition.level_sets.map((s) => s.id)).not.toContain('5');
  });
});
