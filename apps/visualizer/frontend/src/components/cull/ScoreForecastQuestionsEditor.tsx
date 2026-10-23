import { useState } from 'react'
import {
  ApiRequestError,
  ScoreForecastQuestionsAPI,
  type SaveScoreForecastQuestionsResponse,
  type ScoreForecastQuestionsResponse,
} from '../../services/api'
import { Button } from '../ui/Button'
import {
  CULL_SAVE_AND_QUEUE,
  CULL_SAVE_ONLY,
  SFQ_ADD,
  SFQ_APPLIES,
  SFQ_LEVEL,
  SFQ_NAME,
  SFQ_NEW_NAME,
  SFQ_NONE,
  SFQ_OPTIONAL,
  SFQ_PERSPECTIVE,
  SFQ_PERSPECTIVE_HINT,
  SFQ_PERSPECTIVE_NONE,
  SFQ_QUESTION,
  SFQ_REMOVE,
  SFQ_REMOVE_TITLE,
  SFQ_TAB_LEVELS,
  SFQ_TAB_QUESTIONS,
  SFQ_VERSION_NOTE,
} from '../../constants/strings'
import { EmptyDot, Segmented } from './Segmented'
import {
  draftChanged,
  emptyLevels,
  newDraftQuestion,
  toDraft,
  toSaved,
  withIds,
  type DraftQuestion,
} from './forecastQuestionsDraft'

type Tab = 'questions' | 'levels'

const INPUT = 'w-full border border-border rounded-base px-2 py-1 bg-bg text-text text-sm'

