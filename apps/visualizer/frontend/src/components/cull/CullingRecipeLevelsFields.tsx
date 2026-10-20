import { Fragment, useEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import {
  CULL_RECIPE_ADDED_LEVEL,
  CULL_RECIPE_ADD_LEVEL,
  CULL_RECIPE_ADD_LEVEL_SET_BUTTON,
  CULL_RECIPE_ADD_LEVEL_TOP,
  CULL_RECIPE_BAND_FAILS,
  CULL_RECIPE_BAND_RANGE,
  CULL_RECIPE_BAND_STRONG,
  CULL_RECIPE_CANCEL,
  CULL_RECIPE_CREATE,
  CULL_RECIPE_CREATED_SET,
  CULL_RECIPE_EMPTY_COUNT,
  CULL_RECIPE_EMPTY_LEVELS,
  CULL_RECIPE_EMPTY_PLACEHOLDER,
  CULL_RECIPE_FAILS_AT,
  CULL_RECIPE_FILL_ALL,
  CULL_RECIPE_INSERT_ABOVE,
  CULL_RECIPE_INSERT_BETWEEN,
  CULL_RECIPE_INSERT_HERE,
  CULL_RECIPE_INSERT_HINT,
  CULL_RECIPE_LAST_SET,
  CULL_RECIPE_LEVEL,
  CULL_RECIPE_LEVEL_COUNT,
  CULL_RECIPE_LEVEL_SET,
  CULL_RECIPE_MIN_LEVELS,
  CULL_RECIPE_NEW_LEVEL_PLACEHOLDER,
  CULL_RECIPE_NEW_LEVEL_TITLE,
  CULL_RECIPE_NEW_SET,
  CULL_RECIPE_NEW_SET_COPY,
  CULL_RECIPE_NEW_SET_EMPTY,
  CULL_RECIPE_NEW_SET_FROM,
  CULL_RECIPE_NEW_SET_LEVELS,
  CULL_RECIPE_NEW_SET_NAME,
  CULL_RECIPE_REMOVE,
  CULL_RECIPE_REMOVED_LEVEL,
  CULL_RECIPE_REMOVED_SET,
  CULL_RECIPE_REMOVE_LEVEL,
  CULL_RECIPE_REMOVE_SET,
  CULL_RECIPE_REMOVE_SET_BODY,
  CULL_RECIPE_REMOVE_SET_TITLE,
  CULL_RECIPE_STRONG_AT,
} from '../../constants/strings'
import { EmptyDot, Segmented } from './Segmented'
import {
  MAX_LEVELS_PER_SET,
  MIN_LEVELS_PER_SET,
  addLevelSet,
  bandProblems,
  emptyLevelCount,
  insertLevel,
  levelCount,
  newLevelSetProblem,
  removeLevel,
  removeLevelSet,
  setBands,
  setLevelText,
  type RecipeDraft,
} from './recipeDraft'

const NUM = 'w-14 border border-border rounded-base px-1 bg-bg'

export function CullingRecipeLevelsFields<T extends RecipeDraft>({
  draft,
  setDraft,
  fieldErrors,
}: {
  draft: T
  setDraft: (fn: (d: T) => T) => void
  fieldErrors: Record<string, string>
}) {
  const sets = draft.definition.level_sets
  const dims = draft.definition.dimensions
  const [setId, setSetId] = useState(sets[0]?.id ?? '')
  const [dimSlug, setDimSlug] = useState(dims[0]?.slug ?? '')
  const [form, setForm] = useState<{ at: number; texts: Record<string, string> } | null>(null)
  const [newSet, setNewSet] = useState<{ count: string; from: string } | null>(null)
  const [confirmRemoveSet, setConfirmRemoveSet] = useState(false)
  const [status, setStatus] = useState('')
  const firstFormField = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!sets.some((s) => s.id === setId) && sets[0]) setSetId(sets[0].id)
  }, [sets, setId])
  useEffect(() => {
    if (form) firstFormField.current?.focus()
  }, [form?.at]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = sets.find((s) => s.id === setId)
  const dim = dims.find((d) => d.slug === dimSlug) ?? dims[0]
  if (!set || !dim) return null
  const n = levelCount(draft, set.id)
  const bands = draft.rule.level_sets[set.id]
  const texts = set.levels[dim.slug] ?? []
  const empty = emptyLevelCount(draft)
  const problems = bandProblems(draft)
  const formReady = form !== null && dims.every((d) => (form.texts[d.slug] ?? '').trim())

  const pickSet = (id: string) => {
    setSetId(id)
    setForm(null)
    setConfirmRemoveSet(false)
    setStatus('')
  }
  const updateBand = (key: 'fails_at_most' | 'strong_at_least', value: string) => {
    if (!bands) return
    setDraft((d) => setBands(d, set.id, { ...bands, [key]: Number.parseInt(value, 10) || 0 }))
  }
  const addFromForm = () => {
    if (!form || !formReady) return
    setDraft((d) => insertLevel(d, set.id, form.at, form.texts))
    setStatus(CULL_RECIPE_ADDED_LEVEL(form.at + 1, dims.length))
    setForm(null)
  }
  const remove = (index: number) => {
    setDraft((d) => removeLevel(d, set.id, index))
    setStatus(CULL_RECIPE_REMOVED_LEVEL(index + 1, dims.length, index < n - 1))
  }
  const newSetCount = newSet ? Number.parseInt(newSet.count, 10) : Number.NaN
  const newSetProblem = newSet ? newLevelSetProblem(draft, newSetCount) : null
  const createSet = () => {
    if (!newSet || newSetProblem) return
    const from = newSet.from || null
    setDraft((d) => addLevelSet(d, newSetCount, from))
    setSetId(String(newSetCount))
    setNewSet(null)
    setStatus(CULL_RECIPE_CREATED_SET(String(newSetCount), newSetCount, from))
  }
  const removeSet = () => {
    const id = set.id
    setDraft((d) => removeLevelSet(d, id))
    setConfirmRemoveSet(false)
    setStatus(CULL_RECIPE_REMOVED_SET(id))
  }

  const failsTo = bands ? Math.min(bands.fails_at_most, n) : 0
  const strongFrom = bands?.strong_at_least ?? n + 1

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-text-secondary">{CULL_RECIPE_LEVEL_SET}</span>
        <Segmented
          label={CULL_RECIPE_LEVEL_SET}
          value={set.id}
          onChange={pickSet}
          options={sets.map((s) => {
            const e = emptyLevelCount(draft, s.id)
            return { id: s.id, label: <>{s.id}{e ? <EmptyDot>{e}</EmptyDot> : null}</> }
          })}
        />
        <span className="text-xs text-text-tertiary">{CULL_RECIPE_LEVEL_COUNT(n)}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={sets.length <= 1}
          title={sets.length <= 1 ? CULL_RECIPE_LAST_SET : undefined}
          onClick={() => setConfirmRemoveSet(true)}
        >
          {CULL_RECIPE_REMOVE_SET(set.id)}
        </Button>
        <span className="ml-auto">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => setNewSet((s) => (s ? null : { count: '5', from: '' }))}
          >
            {CULL_RECIPE_ADD_LEVEL_SET_BUTTON}
          </Button>
        </span>
      </div>

      {confirmRemoveSet ? (
        <div className="border border-border rounded-base p-3 space-y-2 max-w-md" role="alertdialog">
          <p className="font-semibold">{CULL_RECIPE_REMOVE_SET_TITLE(set.id)}</p>
          <p className="text-text-secondary">{CULL_RECIPE_REMOVE_SET_BODY(dims.length)}</p>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="danger" onClick={removeSet}>
              {CULL_RECIPE_REMOVE}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmRemoveSet(false)}>
              {CULL_RECIPE_CANCEL}
            </Button>
          </div>
        </div>
      ) : null}

      {newSet ? (
        <div className="border border-border rounded-base p-3 space-y-2 max-w-md shadow-card bg-bg">
          <p className="font-semibold">{CULL_RECIPE_NEW_SET}</p>
          <label className="flex items-center gap-2">
            {CULL_RECIPE_NEW_SET_LEVELS}
            <input
              type="number"
              className={NUM}
              min={MIN_LEVELS_PER_SET}
              max={MAX_LEVELS_PER_SET}
              value={newSet.count}
              onChange={(e) => setNewSet({ ...newSet, count: e.target.value })}
            />
          </label>
          <label className="flex items-center gap-2">
            {CULL_RECIPE_NEW_SET_FROM}
            <select
              className="border border-border rounded-base px-2 py-1 bg-bg"
              value={newSet.from}
              onChange={(e) => setNewSet({ ...newSet, from: e.target.value })}
            >
              <option value="">{CULL_RECIPE_NEW_SET_EMPTY}</option>
              {sets.map((s) => (
                <option key={s.id} value={s.id}>
                  {CULL_RECIPE_NEW_SET_COPY(s.id)}
                </option>
              ))}
            </select>
          </label>
          <p className={`text-xs ${newSetProblem ? 'text-error' : 'text-text-tertiary'}`}>
            {newSetProblem ?? CULL_RECIPE_NEW_SET_NAME(String(newSetCount))}
          </p>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="primary" disabled={Boolean(newSetProblem)} onClick={createSet}>
              {CULL_RECIPE_CREATE}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setNewSet(null)}>
              {CULL_RECIPE_CANCEL}
            </Button>
          </div>
        </div>
      ) : null}

      {bands ? (
        <div>
          <div className="flex flex-wrap gap-4 text-xs">
            <label>
              {CULL_RECIPE_FAILS_AT} ≤{' '}
              <input
                type="number"
                className={NUM}
                min={1}
                max={n}
                value={bands.fails_at_most}
                onChange={(e) => updateBand('fails_at_most', e.target.value)}
              />
            </label>
            <label>
              {CULL_RECIPE_STRONG_AT} ≥{' '}
              <input
                type="number"
                className={NUM}
                min={1}
                max={n}
                value={bands.strong_at_least}
                onChange={(e) => updateBand('strong_at_least', e.target.value)}
              />
            </label>
          </div>
          <p className="text-xs text-text-secondary mt-1">
            <b className="text-warning">{CULL_RECIPE_BAND_FAILS}</b> = {CULL_RECIPE_BAND_RANGE(1, failsTo)} ·{' '}
            <b className="text-success">{CULL_RECIPE_BAND_STRONG}</b> = {CULL_RECIPE_BAND_RANGE(strongFrom, n)}
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        {dims.map((d) => {
          const e = emptyLevelCount(draft, set.id, d.slug)
          const on = d.slug === dim.slug
          return (
            <button
              key={d.slug}
              type="button"
              aria-pressed={on}
              className={`rounded-full border px-2.5 py-0.5 text-xs inline-flex items-center gap-1.5 ${
                on ? 'border-accent text-accent bg-accent-light' : 'border-border text-text-secondary'
              }`}
              onClick={() => setDimSlug(d.slug)}
            >
              {d.name}
              {e ? <EmptyDot>{CULL_RECIPE_EMPTY_COUNT(e)}</EmptyDot> : null}
            </button>
          )
        })}
      </div>

      {form ? (
        <div className="border border-accent rounded-base p-3 bg-accent-light space-y-1.5">
          <p className="font-semibold">{CULL_RECIPE_NEW_LEVEL_TITLE(form.at + 1, form.at === n)}</p>
          {dims.map((d, i) => (
            <label key={d.slug} className="grid grid-cols-[130px_1fr] gap-2 items-center text-xs">
              <span>{d.name}</span>
              <input
                ref={i === 0 ? firstFormField : undefined}
                className="w-full border border-border rounded-base px-2 py-1 text-sm bg-bg"
                placeholder={CULL_RECIPE_NEW_LEVEL_PLACEHOLDER(form.at + 1)}
                value={form.texts[d.slug] ?? ''}
                onChange={(e) => setForm({ ...form, texts: { ...form.texts, [d.slug]: e.target.value } })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addFromForm()
                  if (e.key === 'Escape') setForm(null)
                }}
              />
            </label>
          ))}
          <div className="flex items-center gap-2 pt-1">
            <Button type="button" size="sm" variant="primary" disabled={!formReady} onClick={addFromForm}>
              {CULL_RECIPE_ADD_LEVEL}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setForm(null)}>
              {CULL_RECIPE_CANCEL}
            </Button>
            <span className="text-xs text-text-tertiary">{CULL_RECIPE_FILL_ALL(dims.length)}</span>
          </div>
        </div>
      ) : null}

      <div>
        {Array.from({ length: n }, (_, k) => n - 1 - k).map((i) => {
          const level = i + 1
          const tone =
            bands && level <= bands.fails_at_most
              ? 'text-warning'
              : bands && level >= bands.strong_at_least
                ? 'text-success'
                : 'text-text-tertiary'
          const text = texts[i] ?? ''
          const serverError = fieldErrors[`${set.id}|${dim.slug}|${i}`]
          return (
            <Fragment key={i}>
              {i === n - 1 ? (
                <InsertZone at={n} label={CULL_RECIPE_INSERT_ABOVE(n)} onInsert={(at) => setForm({ at, texts: {} })} />
              ) : null}
              <div className="group grid grid-cols-[70px_1fr_26px] gap-2 items-center">
                <span className={`text-xs ${tone}`}>{CULL_RECIPE_LEVEL(level)}</span>
                <input
                  className={`w-full border rounded-base px-2 py-1 text-sm ${
                    text.trim() ? 'border-border bg-bg' : 'border-warning bg-bg'
                  }`}
                  aria-label={`${CULL_RECIPE_LEVEL(level)} · ${dim.name}`}
                  aria-invalid={!text.trim() || Boolean(serverError)}
                  placeholder={CULL_RECIPE_EMPTY_PLACEHOLDER(level, dim.name)}
                  value={text}
                  onChange={(e) => setDraft((d) => setLevelText(d, set.id, dim.slug, i, e.target.value))}
                />
                <button
                  type="button"
                  className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-text-tertiary hover:text-error rounded-base leading-6 disabled:cursor-not-allowed"
                  aria-label={CULL_RECIPE_REMOVE_LEVEL(level)}
                  title={n <= MIN_LEVELS_PER_SET ? CULL_RECIPE_MIN_LEVELS : CULL_RECIPE_REMOVE_LEVEL(level)}
                  disabled={n <= MIN_LEVELS_PER_SET}
                  onClick={() => remove(i)}
                >
                  ×
                </button>
              </div>
              {i > 0 ? (
                <InsertZone
                  at={i}
                  label={CULL_RECIPE_INSERT_BETWEEN(i)}
                  onInsert={(at) => setForm({ at, texts: {} })}
                />
              ) : null}
            </Fragment>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={() => setForm({ at: n, texts: {} })}>
          {CULL_RECIPE_ADD_LEVEL_TOP}
        </Button>
        <span className="text-xs text-text-tertiary">{CULL_RECIPE_INSERT_HINT}</span>
      </div>

      {empty ? <p className="text-xs text-warning">{CULL_RECIPE_EMPTY_LEVELS(empty)}</p> : null}
      {problems.map((p) => (
        <p key={p.message} className="text-xs text-error" role="alert">
          {p.message}
        </p>
      ))}
      {fieldErrors[`bands|${set.id}`] ? (
        <p className="text-xs text-error" role="alert">
          {fieldErrors[`bands|${set.id}`]}
        </p>
      ) : null}
      <p className="text-xs text-text-tertiary min-h-4" role="status">
        {status}
      </p>
    </div>
  )
}

/** Thin gap between two levels; hover or focus shows the insert affordance. `at` = index of the new level. */
function InsertZone({ at, label, onInsert }: { at: number; label: string; onInsert: (at: number) => void }) {
  return (
    <button
      type="button"
      className="group/insert block w-full h-2 ml-[78px] -my-px relative text-left focus:outline-none"
      aria-label={label}
      onClick={() => onInsert(at)}
    >
      <span className="hidden group-hover/insert:block group-focus/insert:block absolute left-0 right-[112px] top-1/2 border-t border-dashed border-accent" />
      <span className="hidden group-hover/insert:inline group-focus/insert:inline absolute left-0 -top-1.5 text-[11px] text-accent bg-bg px-1">
        {CULL_RECIPE_INSERT_HERE}
      </span>
    </button>
  )
}
