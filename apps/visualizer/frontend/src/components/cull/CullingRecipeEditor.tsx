import { useEffect, useState } from 'react'
import type { CullRecipeDetail } from '../../services/api'
import { CullingRecipesAPI } from '../../services/api'
import { Button } from '../ui/Button'
import {
  CULL_DUPLICATE,
  CULL_NOT_MEASURED,
  CULL_RECIPE_ACTIVATE,
  CULL_RECIPE_ADD_LEVEL,
  CULL_RECIPE_ADD_LEVEL_SET,
  CULL_RECIPE_COMBINE_ANY,
  CULL_RECIPE_COMBINE_EVERY,
  CULL_RECIPE_DEACTIVATE,
  CULL_RECIPE_FAILS_AT,
  CULL_RECIPE_MODEL,
  CULL_RECIPE_RULE_ALL_FAIL,
  CULL_RECIPE_RULE_MEAN,
  CULL_RECIPE_RULE_N_FAIL,
  CULL_RECIPE_STRONG_AT,
  CULL_RECIPE_TEXT_SAVE_IMPACT,
  CULL_RECIPE_UNMEASURED_HINT,
  CULL_RULE_SAVE_NOTE,
  CULL_SAVE,
  CULL_SAVE_AND_QUEUE,
  CULL_SAVE_ONLY,
} from '../../constants/strings'

type Draft = CullRecipeDetail

function cloneRecipe(r: CullRecipeDetail): Draft {
  return structuredClone(r)
}

