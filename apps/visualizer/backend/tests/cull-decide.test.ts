/**
 * The cull's decision rules, pure: level readout, profile rules, Score forecast, the summary.
 * Readout: top level, fails at ≤ 4 and strong at ≥ 8 on 1–10.
 */
import { describe, expect, it } from 'vitest';
import {
  decidePhoto,
  decideProfileLevelSet,
  levelSetReadout,
  requiredStages,
  scoreForecastHighestP8,
  topLevel,
} from '../src/cull/decide.js';
import { DEFAULT_SCORE_FORECAST } from '../src/cull/default-pipeline.js';
import type { PipelineSettingConfig, ProfileRule, ResolvedStage, StageAnswers } from '../src/cull/types.js';

const DIMS = ['immediate-impact', 'visual-structure', 'point-of-tension', 'connotation'];

const VIDEO_LENIENT: ProfileRule = {
  level_sets: { '7': { fails_at_most: 3, strong_at_least: 6 }, '10': { fails_at_most: 4, strong_at_least: 8 } },
  combine: 'every',
  filter_rule: { type: 'all_fail', dimensions: ['point-of-tension', 'connotation'] },
};

const PIPELINE: PipelineSettingConfig = {
  culling_profiles_enabled: true,
  culling_profiles_filter_enabled: true,
  culling_profiles: [{ profile_slug: 'default', rule: VIDEO_LENIENT }],
  score_forecast: { ...DEFAULT_SCORE_FORECAST, enabled: true },
};

const stage = (stageKey: string, extra: Partial<ResolvedStage> = {}): ResolvedStage => ({
  stageKey,
  kind: 'culling_profile',
  versionId: 1,
  modelId: 'base@1',
  profileSlug: 'default',
  levelSet: stageKey.split(':')[2] ?? null,
  questions: {},
  ...extra,
});

const S7 = stage('culling_profile:default:7');
const S10 = stage('culling_profile:default:10');
const SF = stage('score_forecast', { kind: 'score_forecast', profileSlug: null, levelSet: null });
const STAGES = [S7, S10, SF];

/** A one-hot answer at `level` (1-based) out of `n`. */
const at = (level: number, n: number): number[] => Array.from({ length: n }, (_, i) => (i === level - 1 ? 1 : 0));

/** Profile answers: levels for impact, structure, tension, connotation. */
function profile(n: number, levels: [number, number, number, number]): StageAnswers {
  return Object.fromEntries(DIMS.map((d, i) => [d, at(levels[i]!, n)]));
}

/** Score forecast answers with the given P(≥ 8) per perspective and P(no framing device). */
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
    const r7 = levelSetReadout(profile(7, [3, 4, 6, 7]), VIDEO_LENIENT.level_sets['7']!);
    expect(r7['immediate-impact']).toEqual({ level: 3, fails: true, strong: false });
    expect(r7['visual-structure']).toEqual({ level: 4, fails: false, strong: false });
    expect(r7['point-of-tension']!.strong).toBe(true);
    const r10 = levelSetReadout(profile(10, [4, 5, 7, 8]), VIDEO_LENIENT.level_sets['10']!);
    expect(r10['immediate-impact']!.fails).toBe(true);
    expect(r10['visual-structure']!.fails).toBe(false);
    expect(r10['point-of-tension']!.strong).toBe(false);
    expect(r10['connotation']!.strong).toBe(true);
  });
});

