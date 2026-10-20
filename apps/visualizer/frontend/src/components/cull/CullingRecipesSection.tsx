import { useCallback, useEffect, useState } from 'react'
import { CullingRecipesAPI } from '../../services/api'
import { useQuery, invalidateAll } from '../../data'
import { Button } from '../ui/Button'
import { FoldingCard } from '../ui/Card'
import {
  CULL_ADD_RECIPE,
  CULL_NOT_MEASURED,
  CULL_RECIPES_HELP,
  CULL_RECIPES_SECTION,
  CULL_RECIPES_SUMMARY,
  CULL_RECIPE_ACTIVE,
  CULL_RECIPE_INACTIVE,
} from '../../constants/strings'
import { CullingRecipeEditor } from './CullingRecipeEditor'
import { minimalNewRecipeBody } from './minimalRecipe'

export function CullingRecipesSection() {
  const recipes = useQuery(['culling-recipes.list'] as const, () => CullingRecipesAPI.list())
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)

  const detail = useQuery(['culling-recipes.detail', selectedSlug ?? ''] as const, () =>
    selectedSlug ? CullingRecipesAPI.get(selectedSlug) : Promise.resolve(null),
  )

  useEffect(() => {
    if (selectedSlug === null && recipes?.recipes?.length) {
      setSelectedSlug(recipes.recipes[0]!.slug)
    }
  }, [recipes, selectedSlug])

  const refresh = useCallback(() => {
    invalidateAll(['culling-recipes.list', 'culling-recipes.pipeline', 'culling-recipes.detail'])
  }, [])

  const onAdd = async () => {
    const slug = `recipe-${Date.now()}`
    const created = await CullingRecipesAPI.create(minimalNewRecipeBody(slug, 'New recipe'))
    setSelectedSlug(created.slug)
    refresh()
  }

  const list = recipes?.recipes ?? []
  const summary = CULL_RECIPES_SUMMARY(
    list.length,
    list.filter((r) => r.active).map((r) => r.name),
  )

  return (
    <div className="mt-6">
      <FoldingCard title={CULL_RECIPES_SECTION} summary={summary} storageKey="lt.perspectives.recipes.open">
        <p className="text-sm text-text-secondary mb-4">{CULL_RECIPES_HELP}</p>
        <div className="flex flex-col lg:flex-row gap-6">
          <div className="w-full lg:w-72 shrink-0 space-y-3">
            <Button type="button" variant="primary" size="sm" onClick={() => void onAdd()}>
              {CULL_ADD_RECIPE}
            </Button>
            <div className="border border-border rounded-base divide-y divide-border max-h-[480px] overflow-y-auto">
              {list.map((r) => (
                <button
                  key={r.slug}
                  type="button"
                  className={`w-full text-left p-3 text-sm hover:bg-surface ${selectedSlug === r.slug ? 'bg-surface border-l-2 border-l-accent' : ''}`}
                  onClick={() => setSelectedSlug(r.slug)}
                >
                  <div className="font-medium">{r.name}</div>
                  <div className="text-text-tertiary text-xs">
                    v{r.version} ·{' '}
                    <span className={r.active ? 'text-success' : ''}>
                      {r.active ? CULL_RECIPE_ACTIVE : CULL_RECIPE_INACTIVE}
                    </span>
                    {!r.measured && <> · {CULL_NOT_MEASURED}</>}
                  </div>
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 min-w-0">
            {detail && selectedSlug ? (
              <CullingRecipeEditor key={`${detail.slug}-${detail.version}`} recipe={detail} onRefresh={refresh} />
            ) : null}
          </div>
        </div>
      </FoldingCard>
    </div>
  )
}
