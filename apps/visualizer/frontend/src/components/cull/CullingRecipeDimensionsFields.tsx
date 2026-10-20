import { CULL_RECIPE_DIMENSION_NAME, CULL_RECIPE_QUESTION } from '../../constants/strings'
import type { RecipeDraft } from './recipeDraft'

export function CullingRecipeDimensionsFields({
  draft,
  setDefinition,
  fieldErrors,
}: {
  draft: RecipeDraft
  setDefinition: (fn: (d: RecipeDraft['definition']) => RecipeDraft['definition']) => void
  fieldErrors: Record<string, string>
}) {
  const setDim = (index: number, patch: Partial<RecipeDraft['definition']['dimensions'][number]>) =>
    setDefinition((def) => ({
      ...def,
      dimensions: def.dimensions.map((d, i) => (i === index ? { ...d, ...patch } : d)),
    }))

  return (
    <div className="space-y-2">
      {draft.definition.dimensions.map((dim, di) => {
        const errors = draft.definition.level_sets
          .map((s) => fieldErrors[`${s.id}|${dim.slug}`])
          .filter((m): m is string => Boolean(m))
        return (
          <div key={dim.slug} className="p-3 bg-surface rounded-base space-y-2">
            <input
              className="w-full border border-border rounded-base px-2 py-1 font-semibold bg-bg"
              aria-label={CULL_RECIPE_DIMENSION_NAME}
              value={dim.name}
              onChange={(e) => setDim(di, { name: e.target.value })}
            />
            <textarea
              className="w-full border border-border rounded-base px-2 py-1 min-h-[52px] bg-bg"
              aria-label={CULL_RECIPE_QUESTION}
              placeholder={CULL_RECIPE_QUESTION}
              value={dim.question}
              aria-invalid={errors.length > 0}
              onChange={(e) => setDim(di, { question: e.target.value })}
            />
            {errors.map((msg) => (
              <p key={msg} className="text-error text-xs" role="alert">
                {msg}
              </p>
            ))}
          </div>
        )
      })}
    </div>
  )
}
