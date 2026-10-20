import { useEffect, useState } from 'react'
import { CullingRecipesAPI } from '../../services/api'
import { invalidateAll, useQuery } from '../../data'
import { Button } from '../ui/Button'
import { CULL_ADVANCED, CULL_SAVE, CULL_SCORE_FORECAST_THRESHOLD, CULL_THRESHOLD_NOTE } from '../../constants/strings'

/** Pipeline-wide setting, shown under each recipe's rule behind an Advanced disclosure. */
export function ScoreForecastThresholdField() {
  const pipeline = useQuery(['culling-recipes.pipeline'] as const, () => CullingRecipesAPI.getPipeline())
  const [open, setOpen] = useState(false)
  const [threshold, setThreshold] = useState('')
  const current = pipeline?.config.score_forecast.threshold

  useEffect(() => {
    if (current !== undefined && Number.isFinite(current)) setThreshold(String(current))
  }, [current])

  const save = async () => {
    const n = Number.parseFloat(threshold)
    if (!Number.isFinite(n)) return
    await CullingRecipesAPI.saveScoreForecastThreshold(n)
    invalidateAll(['culling-recipes.pipeline'])
  }

  return (
    <div>
      <button
        type="button"
        className="text-sm font-medium text-text-secondary"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? '▾' : '▸'} {CULL_ADVANCED}
      </button>
      {open && (
        <div className="mt-2 p-3 bg-surface border border-border rounded-base max-w-md">
          <label className="block text-sm font-medium">
            {CULL_SCORE_FORECAST_THRESHOLD}
            <input
              className="mt-1 block w-28 border border-border rounded-base px-2 py-1 text-sm bg-bg"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
          </label>
          <p className="text-xs text-text-secondary mt-2">{CULL_THRESHOLD_NOTE}</p>
          <p className="text-xs text-text-tertiary mt-1">Current: {current ?? '—'}</p>
          <Button type="button" size="sm" className="mt-2" variant="primary" onClick={() => void save()}>
            {CULL_SAVE}
          </Button>
        </div>
      )}
    </div>
  )
}