describe('profile rules on one level set', () => {
  it('video lenient filters only when point of tension and connotation both fail', () => {
    expect(decideProfileLevelSet(VIDEO_LENIENT, '10', profile(10, [9, 9, 3, 4])).verdict).toBe('filtered');
    expect(decideProfileLevelSet(VIDEO_LENIENT, '10', profile(10, [1, 1, 3, 5])).verdict).toBe('passed');
    expect(decideProfileLevelSet(VIDEO_LENIENT, '10', profile(10, [1, 1, 5, 3])).verdict).toBe('passed');
  });

  it('N or more fail unless one is strong', () => {
    const rule: ProfileRule = { ...VIDEO_LENIENT, filter_rule: { type: 'n_fail_unless_strong', n: 2 } };
    expect(decideProfileLevelSet(rule, '10', profile(10, [6, 6, 4, 6])).verdict).toBe('passed');
    expect(decideProfileLevelSet(rule, '10', profile(10, [7, 3, 3, 5])).verdict).toBe('filtered');
    expect(decideProfileLevelSet(rule, '10', profile(10, [5, 3, 9, 3])).verdict).toBe('passed');
  });

  it('the average fails', () => {
    const rule: ProfileRule = { ...VIDEO_LENIENT, filter_rule: { type: 'mean_fail' } };
    expect(decideProfileLevelSet(rule, '10', profile(10, [2, 4, 5, 5])).verdict).toBe('filtered');
    expect(decideProfileLevelSet(rule, '10', profile(10, [2, 4, 6, 5])).verdict).toBe('passed');
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

  it('filters below 0.111 and passes at exactly 0.111', () => {
    const p = (v: number) => ({ [S7.stageKey]: profile(7, [5, 5, 5, 5]), [S10.stageKey]: profile(10, [5, 5, 5, 5]), score_forecast: forecast({ framing: v }) });
    expect(decidePhoto(PIPELINE, STAGES, p(0.1109), {}).verdict).toBe('filtered');
    expect(decidePhoto(PIPELINE, STAGES, p(0.111), {}).verdict).toBe('passed');
  });
});

describe('the photo summary', () => {
  const cut7 = profile(7, [5, 5, 2, 3]);
  const cut10 = profile(10, [5, 5, 3, 4]);
  const pass7 = profile(7, [5, 5, 5, 5]);
  const pass10 = profile(10, [5, 5, 5, 5]);

  it('the profile filters only when both level sets filter', () => {
    const both = decidePhoto(PIPELINE, STAGES, { [S7.stageKey]: cut7, [S10.stageKey]: cut10, score_forecast: PASSING_FORECAST }, {});
    expect(both).toMatchObject({ verdict: 'filtered', filteredBy: 'culling_profile', filteredByStageKey: S7.stageKey });
    expect(both.stages[S7.stageKey]!.verdict).toBe('filtered');
    const one = decidePhoto(PIPELINE, STAGES, { [S7.stageKey]: pass7, [S10.stageKey]: cut10, score_forecast: PASSING_FORECAST }, {});
    expect(one.verdict).toBe('passed');
    expect(one.stages[S10.stageKey]!.verdict).toBe('filtered');
  });

  it('with "any", one level set cutting is enough', () => {
    const any: PipelineSettingConfig = {
      ...PIPELINE,
      culling_profiles: [{ ...PIPELINE.culling_profiles[0]!, rule: { ...VIDEO_LENIENT, combine: 'any' } }],
    };
    const d = decidePhoto(any, STAGES, { [S7.stageKey]: pass7, [S10.stageKey]: cut10, score_forecast: PASSING_FORECAST }, {});
    expect(d).toMatchObject({ verdict: 'filtered', filteredByStageKey: S10.stageKey });
  });

  it('a photo with no 7-level answer is not filtered by the profile, and stays pending', () => {
    const d = decidePhoto(PIPELINE, STAGES, { [S10.stageKey]: cut10, score_forecast: PASSING_FORECAST }, {});
    expect(d.verdict).toBe('pending');
    expect(d.filteredBy).toBeNull();
    expect(d.pendingStages).toEqual([S7.stageKey]);
  });

  it('a pending profile does not hide a Score forecast filter', () => {
    const d = decidePhoto(PIPELINE, STAGES, { [S10.stageKey]: cut10, score_forecast: forecast({ framing: 0.036 }) }, {});
    expect(d).toMatchObject({ verdict: 'filtered', filteredBy: 'score_forecast' });
  });

  it('reports the profile first when both stages filter', () => {
    const d = decidePhoto(PIPELINE, STAGES, { [S7.stageKey]: cut7, [S10.stageKey]: cut10, score_forecast: forecast({ framing: 0.01 }) }, {});
    expect(d.filteredBy).toBe('culling_profile');
  });

  it('a photo the profile passes is filtered when the Score forecast is below the threshold', () => {
    const d = decidePhoto(PIPELINE, STAGES, { [S7.stageKey]: pass7, [S10.stageKey]: pass10, score_forecast: forecast({ framing: 0.036, 'intensity-suggestion': 0.02 }) }, {});
    expect(d).toMatchObject({ verdict: 'filtered', filteredBy: 'score_forecast', filteredByStageKey: 'score_forecast' });
    expect(d.scoreForecastP8).toBeCloseTo(0.036);
  });

  it('sent by hand passes whatever the stages say, and the override is reported', () => {
    const answers = { [S7.stageKey]: cut7, [S10.stageKey]: cut10, score_forecast: PASSING_FORECAST };
    const d = decidePhoto(PIPELINE, STAGES, answers, { sentByHand: true });
    expect(d).toMatchObject({ verdict: 'passed', filteredBy: null, sentByHandOverride: true });
    expect(d.stages[S7.stageKey]!.verdict).toBe('filtered');
    const passed = decidePhoto(PIPELINE, STAGES, { [S7.stageKey]: pass7, [S10.stageKey]: pass10, score_forecast: PASSING_FORECAST }, { sentByHand: true });
    expect(passed.sentByHandOverride).toBe(false);
  });

  it('without the forecast model the profile alone decides', () => {
    const d = decidePhoto(PIPELINE, STAGES, { [S7.stageKey]: pass7, [S10.stageKey]: pass10 }, { scoreForecastAvailable: false });
    expect(d).toMatchObject({ verdict: 'passed', pendingStages: [], scoreForecastP8: null });
  });

  it('every stage that is on is required, even once the profile filtered', () => {
    const cutAnswers = { [S7.stageKey]: cut7, [S10.stageKey]: cut10 };
    expect(requiredStages(PIPELINE, STAGES, cutAnswers, {}).map((s) => s.stageKey)).toEqual([S7.stageKey, S10.stageKey, 'score_forecast']);
    expect(decidePhoto(PIPELINE, STAGES, cutAnswers, {})).toMatchObject({ verdict: 'filtered', pendingStages: ['score_forecast'] });
  });
});

describe('the switches: culling profile, its filter, Score forecast', () => {
  const ruleFilters = { [S7.stageKey]: profile(7, [5, 5, 2, 3]), [S10.stageKey]: profile(10, [5, 5, 3, 4]) };
  const rulePasses = { [S7.stageKey]: profile(7, [5, 5, 5, 5]), [S10.stageKey]: profile(10, [5, 5, 5, 5]) };
  const forecastFilters = { score_forecast: forecast({ framing: 0.01 }) };
  const forecastPasses = { score_forecast: PASSING_FORECAST };
  const cfg = (profiles: boolean, filter: boolean, forecastOn: boolean): PipelineSettingConfig => ({
    ...PIPELINE,
    culling_profiles_enabled: profiles,
    culling_profiles_filter_enabled: filter,
    score_forecast: { ...PIPELINE.score_forecast, enabled: forecastOn },
  });
  const required = (c: PipelineSettingConfig) => requiredStages(c, STAGES, {}, {}).map((s) => s.stageKey);

  describe('all three on', () => {
    const on = cfg(true, true, true);
    it('filters when the rule filters, or when the Score forecast filters', () => {
      expect(decidePhoto(on, STAGES, { ...ruleFilters, ...forecastPasses }, {})).toMatchObject({ verdict: 'filtered', filteredBy: 'culling_profile' });
      expect(decidePhoto(on, STAGES, { ...rulePasses, ...forecastFilters }, {})).toMatchObject({ verdict: 'filtered', filteredBy: 'score_forecast' });
      expect(decidePhoto(on, STAGES, { ...rulePasses, ...forecastPasses }, {}).verdict).toBe('passed');
    });
    it('reports what the culling profile says, for stars and reject', () => {
      expect(decidePhoto(on, STAGES, { ...ruleFilters, ...forecastPasses }, {}).cullingProfileVerdict).toBe('filtered');
      expect(decidePhoto(on, STAGES, { ...rulePasses, ...forecastFilters }, {}).cullingProfileVerdict).toBe('passed');
    });
    it('requires every stage', () => expect(required(on)).toEqual([S7.stageKey, S10.stageKey, 'score_forecast']));
  });

  describe("the culling profile's filter off", () => {
    const noFilter = cfg(true, false, true);
    it('only the Score forecast filters', () => {
      expect(decidePhoto(noFilter, STAGES, { ...ruleFilters, ...forecastPasses }, {})).toMatchObject({ verdict: 'passed', filteredBy: null });
      expect(decidePhoto(noFilter, STAGES, { ...rulePasses, ...forecastFilters }, {})).toMatchObject({ verdict: 'filtered', filteredBy: 'score_forecast' });
    });
    it('reject still follows the rule: the culling profile says filtered on a photo that passes', () => {
      expect(decidePhoto(noFilter, STAGES, { ...ruleFilters, ...forecastPasses }, {}).cullingProfileVerdict).toBe('filtered');
    });
    it('still requires the culling profile, for stars, but a missing answer does not hold the photo pending', () => {
      expect(required(noFilter)).toEqual([S7.stageKey, S10.stageKey, 'score_forecast']);
      expect(decidePhoto(noFilter, STAGES, forecastPasses, {})).toMatchObject({
        verdict: 'passed',
        pendingStages: [S7.stageKey, S10.stageKey],
        cullingProfileVerdict: null,
      });
    });
  });

  describe('Score forecast off', () => {
    const noForecast = cfg(true, true, false);
    it('the rule decides', () => {
      expect(decidePhoto(noForecast, STAGES, { ...ruleFilters, ...forecastFilters }, {})).toMatchObject({ verdict: 'filtered', filteredBy: 'culling_profile' });
      expect(decidePhoto(noForecast, STAGES, { ...rulePasses, ...forecastFilters }, {})).toMatchObject({ verdict: 'passed', scoreForecastP8: null });
    });
    it('does not require the Score forecast', () => expect(required(noForecast)).toEqual([S7.stageKey, S10.stageKey]));
    it('a missing profile answer holds the photo pending, as the rule needs it', () => {
      expect(decidePhoto(noForecast, STAGES, { [S10.stageKey]: profile(10, [5, 5, 5, 5]) }, {})).toMatchObject({
        verdict: 'pending',
        pendingStages: [S7.stageKey],
      });
    });
  });

  describe('culling profile off', () => {
    const noProfile = cfg(false, true, true);
    it('only the Score forecast filters, whatever its filter switch says', () => {
      expect(decidePhoto(noProfile, STAGES, { ...ruleFilters, ...forecastPasses }, {})).toMatchObject({ verdict: 'passed', filteredBy: null });
      expect(decidePhoto(noProfile, STAGES, forecastFilters, {})).toMatchObject({ verdict: 'filtered', filteredBy: 'score_forecast' });
    });
    it('gives nothing for stars or reject', () => {
      expect(decidePhoto(noProfile, STAGES, { ...ruleFilters, ...forecastPasses }, {}).cullingProfileVerdict).toBeNull();
    });
    it('does not require the culling profile', () => expect(required(noProfile)).toEqual(['score_forecast']));
  });

  describe('both filters off', () => {
    it('every photo passes; the culling profile is still asked for stars and reject', () => {
      const c = cfg(true, false, false);
      expect(decidePhoto(c, STAGES, { ...ruleFilters, ...forecastFilters }, {})).toMatchObject({
        verdict: 'passed',
        filteredBy: null,
        cullingProfileVerdict: 'filtered',
      });
      expect(required(c)).toEqual([S7.stageKey, S10.stageKey]);
    });
    it('with the culling profile off too, nothing is asked and every photo passes', () => {
      const c = cfg(false, false, false);
      expect(required(c)).toEqual([]);
      expect(decidePhoto(c, STAGES, {}, {})).toMatchObject({ verdict: 'passed', pendingStages: [], cullingProfileVerdict: null });
    });
  });

  it('sent by hand passes, and the culling profile verdict still says what the rule did', () => {
    const d = decidePhoto(PIPELINE, STAGES, { ...ruleFilters, ...forecastPasses }, { sentByHand: true });
    expect(d).toMatchObject({ verdict: 'passed', sentByHandOverride: true, cullingProfileVerdict: 'filtered' });
  });
});