export function ScoreForecastQuestionsEditor({
  current,
  onSaved,
}: {
  current: ScoreForecastQuestionsResponse
  onSaved: (res: SaveScoreForecastQuestionsResponse) => void
}) {
  const [draft, setDraft] = useState(() => toDraft(current.questions))
  const [tab, setTab] = useState<Tab>('questions')
  const [levelsKey, setLevelsKey] = useState(draft[0]?.key ?? '')
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<{ field: string; message: string }[]>([])

  const update = (key: string, change: Partial<DraftQuestion>) =>
    setDraft((d) => d.map((q) => (q.key === key ? { ...q, ...change } : q)))
  const errorsFor = (q: DraftQuestion, suffix?: string) =>
    q.id
      ? fieldErrors.filter((e) => (suffix ? e.field === `${q.id}.${suffix}` : e.field.split('.')[0] === q.id))
      : []

  const changed = draftChanged(draft, current.questions)
  const levelsQuestion = draft.find((q) => q.key === levelsKey) ?? draft[0]

  const save = async (mode: 'save_only' | 'save_and_queue_cull') => {
    const next = withIds(draft)
    setDraft(next)
    setError(null)
    setFieldErrors([])
    try {
      onSaved(await ScoreForecastQuestionsAPI.save(toSaved(next), mode))
    } catch (e) {
      if (e instanceof ApiRequestError) setFieldErrors([...e.validationErrors])
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const add = () => {
    const q = newDraftQuestion(SFQ_NEW_NAME)
    setDraft((d) => [...d, q])
    setLevelsKey(q.key)
  }

  return (
    <div className="space-y-4 text-sm">
      {error ? <p className="text-error text-xs">{error}</p> : null}

      <Segmented<Tab>
        asTabs
        label="Score forecast question sections"
        value={tab}
        onChange={setTab}
        options={[
          { id: 'questions', label: SFQ_TAB_QUESTIONS },
          { id: 'levels', label: SFQ_TAB_LEVELS },
        ]}
      />

      <div role="tabpanel">
        {tab === 'questions' ? (
          <div className="space-y-2">
            {draft.length === 0 ? <p className="text-text-secondary">{SFQ_NONE}</p> : null}
            {draft.map((q) => (
              <div key={q.key} className="bg-surface rounded-base p-3 flex flex-col gap-2">
                <div className="flex gap-2 items-center">
                  <input
                    className={`${INPUT} font-semibold`}
                    aria-label={SFQ_NAME}
                    value={q.name}
                    onChange={(e) => update(q.key, { name: e.target.value })}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    title={SFQ_REMOVE_TITLE}
                    onClick={() => setDraft((d) => d.filter((x) => x.key !== q.key))}
                  >
                    {SFQ_REMOVE}
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2 items-center">
                  <span className="font-medium text-text-secondary">{SFQ_PERSPECTIVE}</span>
                  <select
                    className="border border-border rounded-base px-2 py-1 bg-bg text-text"
                    aria-label={`${SFQ_PERSPECTIVE} · ${q.name}`}
                    value={q.perspective_slug ?? ''}
                    onChange={(e) => update(q.key, { perspective_slug: e.target.value || null })}
                  >
                    <option value="">{SFQ_PERSPECTIVE_NONE}</option>
                    {current.perspectives.map((p) => (
                      <option key={p.slug} value={p.slug}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs text-text-tertiary">{SFQ_PERSPECTIVE_HINT}</span>
                </div>
                <textarea
                  className={`${INPUT} min-h-[52px]`}
                  aria-label={`${SFQ_QUESTION} · ${q.name}`}
                  value={q.instructions}
                  onChange={(e) => update(q.key, { instructions: e.target.value })}
                />
                <label className="flex items-center gap-2 text-text-secondary">
                  <input
                    type="checkbox"
                    checked={q.optional}
                    onChange={(e) => update(q.key, { optional: e.target.checked })}
                  />
                  {SFQ_OPTIONAL}
                </label>
                {q.optional ? (
                  <div className="ml-4 pl-3 border-l-2 border-border flex flex-col gap-1.5">
                    <span className="font-medium text-text-secondary">{SFQ_APPLIES}</span>
                    <textarea
                      className={`${INPUT} min-h-[52px]`}
                      aria-label={`${SFQ_APPLIES} · ${q.name}`}
                      value={q.applies ?? ''}
                      onChange={(e) => update(q.key, { applies: e.target.value })}
                    />
                  </div>
                ) : null}
                {errorsFor(q).map((e) => (
                  <p key={e.field + e.message} className="text-xs text-error" role="alert">
                    {e.message}
                  </p>
                ))}
              </div>
            ))}
            <Button type="button" size="sm" variant="secondary" onClick={add}>
              {SFQ_ADD}
            </Button>
          </div>
        ) : null}

        {tab === 'levels' && levelsQuestion ? (
          <div className="space-y-3">
            <Segmented
              label={SFQ_TAB_LEVELS}
              value={levelsQuestion.key}
              onChange={setLevelsKey}
              options={draft.map((q) => {
                const e = emptyLevels(q)
                return { id: q.key, label: <>{q.name || SFQ_NEW_NAME}{e ? <EmptyDot>{e}</EmptyDot> : null}</> }
              })}
            />
            <div className="grid grid-cols-[28px_1fr] gap-x-2 gap-y-1.5 items-center">
              {levelsQuestion.levels.map((text, i) => (
                <div key={i} className="contents">
                  <span className="text-xs text-text-tertiary text-right">{i + 1}</span>
                  <input
                    className={`${INPUT} ${text.trim() ? '' : 'border-warning'}`}
                    aria-label={SFQ_LEVEL(i + 1, levelsQuestion.name)}
                    aria-invalid={!text.trim()}
                    value={text}
                    onChange={(e) =>
                      update(levelsQuestion.key, {
                        levels: levelsQuestion.levels.map((l, k) => (k === i ? e.target.value : l)),
                      })
                    }
                  />
                </div>
              ))}
            </div>
            {errorsFor(levelsQuestion, 'levels').map((e) => (
              <p key={e.message} className="text-xs text-error" role="alert">
                {e.message}
              </p>
            ))}
          </div>
        ) : null}
      </div>

      <p className="text-text-secondary">{SFQ_VERSION_NOTE}</p>
      <div className="flex flex-wrap gap-2 pt-3 border-t border-border">
        <Button type="button" size="sm" variant="secondary" disabled={!changed} onClick={() => void save('save_only')}>
          {CULL_SAVE_ONLY}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="primary"
          disabled={!changed}
          onClick={() => void save('save_and_queue_cull')}
        >
          {CULL_SAVE_AND_QUEUE}
        </Button>
      </div>
    </div>
  )
}
