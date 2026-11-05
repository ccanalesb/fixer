/**
 * The pipeline setting → the stages a photo goes through, each at the version its questions and model
 * identity make (`stage-models.ts` says what a model's identity is).
 *
 * Profile stage question ids are `<level set>|<dimension>`, the ids imported answers carry, so the
 * Default culling profile's stage versions hash the same text those answers were asked.
 */
import type { Db } from '../db/connection.js';
import type { StageModelIds } from './stage-models.js';
import {
  profileStageKey,
  profileStageQuestions,
  SCORE_FORECAST_STAGE_KEY,
  scoreForecastStageQuestions,
} from './stage-specs.js';
import type { PipelineSettingConfig, ResolvedStage, StageKind } from './types.js';
import { getCullProfile } from '../db/library/cull-profiles-read.js';
import { getForecastQuestions } from '../db/library/score-forecast-questions.js';
import { syncCurrentStages } from '../db/library/cull-sync-stages.js';

export { SCORE_FORECAST_STAGE_KEY, profileStageKey } from './stage-specs.js';
export { syncCurrentStages } from '../db/library/cull-sync-stages.js';

interface CurrentStageRow {
  id: number;
  stage_key: string;
  kind: StageKind;
  profile_slug: string | null;
  level_set: string | null;
  model_id: string;
  questions_json: string;
}

function readCurrentStageRow(db: Db, stageKey: string): CurrentStageRow | null {
  const row = db
    .prepare(
      `SELECT id, stage_key, kind, profile_slug, level_set, model_id, questions_json
       FROM cull_stage_versions WHERE stage_key = ? AND is_current = 1`,
    )
    .get(stageKey) as CurrentStageRow | undefined;
  return row ?? null;
}

/**
 * Every stage of the pipeline setting at its current stored version. Does not create or update stage
 * versions — use `syncCurrentStages` when text, the pipeline setting, or a model identity changes.
 */
function resolveCurrentStagesRead(db: Db, pipeline: PipelineSettingConfig, models: StageModelIds): ResolvedStage[] {
  const stages: ResolvedStage[] = [];
  const profileModel = models.culling_profile;
  for (const entry of profileModel === null ? [] : pipeline.culling_profiles) {
    const profile = getCullProfile(db, entry.profile_slug);
    if (!profile) throw new Error(`culling pipeline setting names a culling profile that does not exist: ${entry.profile_slug}`);
    for (const set of profile.definition.level_sets) {
      if (!entry.rule.level_sets[set.id]) {
        throw new Error(`culling profile ${profile.slug}: the rule has no "fails at" / "strong at" for level set ${set.id}`);
      }
      const stageKey = profileStageKey(profile.slug, set.id);
      const row = readCurrentStageRow(db, stageKey);
      if (!row) continue;
      const expected = profileStageQuestions(profile.definition, set.id);
      stages.push({
        stageKey,
        kind: 'culling_profile',
        versionId: row.id,
        modelId: row.model_id,
        profileSlug: profile.slug,
        levelSet: set.id,
        questions: expected,
      });
    }
  }
  const forecastQuestions = scoreForecastStageQuestions(getForecastQuestions(db).questions);
  if (models.score_forecast !== null && Object.keys(forecastQuestions).length > 0) {
    const row = readCurrentStageRow(db, SCORE_FORECAST_STAGE_KEY);
    if (row) {
      stages.push({
        stageKey: SCORE_FORECAST_STAGE_KEY,
        kind: 'score_forecast',
        versionId: row.id,
        modelId: row.model_id,
        profileSlug: null,
        levelSet: null,
        questions: forecastQuestions,
      });
    }
  }
  return stages;
}

function expectedStageCount(db: Db, pipeline: PipelineSettingConfig, models: StageModelIds): number {
  let n = 0;
  if (models.culling_profile !== null) {
    for (const entry of pipeline.culling_profiles) {
      const profile = getCullProfile(db, entry.profile_slug);
      if (profile) n += profile.definition.level_sets.length;
    }
  }
  if (
    models.score_forecast !== null &&
    Object.keys(scoreForecastStageQuestions(getForecastQuestions(db).questions)).length > 0
  ) {
    n += 1;
  }
  return n;
}

/**
 * Stages at their current stored versions. When a stage is missing or its stored model no longer matches
 * `models`, runs `syncCurrentStages` so callers that already resolved model ids (jobs, CLI) still work.
 */
export function resolveCurrentStages(db: Db, pipeline: PipelineSettingConfig, models: StageModelIds): ResolvedStage[] {
  const read = resolveCurrentStagesRead(db, pipeline, models);
  const need = expectedStageCount(db, pipeline, models);
  const modelDrift = read.some((s) => models[s.kind] !== null && s.modelId !== models[s.kind]);
  if (read.length < need || modelDrift) return syncCurrentStages(db, models);
  return read;
}

/** What the Score forecast's model is asked now: the current Score forecast questions. */
export function currentForecastStageQuestions(db: Db): Record<string, import('../systemone/question.js').SystemOneQuestion> {
  return scoreForecastStageQuestions(getForecastQuestions(db).questions);
}
