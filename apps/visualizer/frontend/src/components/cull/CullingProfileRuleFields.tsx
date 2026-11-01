import type { CullProfileDetail } from '../../services/api'
import {
  CULL_RULE_HIGH,
  CULL_RULE_LEVEL_ARIA,
  CULL_RULE_LOW,
  CULL_RULE_MOVE_HINT,
  CULL_RULE_ON,
  CULL_RULE_SCALE,
  CULL_RULE_SCALE_BOTH,
  CULL_RULE_SCALE_EITHER,
  CULL_RULE_SENTENCE_START,
  CULL_RULE_SUBJECT_ARIA,
  CULL_RULE_SUBJECT_AVERAGE,
  CULL_RULE_SUBJECT_N,
  CULL_RULE_SUBJECT_THESE,
  CULL_RULE_UNLESS_HIGH,
  CULL_RULE_WHAT_COUNTS,
  CULL_RULE_COMBINE_ARIA,
  LR_WRITEBACK_STARS_STRONG_FROM,
  LR_WRITEBACK_STARS_STRONG_FROM_HELP,
  LR_WRITEBACK_STRONG_FROM_10,
  LR_WRITEBACK_STRONG_FROM_7,
  LR_WRITEBACK_STRONG_FROM_ANY,
  LR_WRITEBACK_STRONG_FROM_EVERY,
} from '../../constants/strings'
import { bandProblems, levelCount, setBands } from './profileDraft'

type Draft = Pick<CullProfileDetail, 'definition' | 'rule'>
type Rule = Draft['rule']
type Subject = `n${number}` | 'average' | 'these'

const SELECT = 'border border-border rounded-base px-2 py-0.5 bg-bg text-text font-medium'

function subjectOf(rule: Rule, dimCount: number): Subject {
  const fr = rule.filter_rule
  if (fr.type === 'mean_fail') return 'average'
  if (fr.type === 'all_fail') return 'these'
  return `n${Math.min(fr.n, dimCount)}`
}

const tint = (color: 'warning' | 'success') => ({
  background: `color-mix(in srgb, var(--color-${color}) 15%, transparent)`,
})

