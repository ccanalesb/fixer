/**
 * Cull storage in `library.db`: the migration and seed, profile and stage versions, the pipeline
 * setting, stage answers and the user-action history.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';
import type { Db } from '../src/db/connection.js';
import { initLibraryDb, LIBRARY_SCHEMA_VERSION } from '../src/db/library/bootstrap.js';
import { createPipelineSettingVersion, getCurrentPipelineSetting } from '../src/db/library/cull-pipeline.js';
import {
  CULL_DEFAULTS_SEEDED_META_KEY,
  getCullProfile,
  listCullProfiles,
  saveProfileDefinition,
  seedCullingDefaults,
  setProfileRule,
} from '../src/db/library/cull-profiles.js';
import {
  getOrCreateStageVersion,
  loadCurrentStageAnswers,
  readStoredStageModelIds,
  upsertStageAnswer,
} from '../src/db/library/cull-stages.js';
import { isSentByHand, listCullUserActions, recordCullUserAction } from '../src/db/library/cull-user-actions.js';
import {
  getCullVerdict,
  insertCullRun,
  isPhotoFilteredAndNotSentByHand,
  listCulledImageKeys,
  loadCullVerdictsForKeys,
  upsertCullVerdict,
} from '../src/db/library/cull-verdicts.js';
import { listCatalogImagesForFrameSubstance } from '../src/db/library/frame-substance.js';
import {
  dropFilteredPhotosFromDescribeAndScoringSelection,
  filterVoidSubstanceFromScoringSelection,
} from '../src/jobs/handlers/common.js';
import { resolveCurrentStages } from '../src/cull/stages.js';
import { layaNewForecastQuestions, saveForecastQuestions } from '../src/db/library/score-forecast-questions.js';
import { LAYA_QUESTIONS } from '../src/laya/questions.js';
import type { ProfileDefinition } from '../src/cull/types.js';

const CULL_TABLES = [
  'cull_pipeline_settings',
  'cull_profile_versions',
  'cull_profiles',
  'cull_runs',
  'cull_stage_answers',
  'cull_stage_versions',
  'cull_user_actions',
  'cull_verdicts',
];
const MODEL_IDS = { culling_profile: 'thaitea/laya-vision@8b318c9', score_forecast: 'laya-new@sha256:abc' };

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-cull-storage-'));
  db = initLibraryDb(join(dir, 'library.db'));
  saveForecastQuestions(db, layaNewForecastQuestions(db));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const tables = (d: Db) =>
  (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cull_%' ORDER BY name").all() as {
    name: string;
  }[]).map((r) => r.name);

describe('migration and seed', () => {
  it('a fresh library has every cull table, the Default culling profile and the default pipeline setting', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(LIBRARY_SCHEMA_VERSION);
    expect(tables(db)).toEqual(CULL_TABLES);
    const profile = getCullProfile(db, 'recipe-culling')!;
    expect(profile).toMatchObject({ name: 'Default culling profile', model: 'laya-base', active: true, measured: true });
    expect(profile.definition.dimensions.map((d) => d.slug)).toEqual([
      'immediate-impact',
      'visual-structure',
      'point-of-tension',
      'connotation',
    ]);
    expect(profile.definition.level_sets.map((s) => s.id)).toEqual(['7', '10']);
    const pipeline = getCurrentPipelineSetting(db);
    expect(pipeline.version).toBe(1);
    // A new install has no models, so both stages start off; turning the culling profile on filters as it always did.
    expect(pipeline.config).toMatchObject({ culling_profiles_enabled: false, culling_profiles_filter_enabled: true });
    expect(pipeline.config.culling_profiles).toEqual([{ profile_slug: 'recipe-culling', rule: profile.rule }]);
    expect(profile.rule).toEqual({
      level_sets: { '7': { fails_at_most: 3, strong_at_least: 6 }, '10': { fails_at_most: 4, strong_at_least: 8 } },
      combine: 'every',
      filter_rule: { type: 'all_fail', dimensions: ['point-of-tension', 'connotation'] },
    });
    expect(pipeline.config.score_forecast).toEqual({ enabled: false, threshold: 0.111, high_from_level: 8, excused_at: 0.5 });
  });

  it('a deleted profile is not seeded again', () => {
    expect(listCullProfiles(db).map((r) => r.slug)).toEqual(['recipe-culling']);
    db.exec('DELETE FROM cull_profile_versions; DELETE FROM cull_profiles');
    expect(seedCullingDefaults(db)).toBe(false);
    db.close();
    db = initLibraryDb(join(dir, 'library.db'));
    expect(listCullProfiles(db)).toEqual([]);
  });

  it('is not marked seeded until a pipeline setting exists', () => {
    for (const t of CULL_TABLES) db.exec(`DELETE FROM ${t}`);
    db.prepare('DELETE FROM library_meta WHERE key = ?').run(CULL_DEFAULTS_SEEDED_META_KEY);
    expect(seedCullingDefaults(db, join(dir, 'no-seeds'))).toBe(false);
    expect(db.prepare('SELECT 1 FROM library_meta WHERE key = ?').get(CULL_DEFAULTS_SEEDED_META_KEY)).toBeUndefined();
    expect(seedCullingDefaults(db)).toBe(true);
    expect(getCurrentPipelineSetting(db).version).toBeGreaterThan(0);
  });

  it('the seed file asks the Default culling profile questions in questions.json, word for word', () => {
    const seed = JSON.parse(
      readFileSync(join(REPO_ROOT, 'prompts', 'culling-profiles', 'recipe-culling.json'), 'utf8'),
    ) as { definition: ProfileDefinition };
    const stages = resolveCurrentStages(db, getCurrentPipelineSetting(db).config, MODEL_IDS);
    for (const set of seed.definition.level_sets) {
      const stage = stages.find((s) => s.stageKey === `culling_profile:recipe-culling:${set.id}`)!;
      const asked = Object.values(stage.questions);
      const expected = Object.entries(LAYA_QUESTIONS.base)
        .filter(([qid]) => qid.startsWith(`${set.id}|`))
        .map(([, q]) => q);
      expect(asked).toEqual(expected);
    }
  });
});

describe('versions', () => {
  const current = () => resolveCurrentStages(db, getCurrentPipelineSetting(db).config, MODEL_IDS);
  const byKey = (key: string) => current().find((s) => s.stageKey === key)!;
  const S7 = 'culling_profile:recipe-culling:7';
  const S10 = 'culling_profile:recipe-culling:10';

  function editLevels(setId: string, edit: (levels: string[]) => string[]): ProfileDefinition {
    const def = structuredClone(getCullProfile(db, 'recipe-culling')!.definition);
    const set = def.level_sets.find((s) => s.id === setId)!;
    for (const dim of Object.keys(set.levels)) set.levels[dim] = edit(set.levels[dim]!);
    return def;
  }

  it('resolves three stages: Recipe culling at 7 and 10 levels and the Score forecast', () => {
    expect(current().map((s) => [s.stageKey, s.kind, s.modelId])).toEqual([
      [S7, 'culling_profile', MODEL_IDS.culling_profile],
      [S10, 'culling_profile', MODEL_IDS.culling_profile],
      ['score_forecast', 'score_forecast', MODEL_IDS.score_forecast],
    ]);
    expect(Object.keys(byKey('score_forecast').questions)).toEqual(Object.keys(LAYA_QUESTIONS.new));
  });

  it('a level text change makes a new version of that level set only; old rows stay, not current', () => {
    const run = insertCullRun(db, { kind: 'job', jobId: null, pipelineSettingVersion: 1 });
    const old7 = byKey(S7).versionId;
    const old10 = byKey(S10).versionId;
    upsertStageAnswer(db, {
      imageKey: 'a',
      stageVersionId: old7,
      answers: { connotation: [1, 0, 0, 0, 0, 0, 0] },
      verdict: 'passed',
      decision: {},
      pipelineSettingVersion: 1,
      source: 'job',
      runId: run,
    });

    const saved = saveProfileDefinition(db, 'recipe-culling', editLevels('7', (l) => [...l.slice(0, 6), 'unforgettable']));
    expect(saved).toMatchObject({ created: true, version: 2 });
    expect(byKey(S7).versionId).not.toBe(old7);
    expect(byKey(S10).versionId).toBe(old10);
    expect(Object.keys(loadCurrentStageAnswers(db, current(), ['a']).get('a') ?? {})).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cull_stage_answers WHERE stage_version_id = ?').get(old7)).toEqual({ n: 1 });

    expect(saveProfileDefinition(db, 'recipe-culling', getCullProfile(db, 'recipe-culling')!.definition).created).toBe(false);
  });

  it('a level-count change makes a new version; reverting brings the old one and its rows back', () => {
    const old7 = byKey(S7).versionId;
    const original = getCullProfile(db, 'recipe-culling')!.definition;
    saveProfileDefinition(db, 'recipe-culling', editLevels('7', (l) => [...l, 'beyond words']));
    const seven = byKey(S7);
    expect(seven.versionId).not.toBe(old7);
    expect(Object.values(seven.questions)[0]!.criteria).toHaveLength(8);

    saveProfileDefinition(db, 'recipe-culling', original);
    expect(byKey(S7).versionId).toBe(old7);
    expect(getCullProfile(db, 'recipe-culling')!.version).toBe(1);
  });

  it('a new model makes a new stage version', () => {
    const old = byKey('score_forecast').versionId;
    const other = resolveCurrentStages(db, getCurrentPipelineSetting(db).config, { ...MODEL_IDS, score_forecast: 'laya-new@other' });
    expect(other.find((s) => s.stageKey === 'score_forecast')!.versionId).not.toBe(old);
  });

  it('getOrCreateStageVersion is idempotent per stage text and model', () => {
    const args = { stageKey: 'x', kind: 'score_forecast' as const, profileSlug: null, levelSet: null, modelId: 'm', questions: {} };
    expect(getOrCreateStageVersion(db, args)).toBe(getOrCreateStageVersion(db, args));
  });

  it('a rule change is not a stage version: it makes a new pipeline-setting version', () => {
    const before = current().map((s) => s.versionId);
    const rule = { ...getCullProfile(db, 'recipe-culling')!.rule, combine: 'any' as const };
    setProfileRule(db, 'recipe-culling', rule);
    expect(getCullProfile(db, 'recipe-culling')!.rule.combine).toBe('any');
    const pipeline = getCurrentPipelineSetting(db);
    expect(pipeline.version).toBe(2);
    expect(pipeline.config.culling_profiles[0]!.rule.combine).toBe('any');
    expect(current().map((s) => s.versionId)).toEqual(before);
  });

  it('a new pipeline-setting version is the only current one', () => {
    const v = createPipelineSettingVersion(db, getCurrentPipelineSetting(db).config, 'test');
    expect(v).toBe(2);
    expect(db.prepare('SELECT version FROM cull_pipeline_settings WHERE is_current = 1').all()).toEqual([{ version: 2 }]);
  });
});

describe('stage answers, summaries and user actions', () => {
  it('one row per photo per stage version', () => {
    const run = insertCullRun(db, { kind: 'job', jobId: null, pipelineSettingVersion: 1 });
    const stageVersionId = getOrCreateStageVersion(db, {
      stageKey: 'score_forecast',
      kind: 'score_forecast',
      profileSlug: null,
      levelSet: null,
      modelId: 'm',
      questions: {},
    });
    const row = {
      imageKey: 'a',
      stageVersionId,
      answers: { x: [0.5, 0.5] },
      verdict: 'passed' as const,
      decision: {},
      pipelineSettingVersion: 1,
      source: 'job' as const,
      runId: run,
    };
    upsertStageAnswer(db, row);
    upsertStageAnswer(db, { ...row, verdict: 'filtered' });
    expect(db.prepare('SELECT verdict FROM cull_stage_answers').all()).toEqual([{ verdict: 'filtered' }]);
  });

  it('records each action with the verdict it answered; sent by hand sticks', () => {
    upsertCullVerdict(db, {
      imageKey: 'a',
      verdict: 'filtered',
      filteredBy: 'culling_profile',
      filteredByStageKey: null,
      cullingProfileVerdict: 'filtered',
      sentByHand: false,
      pendingStages: [],
      pendingReason: '',
      scoreForecastOff: false,
      scoreForecastP8: 0.05,
      pipelineSettingVersion: 1,
      stageVersionIds: [1, 2, 3],
      runId: null,
    });
    recordCullUserAction(db, 'a', 'agrees_with_filter', '2026-10-19T10:00:00+00:00');
    recordCullUserAction(db, 'a', 'sent_by_hand', '2026-10-19T11:00:00+00:00');
    expect(listCullUserActions(db, 'a')).toEqual([
      expect.objectContaining({ action: 'agrees_with_filter', answered_verdict: 'filtered', answered_filtered_by: 'culling_profile', acted_at: '2026-10-19T10:00:00+00:00' }),
      expect.objectContaining({ action: 'sent_by_hand', answered_verdict: 'filtered', answered_stage_version_ids: [1, 2, 3] }),
    ]);
    expect(getCullVerdict(db, 'a')).toMatchObject({ verdict: 'passed', sent_by_hand: true, filtered_by: null });
    expect(isSentByHand(db, 'a')).toBe(true);
    expect(isSentByHand(db, 'b')).toBe(false);
  });

  it('sending a photo with no verdict yet still sticks', () => {
    recordCullUserAction(db, 'z', 'sent_by_hand');
    expect(getCullVerdict(db, 'z')).toMatchObject({ verdict: 'passed', sent_by_hand: true });
    expect(listCullUserActions(db, 'z')[0]).toMatchObject({ answered_verdict: 'none' });
  });
});

const summary = (imageKey: string, verdict: 'filtered' | 'passed' | 'pending', filteredBy: 'culling_profile' | 'score_forecast' | null = null) =>
  upsertCullVerdict(db, {
    imageKey,
    verdict,
    filteredBy,
    filteredByStageKey: null,
    cullingProfileVerdict: filteredBy === 'culling_profile' ? 'filtered' : null,
    sentByHand: false,
    pendingStages: [],
    pendingReason: '',
    scoreForecastOff: false,
    scoreForecastP8: null,
    pipelineSettingVersion: 1,
    stageVersionIds: [],
    runId: null,
  });

describe('what the jobs that send photos to kimi read', () => {
  it('isPhotoFilteredAndNotSentByHand: only a filtered photo nobody sent on', () => {
    summary('filtered', 'filtered', 'culling_profile');
    summary('passed', 'passed');
    summary('pending', 'pending');
    summary('hand', 'filtered', 'score_forecast');
    recordCullUserAction(db, 'hand', 'sent_by_hand');
    expect(isPhotoFilteredAndNotSentByHand(db, 'filtered')).toBe(true);
    for (const key of ['passed', 'pending', 'hand', 'never-culled']) expect(isPhotoFilteredAndNotSentByHand(db, key)).toBe(false);
  });

  it('a sent-by-hand action wins even over a summary that still says filtered', () => {
    recordCullUserAction(db, 'a', 'sent_by_hand');
    summary('a', 'filtered', 'culling_profile');
    expect(isPhotoFilteredAndNotSentByHand(db, 'a')).toBe(false);
    expect(loadCullVerdictsForKeys(db, ['a']).get('a')).toMatchObject({ verdict: 'filtered', sentByHand: true });
  });

  it('readStoredStageModelIds: the model identities of the current stage versions, never an endpoint', () => {
    expect(readStoredStageModelIds(db)).toEqual({ culling_profile: null, score_forecast: null });
    resolveCurrentStages(db, getCurrentPipelineSetting(db).config, MODEL_IDS);
    expect(readStoredStageModelIds(db)).toEqual(MODEL_IDS);
    resolveCurrentStages(db, getCurrentPipelineSetting(db).config, { culling_profile: 'other-base', score_forecast: null });
    // A stage left out of a later run keeps its current version (G8).
    expect(readStoredStageModelIds(db)).toEqual({ culling_profile: 'other-base', score_forecast: MODEL_IDS.score_forecast });
  });

  it('readStoredStageModelIds: no Score forecast identity without a Score forecast version', () => {
    resolveCurrentStages(db, getCurrentPipelineSetting(db).config, { ...MODEL_IDS, score_forecast: null });
    expect(readStoredStageModelIds(db)).toEqual({ culling_profile: MODEL_IDS.culling_profile, score_forecast: null });
  });

  it('resolveCurrentStages: no culling profile stages without a culling profile identity', () => {
    const stages = resolveCurrentStages(db, getCurrentPipelineSetting(db).config, { ...MODEL_IDS, culling_profile: null });
    expect(stages.map((s) => s.stageKey)).toEqual(['score_forecast']);
  });

  it('listCulledImageKeys: photos with a summary or a current answer', () => {
    summary('a', 'passed');
    const [stage] = resolveCurrentStages(db, getCurrentPipelineSetting(db).config, MODEL_IDS);
    const run = insertCullRun(db, { kind: 'job', jobId: null, pipelineSettingVersion: 1 });
    upsertStageAnswer(db, {
      imageKey: 'b',
      stageVersionId: stage!.versionId,
      answers: {},
      verdict: 'passed',
      decision: {},
      pipelineSettingVersion: 1,
      source: 'job',
      runId: run,
    });
    expect(listCulledImageKeys(db)).toEqual(['a', 'b']);
  });
});

describe('large selections stay under the SQLite parameter cap', () => {
  const N = 40_000;
  const keys = Array.from({ length: N }, (_, i) => `k${String(i).padStart(5, '0')}`);
  const pairs = keys.map((k) => [k, 'catalog'] as const);

  beforeEach(() => {
    const img = db.prepare('INSERT INTO images (key, filename, filepath) VALUES (?, ?, ?)');
    const fs = db.prepare(
      "INSERT INTO image_frame_substance (image_key, verdict, detector_version, run_id) VALUES (?, ?, 'test', 1)",
    );
    db.transaction(() => {
      for (const k of keys) img.run(k, `${k}.jpg`, `/p/${k}.jpg`);
      fs.run(keys[N - 1], 'void');
    })();
    summary(keys[N - 1]!, 'filtered', 'culling_profile');
  });

  it('filterVoidSubstanceFromScoringSelection', () => {
    expect(filterVoidSubstanceFromScoringSelection(db, pairs)).toHaveLength(N - 1);
  });

  it('listCatalogImagesForFrameSubstance, still in key order', () => {
    const rows = listCatalogImagesForFrameSubstance(db, { imageKeys: [...keys].reverse() });
    expect(rows).toHaveLength(N);
    expect(rows[0]!.image_key).toBe(keys[0]);
    expect(rows.at(-1)!.image_key).toBe(keys[N - 1]);
  });

  it('dropFilteredPhotosFromDescribeAndScoringSelection', () => {
    const { kept, heldBack } = dropFilteredPhotosFromDescribeAndScoringSelection(db, pairs);
    expect(kept).toHaveLength(0);
    expect(heldBack).toMatchObject({ filtered_by_culling_profile: 1, no_verdict: N - 1 });
  });
});

describe('dropFilteredPhotosFromDescribeAndScoringSelection', () => {
  it('keeps passed photos and photos sent by hand, in order; holds back the rest by reason', () => {
    summary('profile', 'filtered', 'culling_profile');
    summary('forecast', 'filtered', 'score_forecast');
    summary('passed', 'passed');
    summary('pending', 'pending');
    summary('hand', 'filtered', 'culling_profile');
    recordCullUserAction(db, 'hand', 'sent_by_hand');
    const selection = ['passed', 'profile', 'none', 'hand', 'forecast', 'pending'].map((k) => [k, 'catalog'] as const);
    const { kept, heldBack, sentByHandKept } = dropFilteredPhotosFromDescribeAndScoringSelection(db, selection);
    expect(kept).toEqual([
      ['passed', 'catalog'],
      ['hand', 'catalog'],
    ]);
    expect(heldBack).toEqual({ filtered_by_culling_profile: 1, filtered_by_score_forecast: 1, pending: 1, no_verdict: 1 });
    expect(sentByHandKept).toEqual(['hand']);
  });
});
