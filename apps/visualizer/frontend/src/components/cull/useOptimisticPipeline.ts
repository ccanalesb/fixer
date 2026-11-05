import { useEffect, useState } from 'react'
import { CullingProfilesAPI, type PipelineSettingResponse } from '../../services/api'
import { keys, useQuery } from '../../data'

type PipelineConfig = PipelineSettingResponse['config']

function sameSwitches(a: PipelineConfig, b: PipelineConfig): boolean {
  return (
    a.culling_profiles_enabled === b.culling_profiles_enabled &&
    a.culling_profiles_filter_enabled === b.culling_profiles_filter_enabled &&
    a.score_forecast.enabled === b.score_forecast.enabled &&
    a.score_forecast.threshold === b.score_forecast.threshold &&
    a.score_forecast.high_from_level === b.score_forecast.high_from_level
  )
}

/**
 * The culling pipeline setting, shown as the user just set it until the pipeline query
 * agrees. `show` puts a config on screen while its save is in flight; `show(null)` drops
 * it, e.g. when the save fails.
 */
export function useOptimisticPipeline() {
  const pipeline = useQuery(keys.cullingProfiles.pipeline(), () => CullingProfilesAPI.getPipeline())
  const [shown, setShown] = useState<PipelineConfig | null>(null)

  useEffect(() => {
    if (shown && sameSwitches(pipeline.config, shown)) setShown(null)
  }, [pipeline, shown])

  return {
    config: shown ?? pipeline.config,
    savedConfig: pipeline.config,
    pending: shown !== null,
    show: setShown,
  }
}
