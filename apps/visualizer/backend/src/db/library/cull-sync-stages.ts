/**
 * Make stage versions current for the pipeline setting's saved text and the given model identities.
 */
import { forecastStageQuestions, type ScoreForecastQuestion } from '../../cull/forecast-questions.js';
import type { StageModelIds } from '../../cull/stage-models.js';
import {
  profileStageKey,
  profileStageQuestions,
  SCORE_FORECAST_STAGE_KEY,
} from '../../cull/stage-specs.js';
import type { PipelineSettingConfig, ResolvedStage } from '../../cull/types.js';
import type { Db } from '../connection.js';
import { parsePipelineSetting } from '../../cull/default-pipeline.js';
import { getCullProfile } from './cull-profiles-read.js';
import { getOrCreateStageVersion, readStoredStageModelIds, type StageVersionSpec } from './cull-stages.js';
import { libraryWrite } from './write.js';

/**
 * The Score forecast's questions from the current version, read with raw SQL rather than
 * `getForecastQuestions`: that module imports this one (writers call `syncCurrentStagesAfterLibraryWrite`),
 * so importing it back here would make a module-load cycle.
 */
function currentForecastStageQuestions(db: Db): Record<string, import('../../systemone/question.js').SystemOneQuestion> {
  const row = db
    .prepare('SELECT definition_json FROM score_forecast_question_versions WHERE is_current = 1')
    .get() as { definition_json: string } | undefined;
  if (!row) return forecastStageQuestions([]);
  const { questions } = JSON.parse(row.definition_json) as { questions: ScoreForecastQuestion[] };
  return forecastStageQuestions(questions);
}

/** Stage keys and question text the pipeline setting names, before resolving stored version ids. */
export function stageSpecsForPipeline(
  db: Db,
  pipeline: PipelineSettingConfig,
  models: StageModelIds,
): StageVersionSpec[] {
  const specs: StageVersionSpec[] = [];
  const profileModel = models.culling_profile;
  for (const entry of profileModel === null ? [] : pipeline.culling_profiles) {
    const profile = getCullProfile(db, entry.profile_slug);
    if (!profile) throw new Error(`culling pipeline setting names a culling profile that does not exist: ${entry.profile_slug}`);
    for (const set of profile.definition.level_sets) {
      if (!entry.rule.level_sets[set.id]) {
        throw new Error(`culling profile ${profile.slug}: the rule has no "fails at" / "strong at" for level set ${set.id}`);
      }
      specs.push({
        stageKey: profileStageKey(profile.slug, set.id),
        kind: 'culling_profile',
        profileSlug: profile.slug,
        levelSet: set.id,
        modelId: profileModel!,
        questions: profileStageQuestions(profile.definition, set.id),
      });
    }
  }
  const forecastQuestions = currentForecastStageQuestions(db);
  if (models.score_forecast !== null && Object.keys(forecastQuestions).length > 0) {
    specs.push({
      stageKey: SCORE_FORECAST_STAGE_KEY,
      kind: 'score_forecast',
      profileSlug: null,
      levelSet: null,
      modelId: models.score_forecast,
      questions: forecastQuestions,
    });
  }
  return specs;
}

function syncCurrentStagesInTransaction(db: Db, models: StageModelIds): ResolvedStage[] {
  const row = db
    .prepare('SELECT config_json FROM cull_pipeline_settings WHERE is_current = 1')
    .get() as { config_json: string } | undefined;
  if (!row) throw new Error('library.db has no cull pipeline setting; culling defaults were never seeded');
  const pipeline = parsePipelineSetting(JSON.parse(row.config_json));
  return stageSpecsForPipeline(db, pipeline, models).map((spec) => ({
    ...spec,
    versionId: getOrCreateStageVersion(db, spec),
  }));
}

/** Every stage of the current pipeline at the version its questions and model make; created and marked current as needed. */
export function syncCurrentStages(db: Db, modelIds: StageModelIds): ResolvedStage[] {
  return libraryWrite(db, () => syncCurrentStagesInTransaction(db, modelIds));
}

/**
 * For the writers: sync at the end of their own `libraryWrite`, with the stored model identities. A
 * no-op before the pipeline setting is seeded, so an early bootstrap write does not throw.
 */
export function syncCurrentStagesAfterLibraryWrite(db: Db, modelIds: StageModelIds = readStoredStageModelIds(db)): void {
  const hasPipeline = db.prepare('SELECT 1 FROM cull_pipeline_settings WHERE is_current = 1').get() !== undefined;
  if (!hasPipeline) return;
  syncCurrentStagesInTransaction(db, modelIds);
}
