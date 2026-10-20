import type { CullRecipeDetail } from '../../services/api'
import {
  CULL_RECIPE_COMBINE_ANY,
  CULL_RECIPE_COMBINE_EVERY,
  CULL_RECIPE_RULE_ALL_FAIL,
  CULL_RECIPE_RULE_MEAN,
  CULL_RECIPE_RULE_N_FAIL,
} from '../../constants/strings'

type Draft = CullRecipeDetail

export function CullingRecipeRuleFields({
  draft,
  setRule,
}: {
  draft: Draft
  setRule: (fn: (r: Draft['rule']) => Draft['rule']) => void
}) {
  return (
    <>
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
    </>
  )
}
