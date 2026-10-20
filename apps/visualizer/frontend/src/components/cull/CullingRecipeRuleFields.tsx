import type { CullRecipeDetail } from '../../services/api'
import {
  CULL_RECIPE_COMBINE,
  CULL_RECIPE_COMBINE_ANY,
  CULL_RECIPE_COMBINE_EVERY,
  CULL_RECIPE_CUT_RULE,
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
import { Segmented } from './Segmented'

type Draft = Pick<CullRecipeDetail, 'definition' | 'rule'>

export function CullingRecipeRuleFields({
  draft,
  setRule,
}: {
  draft: Draft
  setRule: (fn: (r: Draft['rule']) => Draft['rule']) => void
}) {
  const cut = draft.rule.cut_rule
  return (
    <div className="space-y-3">
      <label className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{CULL_RECIPE_CUT_RULE}</span>
        <select
          className="border border-border rounded-base px-2 py-1 bg-bg"
          value={cut.type}
          onChange={(e) => {
            const t = e.target.value
            if (t === 'all_fail') {
              setRule((r) => ({
                ...r,
                cut_rule: { type: 'all_fail', dimensions: draft.definition.dimensions.map((d) => d.slug) },
              }))
            } else if (t === 'n_fail_unless_strong') {
              setRule((r) => ({ ...r, cut_rule: { type: 'n_fail_unless_strong', n: 2 } }))
            } else {
              setRule((r) => ({ ...r, cut_rule: { type: 'mean_fail' } }))
            }
          }}
        >
          <option value="all_fail">{CULL_RECIPE_RULE_ALL_FAIL}</option>
          <option value="n_fail_unless_strong">{CULL_RECIPE_RULE_N_FAIL}</option>
          <option value="mean_fail">{CULL_RECIPE_RULE_MEAN}</option>
        </select>
      </label>
      {cut.type === 'all_fail' ? (
        <div className="flex flex-wrap gap-3">
          {draft.definition.dimensions.map((dim) => (
            <label key={dim.slug} className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={cut.dimensions.includes(dim.slug)}
                onChange={(e) => {
                  const dims = e.target.checked
                    ? [...cut.dimensions, dim.slug]
                    : cut.dimensions.filter((s) => s !== dim.slug)
                  setRule((r) => ({ ...r, cut_rule: { type: 'all_fail', dimensions: dims } }))
                }}
              />
              {dim.name}
            </label>
          ))}
        </div>
      ) : null}
      {cut.type === 'n_fail_unless_strong' ? (
        <label className="text-xs">
          N{' '}
          <input
            type="number"
            className="w-14 border border-border rounded-base px-1 bg-bg"
            value={cut.n}
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
      <Segmented
        label={CULL_RECIPE_COMBINE}
        value={draft.rule.combine}
        onChange={(combine) => setRule((r) => ({ ...r, combine }))}
        options={[
          { id: 'every', label: CULL_RECIPE_COMBINE_EVERY },
          { id: 'any', label: CULL_RECIPE_COMBINE_ANY },
        ]}
      />
      <label className="block max-w-md">
        <span className="font-medium">{LR_WRITEBACK_STARS_STRONG_FROM}</span>
        <p className="text-xs text-text-secondary mb-1">{LR_WRITEBACK_STARS_STRONG_FROM_HELP}</p>
        <select
          className="w-full border border-border rounded-base px-2 py-1 bg-bg"
          value={draft.rule.stars_strong_from ?? 'every'}
          onChange={(e) =>
            setRule((r) => ({ ...r, stars_strong_from: e.target.value as '7' | '10' | 'every' | 'any' }))
          }
        >
          <option value="7">{LR_WRITEBACK_STRONG_FROM_7}</option>
          <option value="10">{LR_WRITEBACK_STRONG_FROM_10}</option>
          <option value="every">{LR_WRITEBACK_STRONG_FROM_EVERY}</option>
          <option value="any">{LR_WRITEBACK_STRONG_FROM_ANY}</option>
        </select>
      </label>
    </div>
  )
}
