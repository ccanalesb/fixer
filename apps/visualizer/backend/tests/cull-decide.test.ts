/**
 * The cull's decision rules, pure: level readout, recipe rules, Score forecast, the summary.
 * Numbers follow the research readout (ticket 09): top level, fails at ≤ 4 and strong at ≥ 8 on 1–10.
 */
import { describe, expect, it } from 'vitest';
import {
  decidePhoto,
  decideRecipeLevelSet,
  levelSetReadout,
  requiredStages,
  scoreForecastHighestP8,
  topLevel,
} from '../src/cull/decide.js';
import { DEFAULT_SCORE_FORECAST } from '../src/cull/default-pipeline.js';
import type { PipelineSettingConfig, RecipeRule, ResolvedStage, StageAnswers } from '../src/cull/types.js';

const DIMS = ['immediate-impact', 'visual-structure', 'point-of-tension', 'connotation'];

const VIDEO_LENIENT: RecipeRule = {
  level_sets: { '7': { fails_at_most: 3, strong_at_least: 6 }, '10': { fails_at_most: 4, strong_at_least: 8 } },
  combine: 'every',
  cut_rule: { type: 'all_fail', dimensions: ['point-of-tension', 'connotation'] },
};

const PIPELINE: PipelineSettingConfig = {
  culling_recipes: [{ recipe_slug: 'recipe-7h47', rule: VIDEO_LENIENT, run_after_cut: true }],
  score_forecast: { ...DEFAULT_SCORE_FORECAST },
};

const stage = (stageKey: string, extra: Partial<ResolvedStage> = {}): ResolvedStage => ({
  stageKey,
  kind: 'culling_recipe',
  versionId: 1,
  model: 'base',
  modelId: 'base@1',
  recipeSlug: 'recipe-7h47',
  levelSet: stageKey.split(':')[2] ?? null,
  questions: {},
  ...extra,
});

const S7 = stage('culling_recipe:recipe-7h47:7');
const S10 = stage('culling_recipe:recipe-7h47:10');
const SF = stage('score_forecast', { kind: 'score_forecast', model: 'new', recipeSlug: null, levelSet: null });
const STAGES = [S7, S10, SF];

/** A one-hot answer at `level` (1-based) out of `n`. */
const at = (level: number, n: number): number[] => Array.from({ length: n }, (_, i) => (i === level - 1 ? 1 : 0));

/** Recipe answers: levels for impact, structure, tension, connotation. */
function recipe(n: number, levels: [number, number, number, number]): StageAnswers {
  return Object.fromEntries(DIMS.map((d, i) => [d, at(levels[i]!, n)]));
}

/** Laya new answers with the given P(≥ 8) per perspective and P(no framing device). */
function forecast(p8: Record<string, number>, pExcused = 0): StageAnswers {
  const out: StageAnswers = { 'framing-excusal': [pExcused, 1 - pExcused] };
  for (const [slug, p] of Object.entries(p8)) {
    out[slug] = [1 - p, 0, 0, 0, 0, 0, 0, p, 0, 0];
  }
  return out;
}

const PASSING_FORECAST = forecast({ framing: 0.5, 'compositional-cleanliness': 0.2 });

describe('level readout', () => {
  it('takes the first maximum on ties, as numpy argmax does', () => {
    expect(topLevel([0.1, 0.4, 0.4, 0.1])).toBe(2);
    expect(topLevel([0.7, 0.3])).toBe(1);
  });

  it('fails at L1–L3 and is strong at L6–L7 on 7 levels; L1–L4 and L8–L10 on 10', () => {
    const r7 = levelSetReadout(recipe(7, [3, 4, 6, 7]), VIDEO_LENIENT.level_sets['7']!);
    expect(r7['immediate-impact']).toEqual({ level: 3, fails: true, strong: false });
    expect(r7['visual-structure']).toEqual({ level: 4, fails: false, strong: false });
    expect(r7['point-of-tension']!.strong).toBe(true);
    const r10 = levelSetReadout(recipe(10, [4, 5, 7, 8]), VIDEO_LENIENT.level_sets['10']!);
    expect(r10['immediate-impact']!.fails).toBe(true);
    expect(r10['visual-structure']!.fails).toBe(false);
    expect(r10['point-of-tension']!.strong).toBe(false);
    expect(r10['connotation']!.strong).toBe(true);
  });
});

