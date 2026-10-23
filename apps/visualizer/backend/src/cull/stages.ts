/**
 * The pipeline setting → the stages a photo goes through, each at the version its questions and model
 * identity make (`stage-models.ts` says what a model's identity is).
 *
 * Profile stage question ids are `<level set>|<dimension>`, the ids imported answers carry, so the
 * Default culling profile's stage versions hash the same text those answers were asked.
 */
import type { Db } from '../db/connection.js';
import { getCullProfile } from '../db/library/cull-profiles.js';
import { getOrCreateStageVersion } from '../db/library/cull-stages.js';
import { getForecastQuestions } from '../db/library/score-forecast-questions.js';
import { libraryWrite } from '../db/library/write.js';
import type { SystemOneQuestion } from '../systemone/question.js';
import { forecastStageQuestions } from './forecast-questions.js';
import type { StageModelIds } from './stage-models.js';
import type { PipelineSettingConfig, ResolvedStage } from './types.js';

export const SCORE_FORECAST_STAGE_KEY = 'score_forecast';

export function profileStageKey(profileSlug: string, levelSet: string): string {
  return `culling_profile:${profileSlug}:${levelSet}`;
}

/** What the Score forecast's model is asked now: the current Score forecast questions. */
export function currentForecastStageQuestions(db: Db): Record<string, SystemOneQuestion> {
  return forecastStageQuestions(getForecastQuestions(db).questions);
}

/**
 * Every stage of the current pipeline, at the version its questions and model make, created and marked
 * current as needed. A stage kind with no model identity is left out, and so is the Score forecast with
 * no questions.
 */
export function resolveCurrentStages(db: Db, pipeline: PipelineSettingConfig, models: StageModelIds): ResolvedStage[] {
  return libraryWrite(db, () => {
    const stages: ResolvedStage[] = [];
    const profileModel = models.culling_profile;
    for (const entry of profileModel === null ? [] : pipeline.culling_profiles) {
      const profile = getCullProfile(db, entry.profile_slug);
      if (!profile) throw new Error(`culling pipeline setting names a culling profile that does not exist: ${entry.profile_slug}`);
      for (const set of profile.definition.level_sets) {
        if (!entry.rule.level_sets[set.id]) {
          throw new Error(`culling profile ${profile.slug}: the rule has no "fails at" / "strong at" for level set ${set.id}`);
        }
        const questions: Record<string, SystemOneQuestion> = {};
        for (const dim of profile.definition.dimensions) {
          questions[`${set.id}|${dim.slug}`] = { type: 'score', instructions: dim.question, criteria: set.levels[dim.slug] };
        }
        const spec = {
          stageKey: profileStageKey(profile.slug, set.id),
          kind: 'culling_profile' as const,
          profileSlug: profile.slug,
          levelSet: set.id,
          modelId: profileModel!,
          questions,
        };
        stages.push({ ...spec, versionId: getOrCreateStageVersion(db, spec) });
      }
    }
    const forecastQuestions = currentForecastStageQuestions(db);
    if (models.score_forecast !== null && Object.keys(forecastQuestions).length > 0) {
      const spec = {
        stageKey: SCORE_FORECAST_STAGE_KEY,
        kind: 'score_forecast' as const,
        profileSlug: null,
        levelSet: null,
        modelId: models.score_forecast,
        questions: forecastQuestions,
      };
      stages.push({ ...spec, versionId: getOrCreateStageVersion(db, spec) });
    }
    return stages;
  });
}
