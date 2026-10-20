/**
 * The pipeline setting a library starts with, and the check that a stored one still has its shape.
 *
 * Default (ticket 15): recipe 7H47 at 7 and 10 levels, *video lenient* on each, cut only when both
 * level sets cut; then the Score forecast cuts when the highest P(≥ 8) is below 0.111.
 */
import type { PipelineSettingConfig, RecipeRule, ScoreForecastSetting } from './types.js';

export const DEFAULT_SCORE_FORECAST: ScoreForecastSetting = {
  enabled: true,
  threshold: 0.111,
  high_from_level: 8,
  excused_at: 0.5,
  run_after_cut: true,
};

export function defaultPipelineSetting(recipeSlug: string, rule: RecipeRule): PipelineSettingConfig {
  return {
    culling_recipes: [{ recipe_slug: recipeSlug, rule, run_after_cut: true }],
    score_forecast: { ...DEFAULT_SCORE_FORECAST },
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseRecipeRule(raw: unknown): RecipeRule {
  if (!isObject(raw) || !isObject(raw.level_sets) || !isObject(raw.cut_rule)) {
    throw new Error('culling recipe rule: level_sets and cut_rule are required');
  }
  if (raw.combine !== 'every' && raw.combine !== 'any') {
    throw new Error("culling recipe rule: combine must be 'every' or 'any'");
  }
  const type = raw.cut_rule.type;
  if (type !== 'all_fail' && type !== 'n_fail_unless_strong' && type !== 'mean_fail') {
    throw new Error(`culling recipe rule: unknown cut rule ${String(type)}`);
  }
  return raw as unknown as RecipeRule;
}

/** A stored `config_json`, refused loudly rather than half-applied when it lost its shape. */
export function parsePipelineSetting(raw: unknown): PipelineSettingConfig {
  if (!isObject(raw) || !Array.isArray(raw.culling_recipes) || !isObject(raw.score_forecast)) {
    throw new Error('cull pipeline setting: culling_recipes and score_forecast are required');
  }
  for (const r of raw.culling_recipes) {
    if (!isObject(r) || typeof r.recipe_slug !== 'string') {
      throw new Error('cull pipeline setting: every culling recipe needs a recipe_slug');
    }
    parseRecipeRule(r.rule);
  }
  return raw as unknown as PipelineSettingConfig;
}
