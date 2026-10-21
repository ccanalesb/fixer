/**
 * The pipeline setting a library starts with, and the check that a stored one still has its shape.
 *
 * Default (ticket 15): the research's recipe 7H47 (seeded as Recipe culling) at 7 and 10 levels, *video
 * lenient* on each, filtered only when both level sets filter; then the Score forecast filters when the highest P(≥ 8) is below 0.111.
 */
import type { PipelineSettingConfig, ProfileRule, ScoreForecastSetting } from './types.js';

export const DEFAULT_SCORE_FORECAST: ScoreForecastSetting = {
  enabled: true,
  threshold: 0.111,
  high_from_level: 8,
  excused_at: 0.5,
  run_after_filtered: true,
};

export function defaultPipelineSetting(profileSlug: string, rule: ProfileRule): PipelineSettingConfig {
  return {
    culling_profiles: [{ profile_slug: profileSlug, rule, run_after_filtered: true }],
    score_forecast: { ...DEFAULT_SCORE_FORECAST },
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseProfileRule(raw: unknown): ProfileRule {
  if (!isObject(raw) || !isObject(raw.level_sets) || !isObject(raw.filter_rule)) {
    throw new Error('culling profile rule: level_sets and filter_rule are required');
  }
  if (raw.combine !== 'every' && raw.combine !== 'any') {
    throw new Error("culling profile rule: combine must be 'every' or 'any'");
  }
  const type = raw.filter_rule.type;
  if (type !== 'all_fail' && type !== 'n_fail_unless_strong' && type !== 'mean_fail') {
    throw new Error(`culling profile rule: unknown filter rule ${String(type)}`);
  }
  return raw as unknown as ProfileRule;
}

/** A stored `config_json`, refused loudly rather than half-applied when it lost its shape. */
export function parsePipelineSetting(raw: unknown): PipelineSettingConfig {
  if (!isObject(raw) || !Array.isArray(raw.culling_profiles) || !isObject(raw.score_forecast)) {
    throw new Error('cull pipeline setting: culling_profiles and score_forecast are required');
  }
  for (const r of raw.culling_profiles) {
    if (!isObject(r) || typeof r.profile_slug !== 'string') {
      throw new Error('cull pipeline setting: every culling profile needs a profile_slug');
    }
    parseProfileRule(r.rule);
  }
  return raw as unknown as PipelineSettingConfig;
}
