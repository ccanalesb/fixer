import { useCallback, useEffect, useState } from 'react'
import { CullingRecipesAPI } from '../../services/api'
import { useQuery, invalidateAll } from '../../data'
import { Button } from '../ui/Button'
import {
  CULL_ADD_RECIPE,
  CULL_ADVANCED,
  CULL_NOT_MEASURED,
  CULL_RECIPES_SECTION,
  CULL_RECIPE_ACTIVE,
  CULL_RECIPE_INACTIVE,
  CULL_SAVE,
  CULL_SCORE_FORECAST_THRESHOLD,
  CULL_THRESHOLD_NOTE,
} from '../../constants/strings'
import { CullingRecipeEditor } from './CullingRecipeEditor'

export function CullingRecipesSection() {
  const recipes = useQuery(['culling-recipes.list'] as const, () => CullingRecipesAPI.list())
  const pipeline = useQuery(['culling-recipes.pipeline'] as const, () => CullingRecipesAPI.getPipeline())
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [threshold, setThreshold] = useState('')

  const detail = useQuery(['culling-recipes.detail', selectedSlug ?? ''] as const, () =>
    selectedSlug ? CullingRecipesAPI.get(selectedSlug) : Promise.resolve(null),
  )

  useEffect(() => {
    if (selectedSlug === null && recipes?.recipes?.length) {
      setSelectedSlug(recipes.recipes[0]!.slug)
    }
  }, [recipes, selectedSlug])

  useEffect(() => {
    const t = pipeline?.config.score_forecast.threshold
    if (t !== undefined && Number.isFinite(t)) setThreshold(String(t))
  }, [pipeline?.config.score_forecast.threshold])

  const refresh = useCallback(() => {
    invalidateAll(['culling-recipes.list', 'culling-recipes.pipeline', 'culling-recipes.detail'])
  }, [])

  const onAdd = async () => {
    const slug = `recipe-${Date.now()}`
    await CullingRecipesAPI.create({
      slug,
      name: 'New recipe',
      model: 'laya-base',
      definition: {
        dimensions: [{ slug: 'dimension-1', name: 'Dimension 1', question: '' }],
        level_sets: [{ id: '5', levels: { 'dimension-1': ['', '', '', '', ''] } }],
      },
      rule: {
        level_sets: { '5': { fails_at_most: 2, strong_at_least: 4 } },
        combine: 'any',
        cut_rule: { type: 'all_fail', dimensions: ['dimension-1'] },
      },
      active: false,
    })
    setSelectedSlug(slug)
    refresh()
  }

  const saveThreshold = async () => {
    const n = Number.parseFloat(threshold)
    if (!Number.isFinite(n)) return
    await CullingRecipesAPI.saveScoreForecastThreshold(n)
    refresh()
  }

  return (
    <div className="mt-10 pt-8 border-t border-border space-y-4">
      <h3 className="text-section font-semibold">{CULL_RECIPES_SECTION}</h3>
      <div className="flex gap-2">
        <Button type="button" variant="primary" size="sm" onClick={() => void onAdd()}>
          {CULL_ADD_RECIPE}
        </Button>
      </div>
      <div className="grid lg:grid-cols-[240px_1fr] gap-4">
        <div className="border border-border rounded-base divide-y divide-border max-h-[480px] overflow-y-auto">
          {(recipes?.recipes ?? []).map((r) => (
            <button
              key={r.slug}
              type="button"
              className={`w-full text-left p-3 text-sm hover:bg-surface ${selectedSlug === r.slug ? 'bg-surface border-l-2 border-l-accent' : ''}`}
              onClick={() => setSelectedSlug(r.slug)}
            >
              <div className="font-medium">{r.name}</div>
              <div className="text-text-secondary text-xs">
                {r.slug} · v{r.version} · {r.active ? CULL_RECIPE_ACTIVE : CULL_RECIPE_INACTIVE}
                {!r.measured && <> · {CULL_NOT_MEASURED}</>}
              </div>
            </button>
          ))}
        </div>
        {detail && selectedSlug ? (
          <CullingRecipeEditor
            key={`${detail.slug}-${detail.version}`}
            recipe={detail}
            onRefresh={refresh}
          />
        ) : null}
      </div>
      <div>
        <button
          type="button"
          className="text-sm font-medium text-text-secondary"
          onClick={() => setAdvancedOpen((o) => !o)}
        >
          {advancedOpen ? '▾' : '▸'} {CULL_ADVANCED}
        </button>
        {advancedOpen && (
          <div className="mt-2 p-3 bg-surface border border-border rounded-base max-w-md">
            <label className="block text-sm font-medium">{CULL_SCORE_FORECAST_THRESHOLD}</label>
            <input
              className="mt-1 w-28 border border-border rounded-base px-2 py-1 text-sm"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
            <p className="text-xs text-text-secondary mt-2">{CULL_THRESHOLD_NOTE}</p>
            <p className="text-xs text-text-tertiary mt-1">
              Current: {pipeline?.config.score_forecast.threshold ?? '—'}
            </p>
            <Button type="button" size="sm" className="mt-2" variant="primary" onClick={() => void saveThreshold()}>
              {CULL_SAVE}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