export function CullingRecipeEditor({
  recipe,
  onRefresh,
}: {
  recipe: CullRecipeDetail
  onRefresh: () => void
}) {
  const [draft, setDraft] = useState(() => cloneRecipe(recipe))
  const [impact, setImpact] = useState<{ photos: number; hours_estimate: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDraft(cloneRecipe(recipe))
    setImpact(null)
    setError(null)
  }, [recipe.slug, recipe.version])

  const setDefinition = (fn: (d: Draft['definition']) => Draft['definition']) => {
    setDraft((d) => ({ ...d, definition: fn(d.definition) }))
  }
  const setRule = (fn: (r: Draft['rule']) => Draft['rule']) => {
    setDraft((d) => ({ ...d, rule: fn(d.rule) }))
  }

  const levelSetIds = draft.definition.level_sets.map((s) => s.id)

  const addLevel = (setId: string) => {
    setDefinition((def) => ({
      ...def,
      level_sets: def.level_sets.map((s) => {
        if (s.id !== setId) return s
        const nextLevels: Record<string, string[]> = {}
        for (const dim of def.dimensions) {
          const cur = s.levels[dim.slug] ?? []
          nextLevels[dim.slug] = [...cur, '']
        }
        return { ...s, levels: nextLevels }
      }),
    }))
  }

  const removeLevel = (setId: string, levelIndex: number) => {
    setDefinition((def) => ({
      ...def,
      level_sets: def.level_sets.map((s) => {
        if (s.id !== setId) return s
        const nextLevels: Record<string, string[]> = {}
        for (const dim of def.dimensions) {
          const cur = s.levels[dim.slug] ?? []
          if (cur.length <= 1) nextLevels[dim.slug] = cur
          else nextLevels[dim.slug] = cur.filter((_, i) => i !== levelIndex)
        }
        return { ...s, levels: nextLevels }
      }),
    }))
  }

  const addLevelSet = () => {
    const id = String(
      Math.max(0, ...draft.definition.level_sets.map((s) => Number.parseInt(s.id, 10) || 0)) + 1,
    )
    const nLevels = draft.definition.level_sets[0]?.levels[draft.definition.dimensions[0]?.slug ?? '']?.length ?? 5
    const levels: Record<string, string[]> = {}
    for (const dim of draft.definition.dimensions) {
      levels[dim.slug] = Array.from({ length: nLevels }, () => '')
    }
    setDefinition((def) => ({
      ...def,
      level_sets: [...def.level_sets, { id, levels }],
    }))
    setRule((rule) => ({
      ...rule,
      level_sets: {
        ...rule.level_sets,
        [id]: { fails_at_most: 2, strong_at_least: Math.max(3, nLevels - 1) },
      },
    }))
  }

  const removeLevelSet = (setId: string) => {
    if (draft.definition.level_sets.length <= 1) return
    setDefinition((def) => ({
      ...def,
      level_sets: def.level_sets.filter((s) => s.id !== setId),
    }))
    setRule((rule) => {
      const next = { ...rule.level_sets }
      delete next[setId]
      return { ...rule, level_sets: next }
    })
  }

  const saveMeta = async () => {
    await CullingRecipesAPI.patch(draft.slug, { name: draft.name, model: draft.model })
    onRefresh()
  }

  const saveRule = async () => {
    setError(null)
    await CullingRecipesAPI.saveRule(draft.slug, draft.rule)
    onRefresh()
  }

  const saveDefinition = async (mode: 'save_only' | 'save_and_queue_cull') => {
    setError(null)
    try {
      const res = await CullingRecipesAPI.saveDefinition(draft.slug, {
        definition: draft.definition,
        mode,
      })
      if (res.impact) setImpact(res.impact)
      onRefresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const levelCount = (setId: string) =>
    draft.definition.level_sets.find((s) => s.id === setId)?.levels[draft.definition.dimensions[0]?.slug ?? '']?.length ?? 0

  return (
    <div className="space-y-4 text-sm border border-border rounded-base p-4">
      {!draft.measured ? (
        <p className="text-warning text-xs">{CULL_NOT_MEASURED}. {CULL_RECIPE_UNMEASURED_HINT}</p>
      ) : null}
      {error ? <p className="text-error text-xs">{error}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          Name
          <input
            className="mt-1 w-full border border-border rounded-base px-2 py-1"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            onBlur={() => void saveMeta()}
          />
        </label>
        <label className="block">
          {CULL_RECIPE_MODEL}
          <input
            className="mt-1 w-full border border-border rounded-base px-2 py-1"
            value={draft.model}
            onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
            onBlur={() => void saveMeta()}
          />
        </label>
      </div>
      <p className="text-text-tertiary text-xs">{draft.slug} · v{draft.version}</p>

      <div className="space-y-3">
        <h4 className="font-medium">Dimensions</h4>
        {draft.definition.dimensions.map((dim, di) => (
          <div key={dim.slug} className="p-3 bg-surface rounded-base space-y-2">
            <input
              className="w-full border border-border rounded-base px-2 py-1 font-medium"
              value={dim.name}
              onChange={(e) =>
                setDefinition((def) => ({
                  ...def,
                  dimensions: def.dimensions.map((d, i) =>
                    i === di ? { ...d, name: e.target.value } : d,
                  ),
                }))
              }
            />
            <textarea
              className="w-full border border-border rounded-base px-2 py-1 min-h-[60px]"
              value={dim.question}
              placeholder="Question"
              onChange={(e) =>
                setDefinition((def) => ({
                  ...def,
                  dimensions: def.dimensions.map((d, i) =>
                    i === di ? { ...d, question: e.target.value } : d,
                  ),
                }))
              }
            />
          </div>
        ))}
      </div>

      {levelSetIds.map((setId) => {
        const n = levelCount(setId)
        const bands = draft.rule.level_sets[setId]
        return (
          <div key={setId} className="border border-border rounded-base p-3 space-y-2">
            <div className="flex justify-between items-center">
              <span className="font-medium">Level set {setId}</span>
              <button
                type="button"
                className="text-text-tertiary hover:text-error"
                aria-label={`Remove level set ${setId}`}
                onClick={() => removeLevelSet(setId)}
              >
                ×
              </button>
            </div>
            {bands ? (
              <div className="flex flex-wrap gap-4 text-xs">
                <label>
                  {CULL_RECIPE_FAILS_AT}{' '}
                  <input
                    type="number"
                    className="w-14 border border-border rounded-base px-1"
                    value={bands.fails_at_most}
                    min={1}
                    max={n}
                    onChange={(e) =>
                      setRule((rule) => ({
                        ...rule,
                        level_sets: {
                          ...rule.level_sets,
                          [setId]: {
                            ...bands,
                            fails_at_most: Number.parseInt(e.target.value, 10) || 1,
                          },
                        },
                      }))
                    }
                  />
                </label>
                <label>
                  {CULL_RECIPE_STRONG_AT}{' '}
                  <input
                    type="number"
                    className="w-14 border border-border rounded-base px-1"
                    value={bands.strong_at_least}
                    min={1}
                    max={n}
                    onChange={(e) =>
                      setRule((rule) => ({
                        ...rule,
                        level_sets: {
                          ...rule.level_sets,
                          [setId]: {
                            ...bands,
                            strong_at_least: Number.parseInt(e.target.value, 10) || 1,
                          },
                        },
                      }))
                    }
                  />
                </label>
              </div>
            ) : null}
            {Array.from({ length: n }, (_, li) => (
              <div key={li} className="grid gap-2">
                <div className="flex justify-between text-xs text-text-tertiary">
                  <span>Level {li + 1} (lowest first)</span>
                  {n > 1 ? (
                    <button type="button" onClick={() => removeLevel(setId, li)}>
                      ×
                    </button>
                  ) : null}
                </div>
                {draft.definition.dimensions.map((dim) => (
                  <input
                    key={dim.slug}
                    className="w-full border border-border rounded-base px-2 py-1 text-xs"
                    value={draft.definition.level_sets.find((s) => s.id === setId)?.levels[dim.slug]?.[li] ?? ''}
                    onChange={(e) =>
                      setDefinition((def) => ({
                        ...def,
                        level_sets: def.level_sets.map((s) => {
                          if (s.id !== setId) return s
                          const levels = { ...s.levels }
                          const arr = [...(levels[dim.slug] ?? [])]
                          arr[li] = e.target.value
                          levels[dim.slug] = arr
                          return { ...s, levels }
                        }),
                      }))
                    }
                  />
                ))}
              </div>
            ))}
            <Button type="button" size="sm" variant="secondary" onClick={() => addLevel(setId)}>
              {CULL_RECIPE_ADD_LEVEL}
            </Button>
          </div>
        )
      })}
      <Button type="button" size="sm" variant="secondary" onClick={addLevelSet}>
        {CULL_RECIPE_ADD_LEVEL_SET}
      </Button>

      <div className="space-y-2">
        <span className="font-medium">Level sets</span>
        <div className="inline-flex rounded-base border border-border p-0.5">
          <button
            type="button"
            className={`px-3 py-1 rounded-base text-xs ${draft.rule.combine === 'every' ? 'bg-surface font-semibold' : ''}`}
            onClick={() => setRule((r) => ({ ...r, combine: 'every' }))}
          >
            {CULL_RECIPE_COMBINE_EVERY}
          </button>
          <button
            type="button"
            className={`px-3 py-1 rounded-base text-xs ${draft.rule.combine === 'any' ? 'bg-surface font-semibold' : ''}`}
            onClick={() => setRule((r) => ({ ...r, combine: 'any' }))}
          >
            {CULL_RECIPE_COMBINE_ANY}
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <span className="font-medium">Cut rule</span>
        <select
          className="border border-border rounded-base px-2 py-1"
          value={draft.rule.cut_rule.type}
          onChange={(e) => {
            const t = e.target.value
            if (t === 'all_fail') {
              setRule((r) => ({
                ...r,
                cut_rule: {
                  type: 'all_fail',
                  dimensions: draft.definition.dimensions.map((d) => d.slug),
                },
              }))
            } else if (t === 'n_fail_unless_strong') {
              setRule((r) => ({
                ...r,
                cut_rule: { type: 'n_fail_unless_strong', n: 2 },
              }))
            } else {
              setRule((r) => ({ ...r, cut_rule: { type: 'mean_fail' } }))
            }
          }}
        >
          <option value="all_fail">{CULL_RECIPE_RULE_ALL_FAIL}</option>
          <option value="n_fail_unless_strong">{CULL_RECIPE_RULE_N_FAIL}</option>
          <option value="mean_fail">{CULL_RECIPE_RULE_MEAN}</option>
        </select>
        {draft.rule.cut_rule.type === 'all_fail' ? (
          <div className="flex flex-wrap gap-2">
            {draft.definition.dimensions.map((dim) => (
              <label key={dim.slug} className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={draft.rule.cut_rule.type === 'all_fail' && draft.rule.cut_rule.dimensions.includes(dim.slug)}
                  onChange={(e) => {
                    if (draft.rule.cut_rule.type !== 'all_fail') return
                    const dims = e.target.checked
                      ? [...draft.rule.cut_rule.dimensions, dim.slug]
                      : draft.rule.cut_rule.dimensions.filter((s) => s !== dim.slug)
                    setRule((r) => ({
                      ...r,
                      cut_rule: { type: 'all_fail', dimensions: dims },
                    }))
                  }}
                />
                {dim.name}
              </label>
            ))}
          </div>
        ) : null}
        {draft.rule.cut_rule.type === 'n_fail_unless_strong' ? (
          <label className="text-xs">
            N{' '}
            <input
              type="number"
              className="w-14 border border-border rounded-base px-1"
              value={draft.rule.cut_rule.n}
              min={1}
              onChange={(e) =>
                setRule((r) => ({
                  ...r,
                  cut_rule: { type: 'n_fail_unless_strong', n: Number.parseInt(e.target.value, 10) || 1 },
                }))
              }
            />
          </label>
        ) : null}
      </div>

      <p className="text-text-secondary text-xs">{CULL_RULE_SAVE_NOTE}</p>
      {impact ? (
        <p className="text-xs text-warning">{CULL_RECIPE_TEXT_SAVE_IMPACT(impact.photos, impact.hours_estimate)}</p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={() => void saveRule()}>
          {CULL_SAVE}
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => void saveDefinition('save_only')}>
          {CULL_SAVE_ONLY}
        </Button>
        <Button type="button" size="sm" variant="primary" onClick={() => void saveDefinition('save_and_queue_cull')}>
          {CULL_SAVE_AND_QUEUE}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => void CullingRecipesAPI.patch(draft.slug, { active: !draft.active }).then(onRefresh)}
        >
          {draft.active ? CULL_RECIPE_DEACTIVATE : CULL_RECIPE_ACTIVATE}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => {
            const newSlug = `${draft.slug}-copy`
            void CullingRecipesAPI.duplicate(draft.slug, { new_slug: newSlug }).then(onRefresh)
          }}
        >
          {CULL_DUPLICATE}
        </Button>
      </div>
    </div>
  )
}
