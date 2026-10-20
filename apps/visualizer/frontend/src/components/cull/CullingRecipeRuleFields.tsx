import type { CullRecipeDetail } from '../../services/api'
import {
  CULL_RECIPE_COMBINE_ANY,
  CULL_RECIPE_COMBINE_EVERY,
  CULL_RECIPE_RULE_ALL_FAIL,
  CULL_RECIPE_RULE_MEAN,
  CULL_RECIPE_RULE_N_FAIL,
  LR_WRITEBACK_STARS_STRONG_FROM,
  LR_WRITEBACK_STARS_STRONG_FROM_HELP,
  LR_WRITEBACK_STRONG_FROM_10,
  LR_WRITEBACK_STRONG_FROM_7,
  LR_WRITEBACK_STRONG_FROM_ANY,
  LR_WRITEBACK_STRONG_FROM_EVERY,
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
        <label className="block text-sm max-w-md">
          <span className="font-medium">{LR_WRITEBACK_STARS_STRONG_FROM}</span>
          <p className="text-xs text-text-secondary mb-1">{LR_WRITEBACK_STARS_STRONG_FROM_HELP}</p>
          <select
            className="w-full border border-border rounded-base px-2 py-1"
            value={draft.rule.stars_strong_from ?? 'every'}
            onChange={(e) =>
              setRule((r) => ({
                ...r,
                stars_strong_from: e.target.value as '7' | '10' | 'every' | 'any',
              }))
            }
          >
            <option value="7">{LR_WRITEBACK_STRONG_FROM_7}</option>
            <option value="10">{LR_WRITEBACK_STRONG_FROM_10}</option>
            <option value="every">{LR_WRITEBACK_STRONG_FROM_EVERY}</option>
            <option value="any">{LR_WRITEBACK_STRONG_FROM_ANY}</option>
          </select>
        </label>
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