describe('recipe rules on one level set', () => {
  it('video lenient cuts only when point of tension and connotation both fail', () => {
    expect(decideRecipeLevelSet(VIDEO_LENIENT, '10', recipe(10, [9, 9, 3, 4])).verdict).toBe('cut');
    expect(decideRecipeLevelSet(VIDEO_LENIENT, '10', recipe(10, [1, 1, 3, 5])).verdict).toBe('sent');
    expect(decideRecipeLevelSet(VIDEO_LENIENT, '10', recipe(10, [1, 1, 5, 3])).verdict).toBe('sent');
  });

  it('N or more fail unless one is strong', () => {
    const rule: RecipeRule = { ...VIDEO_LENIENT, cut_rule: { type: 'n_fail_unless_strong', n: 2 } };
    expect(decideRecipeLevelSet(rule, '10', recipe(10, [6, 6, 4, 6])).verdict).toBe('sent');
    expect(decideRecipeLevelSet(rule, '10', recipe(10, [7, 3, 3, 5])).verdict).toBe('cut');
    expect(decideRecipeLevelSet(rule, '10', recipe(10, [5, 3, 9, 3])).verdict).toBe('sent');
  });

  it('the average fails', () => {
    const rule: RecipeRule = { ...VIDEO_LENIENT, cut_rule: { type: 'mean_fail' } };
    expect(decideRecipeLevelSet(rule, '10', recipe(10, [2, 4, 5, 5])).verdict).toBe('cut');
    expect(decideRecipeLevelSet(rule, '10', recipe(10, [2, 4, 6, 5])).verdict).toBe('sent');
  });
});

describe('Score forecast', () => {
  it('is the highest P(levels 8–10) across perspectives', () => {
    expect(scoreForecastHighestP8(forecast({ framing: 0.05, 'intensity-suggestion': 0.2 }), DEFAULT_SCORE_FORECAST)).toBeCloseTo(0.2);
  });

  it('leaves framing out when P(no framing device) ≥ 0.5, and keeps it below', () => {
    const answers = (pExcused: number) => forecast({ framing: 0.9, 'intensity-suggestion': 0.1 }, pExcused);
    expect(scoreForecastHighestP8(answers(0.5), DEFAULT_SCORE_FORECAST)).toBeCloseTo(0.1);
    expect(scoreForecastHighestP8(answers(0.49), DEFAULT_SCORE_FORECAST)).toBeCloseTo(0.9);
  });

  it('cuts below 0.111 and sends at exactly 0.111', () => {
    const p = (v: number) => ({ [S7.stageKey]: recipe(7, [5, 5, 5, 5]), [S10.stageKey]: recipe(10, [5, 5, 5, 5]), score_forecast: forecast({ framing: v }) });
    expect(decidePhoto(PIPELINE, STAGES, p(0.1109), {}).verdict).toBe('cut');
    expect(decidePhoto(PIPELINE, STAGES, p(0.111), {}).verdict).toBe('sent');
  });
});

