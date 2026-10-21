/**
 * Culling's shapes: culling profiles, the pipeline setting, stages and their answers.
 *
 * A **stage** is one thing Laya answers per photo: a culling profile at one level set (Laya base), or
 * the Score forecast (Laya new). Stages are what get versioned and stored; the pipeline setting says
 * how their answers become a verdict.
 */
import type { LayaQuestion } from '../laya/rows.js';

export type CullVerdict = 'filtered' | 'passed';
export type CullSummaryVerdict = CullVerdict | 'pending';
export type StageKind = 'culling_profile' | 'score_forecast';

/** The text Laya is asked: versioned, so a change makes a new stage version. */
export interface ProfileDefinition {
  dimensions: { slug: string; name: string; question: string }[];
  /** Levels per dimension, lowest first; every dimension has the same count within a set. */
  level_sets: { id: string; levels: Record<string, string[]> }[];
}

/**
 * When a dimension fails, all of these listed fail (`all_fail`, the default "video lenient" on point of
 * tension and connotation), N or more fail unless one is strong, or the average level fails.
 */
export type FilterRule =
  | { type: 'all_fail'; dimensions: string[] }
  | { type: 'n_fail_unless_strong'; n: number }
  | { type: 'mean_fail' };

/** How a profile's answers become filtered / passed: not versioned, re-decided from stored answers. */
export interface ProfileRule {
  /** Levels are 1-based; a dimension fails at or below `fails_at_most`, is strong at or above `strong_at_least`. */
  level_sets: Record<string, { fails_at_most: number; strong_at_least: number }>;
  /** With several level sets: filter when every set filters, or when any does. */
  combine: 'every' | 'any';
  filter_rule: FilterRule;
  /** Which level-set readout counts toward Lightroom stars (defaults to every). */
  stars_strong_from?: '7' | '10' | 'every' | 'any';
}

export interface PipelineProfile {
  profile_slug: string;
  /** Snapshot of the profile's rule, so a pipeline-setting version says exactly how a photo was decided. */
  rule: ProfileRule;
  /** Answer this profile even on a photo an earlier stage already filtered. */
  run_after_filtered: boolean;
}

export interface ScoreForecastSetting {
  enabled: boolean;
  /** Filter when the highest P(AI score ≥ `high_from_level`) is below this. */
  threshold: number;
  high_from_level: number;
  /** Framing is left out of the highest when P(no framing device) is at least this. */
  excused_at: number;
  run_after_filtered: boolean;
}

/** Stored, versioned, in `cull_pipeline_settings`. Profiles run first, in order, then the Score forecast. */
export interface PipelineSettingConfig {
  culling_profiles: PipelineProfile[];
  score_forecast: ScoreForecastSetting;
}

/** A stage at its current version, with exactly what Laya is asked for it. */
export interface ResolvedStage {
  stageKey: string;
  kind: StageKind;
  versionId: number;
  model: 'base' | 'new';
  modelId: string;
  /** Profile stages only. */
  profileSlug: string | null;
  levelSet: string | null;
  /** Laya question id → question. Profile ids are `<stage key>|<dimension>`; forecast ids are Laya new's own. */
  questions: Record<string, LayaQuestion>;
}

/**
 * One stage's answers: level probabilities, lowest first, by dimension slug (profile stages) or by
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
  filteredBy: StageKind | null;
  filteredByStageKey: string | null;
  /** Stages this photo still needs answered. */
  pendingStages: string[];
  /** Highest P(≥ 8) over Laya new's perspectives; null without a forecast answer. */
  scoreForecastP8: number | null;
  /** Passed only because the user sent it by hand: the stages alone would have filtered it. */
  sentByHandOverride: boolean;
  stages: Record<string, StageDecision>;
}
