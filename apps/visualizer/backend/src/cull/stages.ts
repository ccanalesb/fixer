/**
 * The pipeline setting → the stages a photo goes through, each at the version its questions and model
 * identity make (`stage-models.ts` says what a model's identity is).
 *
 * Profile stage question ids are `<level set>|<dimension>`, the ids imported answers carry, so the
 * Default culling profile's stage versions hash the same text those answers were asked.
 */
import type { Db } from '../db/connection.js';
import { syncCurrentStages } from '../db/library/cull-sync-stages.js';
import { getForecastQuestions } from '../db/library/score-forecast-questions.js';
import type { SystemOneQuestion } from '../systemone/question.js';
import { forecastStageQuestions } from './forecast-questions.js';
import type { StageModelIds } from './stage-models.js';
import type { PipelineSettingConfig, ResolvedStage } from './types.js';

export { SCORE_FORECAST_STAGE_KEY, profileStageKey } from './stage-specs.js';
export { syncCurrentStages } from '../db/library/cull-sync-stages.js';

/**
 * Stages at their current stored versions. Reads call this; the writers have already made the versions
 * current with `syncCurrentStages`, so this finds them and writes nothing new. Jobs and the CLI pass the
 * model identities they resolved, which moves a version when a model change brought a new identity.
 */
export function resolveCurrentStages(db: Db, _pipeline: PipelineSettingConfig, models: StageModelIds): ResolvedStage[] {
  return syncCurrentStages(db, models);
}

/** What the Score forecast's model is asked now: the current Score forecast questions. */
export function currentForecastStageQuestions(db: Db): Record<string, SystemOneQuestion> {
  return forecastStageQuestions(getForecastQuestions(db).questions);
}
