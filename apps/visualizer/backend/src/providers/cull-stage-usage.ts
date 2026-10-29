/**
 * Which culling stages point at a System One provider, and how many photos have answers there.
 */
import { config, loadLibraryConfig, updateConfigYamlCullingModel } from '../config.js';
import { STAGE_NAMES } from '../cull/stage-models.js';
import type { StageKind } from '../cull/types.js';
import type { Db } from '../db/connection.js';
import { countPhotosAnsweredByCurrentStages } from '../db/library/cull-stages.js';

const STAGE_KINDS: readonly StageKind[] = ['culling_profile', 'score_forecast'];

export interface CullingStageUsage {
  kind: StageKind;
  name: string;
}

/** Stages whose endpoint in `config.yaml` is this provider id. */
export function cullingStagesUsingProvider(providerId: string): CullingStageUsage[] {
  const models = loadLibraryConfig(config.LT_CONFIG_YAML).cullingModels;
  const out: CullingStageUsage[] = [];
  for (const kind of STAGE_KINDS) {
    if (models[kind].endpoint === providerId) {
      out.push({ kind, name: STAGE_NAMES[kind] });
    }
  }
  return out;
}

/**
 * Photos that would be answered again after an address change: distinct photos with a current
 * answer on any stage that uses this provider (same count Culling models shows per stage).
 */
export function countPhotosForProviderAddressChange(db: Db, providerId: string): number {
  const stages = cullingStagesUsingProvider(providerId);
  if (stages.length === 0) return 0;
  return countPhotosAnsweredByCurrentStages(
    db,
    stages.map((s) => s.kind),
  );
}

/** After a System One provider is removed, its stages keep their model but have no endpoint. */
export function clearCullingStagesUsingProvider(providerId: string): void {
  const configPath = config.LT_CONFIG_YAML;
  const models = loadLibraryConfig(configPath).cullingModels;
  for (const kind of STAGE_KINDS) {
    if (models[kind].endpoint === providerId) {
      updateConfigYamlCullingModel(configPath, kind, { endpoint: '', model: models[kind].model });
    }
  }
}
