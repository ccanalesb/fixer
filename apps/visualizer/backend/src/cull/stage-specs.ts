/**
 * A stage's key and the questions it asks, from a culling profile's text. Pure (no database), so
 * `db/library/` and `cull/` can share it without an import cycle. The Score forecast's questions come
 * from `forecast-questions.ts`, which is already pure.
 */
import type { SystemOneQuestion } from '../systemone/question.js';
import type { ProfileDefinition } from './types.js';

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
