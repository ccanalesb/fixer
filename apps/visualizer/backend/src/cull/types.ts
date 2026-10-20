/**
 * The cull's shapes: culling recipes, the pipeline setting, stages and their answers.
 *
 * A **stage** is one thing Laya answers per photo: a culling recipe at one level set (Laya base), or
 * the Score forecast (Laya new). Stages are what get versioned and stored; the pipeline setting says
 * how their answers become a verdict.
 */
import type { LayaQuestion } from '../laya/rows.js';

export type CullVerdict = 'cut' | 'sent';
export type CullSummaryVerdict = CullVerdict | 'pending';
export type StageKind = 'culling_recipe' | 'score_forecast';

/** The text Laya is asked: versioned, so a change makes a new stage version. */
export interface RecipeDefinition {
  dimensions: { slug: string; name: string; question: string }[];
  /** Levels per dimension, lowest first; every dimension has the same count within a set. */
  level_sets: { id: string; levels: Record<string, string[]> }[];
}

/**
 * When a dimension fails, all of these listed fail (`all_fail`, the default "video lenient" on point of
 * tension and connotation), N or more fail unless one is strong, or the average level fails.
 */
export type CutRule =
  | { type: 'all_fail'; dimensions: string[] }
  | { type: 'n_fail_unless_strong'; n: number }
  | { type: 'mean_fail' };

/** How a recipe's answers become cut / sent: not versioned, re-decided from stored answers. */
export interface RecipeRule {
  /** Levels are 1-based; a dimension fails at or below `fails_at_most`, is strong at or above `strong_at_least`. */
  level_sets: Record<string, { fails_at_most: number; strong_at_least: number }>;
  /** With several level sets: cut when every set cuts, or when any does. */
  combine: 'every' | 'any';
  cut_rule: CutRule;
}

export interface PipelineRecipe {
  recipe_slug: string;
  /** Snapshot of the recipe's rule, so a pipeline-setting version says exactly how a photo was decided. */
  rule: RecipeRule;
  /** Answer this recipe even on a photo an earlier stage already cut. */
  run_after_cut: boolean;
}

export interface ScoreForecastSetting {
  enabled: boolean;
  /** Cut when the highest P(AI score ≥ `high_from_level`) is below this. */
  threshold: number;
  high_from_level: number;
  /** Framing is left out of the highest when P(no framing device) is at least this. */
  excused_at: number;
  run_after_cut: boolean;
}

/** Stored, versioned, in `cull_pipeline_settings`. Recipes run first, in order, then the Score forecast. */
export interface PipelineSettingConfig {
  culling_recipes: PipelineRecipe[];
  score_forecast: ScoreForecastSetting;
}

/** A stage at its current version, with exactly what Laya is asked for it. */
export interface ResolvedStage {
  stageKey: string;
  kind: StageKind;
  versionId: number;
  model: 'base' | 'new';
  modelId: string;
  /** Recipe stages only. */
  recipeSlug: string | null;
  levelSet: string | null;
  /** Laya question id → question. Recipe ids are `<stage key>|<dimension>`; forecast ids are Laya new's own. */
  questions: Record<string, LayaQuestion>;
}

/**
 * One stage's answers: level probabilities, lowest first, by dimension slug (recipe stages) or by
 * Laya new question id (Score forecast).
 */
export type StageAnswers = Record<string, number[]>;

export interface StageDecision {
  verdict: CullVerdict;
  /** What produced it: rule or threshold and the readout. Stored with the stage row. */
  detail: Record<string, unknown>;
}

export interface PhotoDecision {
  verdict: CullSummaryVerdict;
  cutBy: StageKind | null;
  cutByStageKey: string | null;
  /** Stages this photo still needs answered. */
  pendingStages: string[];
  /** Highest P(≥ 8) over Laya new's perspectives; null without a forecast answer. */
  scoreForecastP8: number | null;
  /** Sent only because the user sent it by hand: the stages alone would have cut it. */
  sentByHandOverride: boolean;
  stages: Record<string, StageDecision>;
}
