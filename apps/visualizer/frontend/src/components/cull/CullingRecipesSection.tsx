import { useCallback, useState } from 'react'
import { CullingRecipesAPI, type CullRecipeDetail } from '../../services/api'
import { useQuery, invalidateAll } from '../../data'
import { Button } from '../ui/Button'
import {
  CULL_ADD_RECIPE,
  CULL_ADVANCED,
  CULL_DUPLICATE,
  CULL_NOT_MEASURED,
  CULL_RECIPES_SECTION,
  CULL_RULE_SAVE_NOTE,
  CULL_SAVE,
  CULL_SAVE_AND_QUEUE,
  CULL_SAVE_ONLY,
  CULL_SCORE_FORECAST_THRESHOLD,
  CULL_THRESHOLD_NOTE,
} from '../../constants/strings'

export function CullingRecipesSection() {
  const recipes = useQuery(['culling-recipes.list'] as const, () => CullingRecipesAPI.list())
  const pipeline = useQuery(['culling-recipes.pipeline'] as const, () => CullingRecipesAPI.getPipeline())
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [threshold, setThreshold] = useState('0.111')
  const detail = useQuery(['culling-recipes.detail', selectedSlug ?? ''] as const, () =>
    selectedSlug ? CullingRecipesAPI.get(selectedSlug) : Promise.resolve(null),
  )

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

  const saveRule = async (recipe: CullRecipeDetail) => {
    await CullingRecipesAPI.saveRule(recipe.slug, recipe.rule)
    refresh()
  }

  const saveDefinition = async (recipe: CullRecipeDetail, mode: 'save_only' | 'save_and_queue_cull') => {
    await CullingRecipesAPI.saveDefinition(recipe.slug, { definition: recipe.definition, mode })
    refresh()
  }

  const toggleActive = async (slug: string, active: boolean) => {
    await CullingRecipesAPI.patch(slug, { active })
    refresh()
  }

  const saveThreshold = async () => {
    const n = Number.parseFloat(threshold)
    if (!Number.isFinite(n)) return
    await CullingRecipesAPI.saveScoreForecastThreshold(n)
    refresh()
  }

  const current = detail && selectedSlug ? detail : null

  return (
    <div className="mt-10 pt-8 border-t border-border space-y-4">
      <h3 className="text-section font-semibold">{CULL_RECIPES_SECTION}</h3>
      <div className="flex gap-2">
        <Button type="button" variant="primary" size="sm" onClick={() => void onAdd()}>
          {CULL_ADD_RECIPE}
        </Button>
      </div>
      <div className="grid lg:grid-cols-[240px_1fr] gap-4">
        <div className="border border-border rounded-base divide-y divide-border max-h-64 overflow-y-auto">
          {(recipes?.recipes ?? []).map((r) => (
            <button
              key={r.slug}
              type="button"
              className={`w-full text-left p-3 text-sm hover:bg-surface ${selectedSlug === r.slug ? 'bg-surface' : ''}`}
              onClick={() => setSelectedSlug(r.slug)}
            >
              <div className="font-medium">{r.name}</div>
              <div className="text-text-secondary text-xs">
                {r.slug} · v{r.version} · {r.active ? 'Active' : 'Inactive'}
                {!r.measured && <> · {CULL_NOT_MEASURED}</>}
              </div>
            </button>
          ))}
        </div>
        {current && (
          <div className="space-y-3 text-sm border border-border rounded-base p-4">
            <label className="block">
              Name
              <input
                className="mt-1 w-full border border-border rounded-base px-2 py-1"
                value={current.name}
                onChange={(e) => {
                  current.name = e.target.value
                }}
              />
            </label>
            <p className="text-text-secondary text-xs">{CULL_RULE_SAVE_NOTE}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => void saveRule(current)}>
                {CULL_SAVE}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void saveDefinition(current, 'save_only')}
              >
                {CULL_SAVE_ONLY}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="primary"
                onClick={() => void saveDefinition(current, 'save_and_queue_cull')}
              >
                {CULL_SAVE_AND_QUEUE}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void toggleActive(current.slug, !current.active)}
              >
                {current.active ? 'Deactivate' : 'Activate'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() =>
                  void CullingRecipesAPI.duplicate(current.slug, {
                    new_slug: `${current.slug}-copy`,
                  }).then(() => refresh())
                }
              >
                {CULL_DUPLICATE}
              </Button>
            </div>
          </div>
        )}
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
