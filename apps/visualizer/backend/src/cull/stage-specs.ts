/**
 * What each stage asks its model, from a culling profile's text or the Score forecast questions.
 * Pure shapes: safe for `db/library/` and `cull/` to share without import cycles.
 */
import type { SystemOneQuestion } from '../systemone/question.js';
import { forecastStageQuestions, type ScoreForecastQuestion } from './forecast-questions.js';
import type { ProfileDefinition, StageKind } from './types.js';

export const SCORE_FORECAST_STAGE_KEY = 'score_forecast';

export function profileStageKey(profileSlug: string, levelSet: string): string {
  return `culling_profile:${profileSlug}:${levelSet}`;
}

/** Score questions for one level set of a profile's current definition text. */
export function profileStageQuestions(
  definition: ProfileDefinition,
  levelSetId: string,
): Record<string, SystemOneQuestion> {
  const set = definition.level_sets.find((s) => s.id === levelSetId);
  if (!set) throw new Error(`culling profile has no level set ${levelSetId}`);
  const questions: Record<string, SystemOneQuestion> = {};
  for (const dim of definition.dimensions) {
    questions[`${levelSetId}|${dim.slug}`] = {
      type: 'score',
      instructions: dim.question,
      criteria: set.levels[dim.slug]!,
    };
  }
  return questions;
}

export interface StageVersionSpecInput {
  stageKey: string;
  kind: StageKind;
  profileSlug: string | null;
  levelSet: string | null;
  modelId: string;
  questions: Record<string, SystemOneQuestion>;
}

/** What the Score forecast's model is asked from the current question set. */
export function scoreForecastStageQuestions(questions: readonly ScoreForecastQuestion[]): Record<string, SystemOneQuestion> {
  return forecastStageQuestions(questions);
}