export function CullingProfileRuleFields({
  draft,
  setRule,
}: {
  draft: Draft
  setRule: (fn: (r: Rule) => Rule) => void
}) {
  const rule = draft.rule
  const dims = draft.definition.dimensions
  const sets = draft.definition.level_sets
  const filterRule = rule.filter_rule
  const usesHigh = filterRule.type === 'n_fail_unless_strong'

  const setSubject = (s: Subject) => {
    if (s === 'average') setRule((r) => ({ ...r, filter_rule: { type: 'mean_fail' } }))
    else if (s === 'these')
      setRule((r) => ({ ...r, filter_rule: { type: 'all_fail', dimensions: dims.map((d) => d.slug) } }))
    else setRule((r) => ({ ...r, filter_rule: { type: 'n_fail_unless_strong', n: Number(s.slice(1)) } }))
  }

  const moveLine = (setId: string, level: number) =>
    setRule((r) => {
      const bands = r.level_sets[setId]
      if (!bands) return r
      const next =
        level <= bands.fails_at_most + 1 && level < bands.strong_at_least
          ? { ...bands, fails_at_most: level === bands.fails_at_most ? Math.max(1, level - 1) : level }
          : usesHigh
            ? { ...bands, strong_at_least: level }
            : bands
      return setBands({ ...draft, rule: r }, setId, next).rule
    })

  return (
    <div className="space-y-4">
      <div className="rounded-base border border-border bg-surface px-4 py-3 text-base leading-9">
        {CULL_RULE_SENTENCE_START}{' '}
        <select
          className={SELECT}
          aria-label={CULL_RULE_SUBJECT_ARIA}
          value={subjectOf(rule, dims.length)}
          onChange={(e) => setSubject(e.target.value as Subject)}
        >
          {dims.map((_, i) => (
            <option key={i} value={`n${i + 1}`}>
              {CULL_RULE_SUBJECT_N(i + 1, dims.length)}
            </option>
          ))}
          <option value="these">{CULL_RULE_SUBJECT_THESE}</option>
          <option value="average">{CULL_RULE_SUBJECT_AVERAGE}</option>
        </select>{' '}
        <b className="text-warning">{CULL_RULE_LOW}</b>
        {usesHigh ? `, ${CULL_RULE_UNLESS_HIGH}` : null}
        {sets.length > 1 ? (
          <>
            , {CULL_RULE_ON}{' '}
            <select
              className={SELECT}
              aria-label={CULL_RULE_COMBINE_ARIA}
              value={rule.combine}
              onChange={(e) => setRule((r) => ({ ...r, combine: e.target.value as Rule['combine'] }))}
            >
              <option value="any">{CULL_RULE_SCALE_EITHER}</option>
              <option value="every">{CULL_RULE_SCALE_BOTH}</option>
            </select>
          </>
        ) : null}
        .
        {filterRule.type === 'all_fail' ? (
          <div className="flex flex-wrap gap-1.5 pb-1 leading-normal">
            {dims.map((d) => {
              const on = filterRule.dimensions.includes(d.slug)
              return (
                <button
                  key={d.slug}
                  type="button"
                  aria-pressed={on}
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${
                    on ? 'border-accent text-accent bg-accent-light' : 'border-border text-text-secondary bg-bg'
                  }`}
                  onClick={() =>
                    setRule((r) => ({
                      ...r,
                      filter_rule: {
                        type: 'all_fail',
                        dimensions: on
                          ? filterRule.dimensions.filter((s) => s !== d.slug)
                          : [...filterRule.dimensions, d.slug],
                      },
                    }))
                  }
                >
                  {d.name}
                </button>
              )
            })}
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="text-text-secondary">
          {CULL_RULE_WHAT_COUNTS}{' '}
          <b className="text-warning">{CULL_RULE_LOW}</b>
          {usesHigh ? (
            <>
              {' '}
              and <b className="text-success">{CULL_RULE_HIGH}</b>
            </>
          ) : null}
          <span className="text-xs text-text-tertiary"> · {CULL_RULE_MOVE_HINT}</span>
        </div>
        {sets.map((s) => {
          const bands = rule.level_sets[s.id]
          if (!bands) return null
          const n = levelCount(draft, s.id)
          return (
            <div key={s.id} className="grid grid-cols-[110px_1fr] items-center gap-3">
              <span className="text-xs text-text-tertiary">{CULL_RULE_SCALE(n)}</span>
              <div className="flex gap-0.5">
                {Array.from({ length: n }, (_, i) => i + 1).map((level) => {
                  const low = level <= bands.fails_at_most
                  const high = usesHigh && level >= bands.strong_at_least
                  const band = low ? CULL_RULE_LOW : high ? CULL_RULE_HIGH : null
                  return (
                    <button
                      key={level}
                      type="button"
                      aria-label={CULL_RULE_LEVEL_ARIA(level, n, band)}
                      className={`flex-1 rounded-base py-1 text-xs ${
                        low
                          ? 'text-warning font-semibold'
                          : high
                            ? 'text-success font-semibold'
                            : 'bg-surface text-text-tertiary hover:text-text'
                      }`}
                      style={low ? tint('warning') : high ? tint('success') : undefined}
                      onClick={() => moveLine(s.id, level)}
                    >
                      {level}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
        {bandProblems(draft).map((p) => (
          <p key={p.message} className="text-xs text-error" role="alert">
            {p.message}
          </p>
        ))}
      </div>

      <label className="block max-w-md">
        <span className="font-medium">{LR_WRITEBACK_STARS_STRONG_FROM}</span>
        <p className="text-xs text-text-secondary mb-1">{LR_WRITEBACK_STARS_STRONG_FROM_HELP}</p>
        <select
          className="w-full border border-border rounded-base px-2 py-1 bg-bg"
          value={rule.stars_strong_from ?? 'every'}
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
