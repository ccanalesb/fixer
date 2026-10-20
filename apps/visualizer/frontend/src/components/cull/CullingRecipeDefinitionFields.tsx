import type { CullRecipeDetail } from '../../services/api'
import { Button } from '../ui/Button'
import {
  CULL_RECIPE_ADD_LEVEL,
  CULL_RECIPE_ADD_LEVEL_SET,
  CULL_RECIPE_FAILS_AT,
  CULL_RECIPE_STRONG_AT,
} from '../../constants/strings'

type Draft = CullRecipeDetail

export function CullingRecipeDefinitionFields({
  draft,
  setDefinition,
  setRule,
  onNameBlur,
  onNameChange,
  fieldErrors = {},
}: {
  draft: Draft
  setDefinition: (fn: (d: Draft['definition']) => Draft['definition']) => void
  setRule: (fn: (r: Draft['rule']) => Draft['rule']) => void
  fieldErrors?: Record<string, string>
  onNameChange: (name: string) => void
  onNameBlur: () => void
}) {
  const fieldError = (key: string) => fieldErrors[key]
  const levelSetIds = draft.definition.level_sets.map((s) => s.id)

  const levelCount = (setId: string) =>
    draft.definition.level_sets.find((s) => s.id === setId)?.levels[draft.definition.dimensions[0]?.slug ?? '']?.length ?? 0

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

  return (
    <>
      <label className="block sm:max-w-md">
        Name
        <input
          className="mt-1 w-full border border-border rounded-base px-2 py-1"
          value={draft.name}
          onChange={(e) => onNameChange(e.target.value)}
          onBlur={onNameBlur}
        />
      </label>
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
              aria-invalid={Boolean(levelSetIds.map((id) => fieldError(`${id}|${dim.slug}`)).find(Boolean))}
              onChange={(e) =>
                setDefinition((def) => ({
                  ...def,
                  dimensions: def.dimensions.map((d, i) =>
                    i === di ? { ...d, question: e.target.value } : d,
                  ),
                }))
              }
            />
            {levelSetIds.map((setId) => {
              const msg = fieldError(`${setId}|${dim.slug}`)
              return msg ? (
                <p key={setId} className="text-error text-xs" role="alert">
                  {msg}
                </p>
              ) : null
            })}
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
    </>
  )
}
