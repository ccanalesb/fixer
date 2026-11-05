import { CullingProfilesAPI, type CullingStageKind, type PipelineChangeResponse } from '../../services/api'

type CullingProfileBody = { enabled?: boolean; filter_enabled?: boolean }
type ScoreForecastBody = { enabled?: boolean; threshold?: number; high_from_level?: number }

/** Same API the Settings → Culling switches use for a pipeline change. */
export function applyPipelineStageChange(
  stage: CullingStageKind,
  body: CullingProfileBody | ScoreForecastBody,
): Promise<PipelineChangeResponse> {
  if (stage === 'culling_profile') {
    return CullingProfilesAPI.saveCullingProfileSwitches(body as CullingProfileBody)
  }
  return CullingProfilesAPI.saveScoreForecast(body as ScoreForecastBody)
}

export function turnStageOff(stage: CullingStageKind): Promise<PipelineChangeResponse> {
  return applyPipelineStageChange(stage, { enabled: false })
}
