/**
 * Cull storage in `library.db`: the migration and seed, recipe and stage versions, the pipeline
 * setting, stage answers and the user-action history.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';
import { openLibraryDb, type Db } from '../src/db/connection.js';
import { initLibraryDb, LIBRARY_SCHEMA_VERSION, upgradeLibrarySchema } from '../src/db/library/bootstrap.js';
import { createPipelineSettingVersion, getCurrentPipelineSetting } from '../src/db/library/cull-pipeline.js';
import {
  CULL_DEFAULTS_SEEDED_META_KEY,
  getCullRecipe,
  listCullRecipes,
  saveRecipeDefinition,
  seedCullingDefaults,
  setRecipeRule,
} from '../src/db/library/cull-recipes.js';
import {
  getOrCreateStageVersion,
  loadCurrentStageAnswers,
  readStoredLayaModelIds,
  upsertStageAnswer,
} from '../src/db/library/cull-stages.js';
import { isSentByHand, listCullUserActions, recordCullUserAction } from '../src/db/library/cull-user-actions.js';
import {
  getCullVerdict,
  insertCullRun,
  isPhotoCutAndNotSentByHand,
  listCulledImageKeys,
  loadCullVerdictsForKeys,
  upsertCullVerdict,
} from '../src/db/library/cull-verdicts.js';
import { listCatalogImagesForFrameSubstance } from '../src/db/library/frame-substance.js';
import {
  filterCutPhotosFromDescribeAndScoringSelection,
  filterVoidSubstanceFromScoringSelection,
} from '../src/jobs/handlers/common.js';
import { resolveCurrentStages } from '../src/cull/stages.js';
import { LAYA_QUESTIONS } from '../src/laya/questions.js';
import type { RecipeDefinition } from '../src/cull/types.js';

const CULL_TABLES = [
  'cull_pipeline_settings',
  'cull_recipe_versions',
  'cull_recipes',
  'cull_runs',
  'cull_stage_answers',
  'cull_stage_versions',
  'cull_user_actions',
  'cull_verdicts',
];
const MODEL_IDS = { base: 'thaitea/laya-vision@8b318c9', new: 'laya-new@sha256:abc' };

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-cull-storage-'));
  db = initLibraryDb(join(dir, 'library.db'));
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
  it('a fresh library has every cull table, recipe 7H47 and the default pipeline setting', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(LIBRARY_SCHEMA_VERSION);
    expect(LIBRARY_SCHEMA_VERSION).toBe(13);
    expect(tables(db)).toEqual(CULL_TABLES);
    const recipe = getCullRecipe(db, 'recipe-7h47')!;
    expect(recipe).toMatchObject({ name: 'Recipe 7H47', model: 'laya-base', active: true, measured: true });
    expect(recipe.definition.dimensions.map((d) => d.slug)).toEqual([
      'immediate-impact',
      'visual-structure',
      'point-of-tension',
      'connotation',
    ]);
    expect(recipe.definition.level_sets.map((s) => s.id)).toEqual(['7', '10']);
    const pipeline = getCurrentPipelineSetting(db);
    expect(pipeline.version).toBe(1);
    expect(pipeline.config.culling_recipes).toEqual([
      { recipe_slug: 'recipe-7h47', rule: recipe.rule, run_after_cut: true },
    ]);
    expect(recipe.rule).toEqual({
      level_sets: { '7': { fails_at_most: 3, strong_at_least: 6 }, '10': { fails_at_most: 4, strong_at_least: 8 } },
      combine: 'every',
      cut_rule: { type: 'all_fail', dimensions: ['point-of-tension', 'connotation'] },
    });
    expect(pipeline.config.score_forecast).toMatchObject({ enabled: true, threshold: 0.111 });
  });

  it('upgrades a version 10 library, once; a deleted recipe is not seeded again', () => {
    for (const t of CULL_TABLES) db.exec(`DROP TABLE ${t}`);
    db.prepare('DELETE FROM library_meta WHERE key = ?').run(CULL_DEFAULTS_SEEDED_META_KEY);
    db.pragma('user_version = 10');
    db.close();

    db = openLibraryDb(join(dir, 'library.db'));
    upgradeLibrarySchema(db);
    expect(db.pragma('user_version', { simple: true })).toBe(13);
    expect(tables(db)).toEqual(CULL_TABLES);
    expect(listCullRecipes(db).map((r) => r.slug)).toEqual(['recipe-7h47']);

    db.exec('DELETE FROM cull_recipe_versions; DELETE FROM cull_recipes');
    expect(seedCullingDefaults(db)).toBe(false);
    upgradeLibrarySchema(db);
    expect(listCullRecipes(db)).toEqual([]);
  });

  it('upgrades a version 12 library: keeps the stored actions and accepts agrees_with_pass', () => {
    recordCullUserAction(db, 'a', 'should_have_been_cut', '2026-10-19T10:00:00+00:00');
    db.exec(`
      ALTER TABLE cull_user_actions RENAME TO cull_user_actions_new;
      CREATE TABLE cull_user_actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          image_key TEXT NOT NULL,
          action TEXT NOT NULL
              CHECK (action IN ('sent_by_hand','agrees_with_cut','should_have_been_cut')),
          acted_at TEXT NOT NULL,
          answered_verdict TEXT NOT NULL,
          answered_cut_by TEXT,
          answered_pipeline_setting_version INTEGER,
          answered_stage_version_ids TEXT NOT NULL DEFAULT '[]'
      );
      INSERT INTO cull_user_actions SELECT * FROM cull_user_actions_new;
      DROP TABLE cull_user_actions_new;
    `);
    db.pragma('user_version = 12');
    expect(() => recordCullUserAction(db, 'a', 'agrees_with_pass')).toThrow();
    db.close();

    db = openLibraryDb(join(dir, 'library.db'));
    upgradeLibrarySchema(db);
    expect(db.pragma('user_version', { simple: true })).toBe(13);
    expect(listCullUserActions(db, 'a').map((r) => r.action)).toEqual(['should_have_been_cut']);
    recordCullUserAction(db, 'a', 'agrees_with_pass', '2026-10-19T11:00:00+00:00');
    expect(listCullUserActions(db, 'a').map((r) => r.action)).toEqual(['should_have_been_cut', 'agrees_with_pass']);
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_cull_user_actions_image'").get(),
    ).toBeDefined();
  });

  it('is not marked seeded until a pipeline setting exists', () => {
    for (const t of CULL_TABLES) db.exec(`DELETE FROM ${t}`);
    db.prepare('DELETE FROM library_meta WHERE key = ?').run(CULL_DEFAULTS_SEEDED_META_KEY);
    expect(seedCullingDefaults(db, join(dir, 'no-seeds'))).toBe(false);
    expect(db.prepare('SELECT 1 FROM library_meta WHERE key = ?').get(CULL_DEFAULTS_SEEDED_META_KEY)).toBeUndefined();
    expect(seedCullingDefaults(db)).toBe(true);
    expect(getCurrentPipelineSetting(db).version).toBeGreaterThan(0);
  });

  it('the seed file is the recipe the research ran: #337’s questions, word for word', () => {
    const seed = JSON.parse(
      readFileSync(join(REPO_ROOT, 'prompts', 'culling-recipes', 'recipe-7h47.json'), 'utf8'),
    ) as { definition: RecipeDefinition };
    const stages = resolveCurrentStages(db, getCurrentPipelineSetting(db).config, MODEL_IDS);
    for (const set of seed.definition.level_sets) {
      const stage = stages.find((s) => s.stageKey === `culling_recipe:recipe-7h47:${set.id}`)!;
      const asked = Object.values(stage.questions);
      const research = Object.entries(LAYA_QUESTIONS.base)
        .filter(([qid]) => qid.startsWith(`${set.id}|`))
        .map(([, q]) => q);
      expect(asked).toEqual(research);
    }
  });
});

describe('versions', () => {
  const current = () => resolveCurrentStages(db, getCurrentPipelineSetting(db).config, MODEL_IDS);
  const byKey = (key: string) => current().find((s) => s.stageKey === key)!;
  const S7 = 'culling_recipe:recipe-7h47:7';
  const S10 = 'culling_recipe:recipe-7h47:10';

  function editLevels(setId: string, edit: (levels: string[]) => string[]): RecipeDefinition {
    const def = structuredClone(getCullRecipe(db, 'recipe-7h47')!.definition);
    const set = def.level_sets.find((s) => s.id === setId)!;
    for (const dim of Object.keys(set.levels)) set.levels[dim] = edit(set.levels[dim]!);
    return def;
  }

  it('resolves three stages: recipe 7H47 at 7 and 10 levels and the Score forecast', () => {
    expect(current().map((s) => [s.stageKey, s.kind, s.model])).toEqual([
      [S7, 'culling_recipe', 'base'],
      [S10, 'culling_recipe', 'base'],
      ['score_forecast', 'score_forecast', 'new'],
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
      verdict: 'sent',
      decision: {},
      pipelineSettingVersion: 1,
      source: 'job',
      runId: run,
    });

    const saved = saveRecipeDefinition(db, 'recipe-7h47', editLevels('7', (l) => [...l.slice(0, 6), 'unforgettable']));
    expect(saved).toMatchObject({ created: true, version: 2 });
    expect(byKey(S7).versionId).not.toBe(old7);
    expect(byKey(S10).versionId).toBe(old10);
    expect(Object.keys(loadCurrentStageAnswers(db, current(), ['a']).get('a') ?? {})).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cull_stage_answers WHERE stage_version_id = ?').get(old7)).toEqual({ n: 1 });

    expect(saveRecipeDefinition(db, 'recipe-7h47', getCullRecipe(db, 'recipe-7h47')!.definition).created).toBe(false);
  });

  it('a level-count change makes a new version; reverting brings the old one and its rows back', () => {
    const old7 = byKey(S7).versionId;
    const original = getCullRecipe(db, 'recipe-7h47')!.definition;
    saveRecipeDefinition(db, 'recipe-7h47', editLevels('7', (l) => [...l, 'beyond words']));
    const seven = byKey(S7);
    expect(seven.versionId).not.toBe(old7);
    expect(Object.values(seven.questions)[0]!.criteria).toHaveLength(8);

    saveRecipeDefinition(db, 'recipe-7h47', original);
    expect(byKey(S7).versionId).toBe(old7);
    expect(getCullRecipe(db, 'recipe-7h47')!.version).toBe(1);
  });

  it('a new model makes a new stage version', () => {
    const old = byKey('score_forecast').versionId;
    const other = resolveCurrentStages(db, getCurrentPipelineSetting(db).config, { ...MODEL_IDS, new: 'laya-new@other' });
    expect(other.find((s) => s.stageKey === 'score_forecast')!.versionId).not.toBe(old);
  });

  it('getOrCreateStageVersion is idempotent per stage text and model', () => {
    const args = { stageKey: 'x', kind: 'score_forecast' as const, recipeSlug: null, levelSet: null, modelId: 'm', questions: {} };
    expect(getOrCreateStageVersion(db, args)).toBe(getOrCreateStageVersion(db, args));
  });

  it('a rule change is not a stage version: it makes a new pipeline-setting version', () => {
    const before = current().map((s) => s.versionId);
    const rule = { ...getCullRecipe(db, 'recipe-7h47')!.rule, combine: 'any' as const };
    setRecipeRule(db, 'recipe-7h47', rule);
    expect(getCullRecipe(db, 'recipe-7h47')!.rule.combine).toBe('any');
    const pipeline = getCurrentPipelineSetting(db);
    expect(pipeline.version).toBe(2);
    expect(pipeline.config.culling_recipes[0]!.rule.combine).toBe('any');
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
      recipeSlug: null,
      levelSet: null,
      modelId: 'm',
      questions: {},
    });
    const row = {
      imageKey: 'a',
      stageVersionId,
      answers: { x: [0.5, 0.5] },
      verdict: 'sent' as const,
      decision: {},
      pipelineSettingVersion: 1,
      source: 'job' as const,
      runId: run,
    };
    upsertStageAnswer(db, row);
    upsertStageAnswer(db, { ...row, verdict: 'cut' });
    expect(db.prepare('SELECT verdict FROM cull_stage_answers').all()).toEqual([{ verdict: 'cut' }]);
    expect(upsertStageAnswer(db, { ...row, verdict: 'sent' }, { ifAbsent: true })).toBe(false);
    expect(db.prepare('SELECT verdict FROM cull_stage_answers').all()).toEqual([{ verdict: 'cut' }]);
  });

  it('records each action with the verdict it answered; sent by hand sticks', () => {
    upsertCullVerdict(db, {
      imageKey: 'a',
      verdict: 'cut',
      cutBy: 'culling_recipe',
      cutByStageKey: null,
      sentByHand: false,
      pendingStages: [],
      pendingReason: '',
      scoreForecastOff: false,
      scoreForecastP8: 0.05,
      pipelineSettingVersion: 1,
      stageVersionIds: [1, 2, 3],
      runId: null,
    });
    recordCullUserAction(db, 'a', 'agrees_with_cut', '2026-10-19T10:00:00+00:00');
    recordCullUserAction(db, 'a', 'sent_by_hand', '2026-10-19T11:00:00+00:00');
    expect(listCullUserActions(db, 'a')).toEqual([
      expect.objectContaining({ action: 'agrees_with_cut', answered_verdict: 'cut', answered_cut_by: 'culling_recipe', acted_at: '2026-10-19T10:00:00+00:00' }),
      expect.objectContaining({ action: 'sent_by_hand', answered_verdict: 'cut', answered_stage_version_ids: [1, 2, 3] }),
    ]);
    expect(getCullVerdict(db, 'a')).toMatchObject({ verdict: 'sent', sent_by_hand: true, cut_by: null });
    expect(isSentByHand(db, 'a')).toBe(true);
    expect(isSentByHand(db, 'b')).toBe(false);
  });

  it('sending a photo with no verdict yet still sticks', () => {
    recordCullUserAction(db, 'z', 'sent_by_hand');
    expect(getCullVerdict(db, 'z')).toMatchObject({ verdict: 'sent', sent_by_hand: true });
    expect(listCullUserActions(db, 'z')[0]).toMatchObject({ answered_verdict: 'none' });
  });
});

const summary = (imageKey: string, verdict: 'cut' | 'sent' | 'pending', cutBy: 'culling_recipe' | 'score_forecast' | null = null) =>
  upsertCullVerdict(db, {
    imageKey,
    verdict,
    cutBy,
    cutByStageKey: null,
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
  it('isPhotoCutAndNotSentByHand: only a cut nobody sent on', () => {
    summary('cut', 'cut', 'culling_recipe');
    summary('sent', 'sent');
    summary('pending', 'pending');
    summary('hand', 'cut', 'score_forecast');
    recordCullUserAction(db, 'hand', 'sent_by_hand');
    expect(isPhotoCutAndNotSentByHand(db, 'cut')).toBe(true);
    for (const key of ['sent', 'pending', 'hand', 'never-culled']) expect(isPhotoCutAndNotSentByHand(db, key)).toBe(false);
  });

  it('a sent-by-hand action wins even over a summary that still says cut', () => {
    recordCullUserAction(db, 'a', 'sent_by_hand');
    summary('a', 'cut', 'culling_recipe');
    expect(isPhotoCutAndNotSentByHand(db, 'a')).toBe(false);
    expect(loadCullVerdictsForKeys(db, ['a']).get('a')).toMatchObject({ verdict: 'cut', sentByHand: true });
  });

  it('readStoredLayaModelIds: the model ids of the current stage versions, never the files', () => {
    expect(readStoredLayaModelIds(db)).toBeNull();
    resolveCurrentStages(db, getCurrentPipelineSetting(db).config, MODEL_IDS);
    expect(readStoredLayaModelIds(db)).toEqual(MODEL_IDS);
    resolveCurrentStages(db, getCurrentPipelineSetting(db).config, { base: 'other-base', new: null });
    // Laya new left out of a later run keeps its current version: the forecast is still on (G8).
    expect(readStoredLayaModelIds(db)).toEqual({ base: 'other-base', new: MODEL_IDS.new });
  });

  it('readStoredLayaModelIds: no Laya new without a Score forecast version', () => {
    resolveCurrentStages(db, getCurrentPipelineSetting(db).config, { base: MODEL_IDS.base, new: null });
    expect(readStoredLayaModelIds(db)).toEqual({ base: MODEL_IDS.base, new: null });
  });

  it('listCulledImageKeys: photos with a summary or a current answer', () => {
    summary('a', 'sent');
    const [stage] = resolveCurrentStages(db, getCurrentPipelineSetting(db).config, MODEL_IDS);
    const run = insertCullRun(db, { kind: 'job', jobId: null, pipelineSettingVersion: 1 });
    upsertStageAnswer(db, {
      imageKey: 'b',
      stageVersionId: stage!.versionId,
      answers: {},
      verdict: 'sent',
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
    summary(keys[N - 1]!, 'cut', 'culling_recipe');
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

  it('filterCutPhotosFromDescribeAndScoringSelection', () => {
    const { kept, heldBack } = filterCutPhotosFromDescribeAndScoringSelection(db, pairs);
    expect(kept).toHaveLength(0);
    expect(heldBack).toMatchObject({ cut_by_culling_recipe: 1, no_verdict: N - 1 });
  });
});

describe('filterCutPhotosFromDescribeAndScoringSelection', () => {
  it('keeps sent photos and photos sent by hand, in order; holds back the rest by reason', () => {
    summary('recipe', 'cut', 'culling_recipe');
    summary('forecast', 'cut', 'score_forecast');
    summary('sent', 'sent');
    summary('pending', 'pending');
    summary('hand', 'cut', 'culling_recipe');
    recordCullUserAction(db, 'hand', 'sent_by_hand');
    const selection = ['sent', 'recipe', 'none', 'hand', 'forecast', 'pending'].map((k) => [k, 'catalog'] as const);
    const { kept, heldBack, sentByHandKept } = filterCutPhotosFromDescribeAndScoringSelection(db, selection);
    expect(kept).toEqual([
      ['sent', 'catalog'],
      ['hand', 'catalog'],
    ]);
    expect(heldBack).toEqual({ cut_by_culling_recipe: 1, cut_by_score_forecast: 1, pending: 1, no_verdict: 1 });
    expect(sentByHandKept).toEqual(['hand']);
  });
});