describe('the photo summary', () => {
  const cut7 = recipe(7, [5, 5, 2, 3]);
  const cut10 = recipe(10, [5, 5, 3, 4]);
  const pass7 = recipe(7, [5, 5, 5, 5]);
  const pass10 = recipe(10, [5, 5, 5, 5]);

  it('the recipe cuts only when both level sets cut', () => {
    const both = decidePhoto(PIPELINE, STAGES, { [S7.stageKey]: cut7, [S10.stageKey]: cut10, score_forecast: PASSING_FORECAST }, {});
    expect(both).toMatchObject({ verdict: 'cut', cutBy: 'culling_recipe', cutByStageKey: null });
    expect(both.stages[S7.stageKey]!.verdict).toBe('cut');
    const one = decidePhoto(PIPELINE, STAGES, { [S7.stageKey]: pass7, [S10.stageKey]: cut10, score_forecast: PASSING_FORECAST }, {});
    expect(one.verdict).toBe('sent');
    expect(one.stages[S10.stageKey]!.verdict).toBe('cut');
  });

  it('with "any", one level set cutting is enough', () => {
    const any: PipelineSettingConfig = {
      ...PIPELINE,
      culling_recipes: [{ ...PIPELINE.culling_recipes[0]!, rule: { ...VIDEO_LENIENT, combine: 'any' } }],
    };
    const d = decidePhoto(any, STAGES, { [S7.stageKey]: pass7, [S10.stageKey]: cut10, score_forecast: PASSING_FORECAST }, {});
    expect(d.verdict).toBe('cut');
  });

  it('a photo with no 7-level answer is not cut by the recipe, and stays pending', () => {
    const d = decidePhoto(PIPELINE, STAGES, { [S10.stageKey]: cut10, score_forecast: PASSING_FORECAST }, {});
    expect(d.verdict).toBe('pending');
    expect(d.cutBy).toBeNull();
    expect(d.pendingStages).toEqual([S7.stageKey]);
  });

  it('a pending recipe does not hide a Score forecast cut', () => {
    const d = decidePhoto(PIPELINE, STAGES, { [S10.stageKey]: cut10, score_forecast: forecast({ framing: 0.036 }) }, {});
    expect(d).toMatchObject({ verdict: 'cut', cutBy: 'score_forecast' });
  });

  it('reports the recipe first when both stages cut', () => {
    const d = decidePhoto(PIPELINE, STAGES, { [S7.stageKey]: cut7, [S10.stageKey]: cut10, score_forecast: forecast({ framing: 0.01 }) }, {});
    expect(d.cutBy).toBe('culling_recipe');
  });

  it('ticket 15: the recipe sends it, Score forecast 0.036 cuts it', () => {
    const d = decidePhoto(PIPELINE, STAGES, { [S7.stageKey]: pass7, [S10.stageKey]: pass10, score_forecast: forecast({ framing: 0.036, 'intensity-suggestion': 0.02 }) }, {});
    expect(d).toMatchObject({ verdict: 'cut', cutBy: 'score_forecast', cutByStageKey: 'score_forecast' });
    expect(d.scoreForecastP8).toBeCloseTo(0.036);
  });

  it('sent by hand is sent whatever the stages say, and the override is reported', () => {
    const answers = { [S7.stageKey]: cut7, [S10.stageKey]: cut10, score_forecast: PASSING_FORECAST };
    const d = decidePhoto(PIPELINE, STAGES, answers, { sentByHand: true });
    expect(d).toMatchObject({ verdict: 'sent', cutBy: null, sentByHandOverride: true });
    expect(d.stages[S7.stageKey]!.verdict).toBe('cut');
    const passed = decidePhoto(PIPELINE, STAGES, { [S7.stageKey]: pass7, [S10.stageKey]: pass10, score_forecast: PASSING_FORECAST }, { sentByHand: true });
    expect(passed.sentByHandOverride).toBe(false);
  });

  it('without Laya new the recipe alone decides', () => {
    const d = decidePhoto(PIPELINE, STAGES, { [S7.stageKey]: pass7, [S10.stageKey]: pass10 }, { scoreForecastAvailable: false });
    expect(d).toMatchObject({ verdict: 'sent', pendingStages: [], scoreForecastP8: null });
  });

  it('a stage that is switched off for cut photos is not required once the recipe cut', () => {
    const off: PipelineSettingConfig = { ...PIPELINE, score_forecast: { ...PIPELINE.score_forecast, run_after_cut: false } };
    const cutAnswers = { [S7.stageKey]: cut7, [S10.stageKey]: cut10 };
    expect(requiredStages(off, STAGES, cutAnswers, {}).map((s) => s.stageKey)).toEqual([S7.stageKey, S10.stageKey]);
    expect(decidePhoto(off, STAGES, cutAnswers, {}).verdict).toBe('cut');
    const passAnswers = { [S7.stageKey]: pass7, [S10.stageKey]: pass10 };
    expect(requiredStages(off, STAGES, passAnswers, {}).map((s) => s.stageKey)).toContain('score_forecast');
    expect(requiredStages(PIPELINE, STAGES, cutAnswers, {}).map((s) => s.stageKey)).toContain('score_forecast');
  });
});
