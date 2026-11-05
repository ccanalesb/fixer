/**
 * The pipeline setting → the stages a photo goes through, each at the version its questions and model
 * identity make (`stage-models.ts` says what a model's identity is).
 *
 * Profile stage question ids are `<level set>|<dimension>`, the ids imported answers carry, so the
 * Default culling profile's stage versions hash the same text those answers were asked.
 */
import type { Db } from '../db/connection.js';
import { stageSpecsForPipeline } from '../db/library/cull-sync-stages.js';
import { getCurrentPipelineSetting, type PipelineSetting } from '../db/library/cull-pipeline.js';
import { readCurrentStageVersion, readStoredStageModelIds } from '../db/library/cull-stages.js';
import { stagesOn, type StageModelIds } from './stage-models.js';
import type { ResolvedStage, StageKind } from './types.js';

export { syncCurrentStages } from '../db/library/cull-sync-stages.js';

export interface ReadCurrentStagesResult {
  pipeline: PipelineSetting;
  on: Record<StageKind, boolean>;
  modelIds: StageModelIds;
  stages: ResolvedStage[];
}

/** Current pipeline stages from stored versions only; never creates or marks current. */
export function readCurrentStages(db: Db): ReadCurrentStagesResult {
  const pipeline = getCurrentPipelineSetting(db);
  const modelIds = readStoredStageModelIds(db);
  const on = stagesOn(pipeline.config);
  const stages: ResolvedStage[] = [];
  for (const spec of stageSpecsForPipeline(db, pipeline.config, modelIds)) {
    const row = readCurrentStageVersion(db, spec.stageKey);
    if (row) stages.push(row);
  }
  return { pipeline, on, modelIds, stages };
}

