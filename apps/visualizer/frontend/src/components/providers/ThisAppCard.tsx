import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  APP_MODEL_ADD,
  APP_MODEL_ADD_BUTTON,
  APP_MODEL_ADD_COST_BODY,
  APP_MODEL_ADD_COST_CANCEL,
  APP_MODEL_ADD_COST_CONFIRM,
  APP_MODEL_ADD_COST_TITLE,
  APP_MODEL_ADD_HINT,
  APP_MODEL_ADDING,
  APP_MODEL_CHOOSE,
  APP_MODEL_CHOOSING,
  APP_MODEL_CONVERTING,
  APP_MODEL_INPUT_LABEL,
  APP_MODEL_INPUT_PLACEHOLDER,
  APP_MODEL_MANUAL,
  APP_MODEL_NOT_ADDED,
  APP_MODEL_READY,
  APP_MODEL_VIEW_JOB,
  APP_MODELS_EMPTY,
  APP_MODELS_LOADING,
  CULLING_MODELS_CANCEL,
  CULLING_PROFILE_STAGE,
  PROCESSING_JOB_QUEUE_ROUTE,
  SCORE_FORECAST_STAGE,
  THIS_APP_BUILT_IN,
  THIS_APP_CARD_LEAD,
  THIS_APP_CARD_TITLE,
  THIS_APP_SECTION_ID,
  THIS_APP_UNUSED,
  THIS_APP_USED_BY,
} from '../../constants/strings'
import { useAppModelPicker } from '../../hooks/useAppModelPicker'
import { useJobSocket } from '../../hooks/useJobSocket'
import type { Job } from '../../types/job'
import { Badge } from '../ui/badges'
import { Button } from '../ui/Button/Button'
import { ConfirmModalFrame } from '../ui/ConfirmUndoAction'
import { Input } from '../ui/Input/Input'
import { PathSummary, SettingRow } from '../processing/SettingRow'

const INSTALL_JOB_TYPE = 'app_model_install'

function SourceSummary({ source }: { source: string }) {
  return source.startsWith('/') || source.startsWith('~') ? <PathSummary path={source} /> : <span>{source}</span>
}

interface ThisAppCardProps {
  cullingProfileUsesThisApp: boolean
  scoreForecastUsesThisApp: boolean
}

export function ThisAppCard({ cullingProfileUsesThisApp, scoreForecastUsesThisApp }: ThisAppCardProps) {
  const { models, pickerUsable, draft, setDraft, picking, adding, error, pick, add, clear, refresh } =
    useAppModelPicker()
  const [typing, setTyping] = useState<boolean | null>(null)
  const [costConfirmOpen, setCostConfirmOpen] = useState(false)

  const onJobUpdated = useCallback(
    (job: Job) => {
      if (job.type === INSTALL_JOB_TYPE && job.status !== 'pending' && job.status !== 'running') void refresh()
    },
    [refresh],
  )
  useJobSocket({ onJobUpdated })

  const usedBy = useMemo(() => {
    const names: string[] = []
    if (cullingProfileUsesThisApp) names.push(CULLING_PROFILE_STAGE)
    if (scoreForecastUsesThisApp) names.push(SCORE_FORECAST_STAGE)
    if (names.length === 0) return THIS_APP_UNUSED
    if (names.length === 1) return THIS_APP_USED_BY(names[0]!)
    return THIS_APP_USED_BY(`${names[0]!} and ${names[1]!}`)
  }, [cullingProfileUsesThisApp, scoreForecastUsesThisApp])

  const manual = typing ?? !pickerUsable
  const changed = draft.trim() !== ''
  const busy = picking || adding

  const commit = () => {
    if (!changed || busy) return
    setCostConfirmOpen(true)
  }

  const confirmAdd = async () => {
    if (await add()) {
      setTyping(null)
      setCostConfirmOpen(false)
    }
  }

  const cancel = () => {
    clear()
    setTyping(null)
  }

  const addButton = (
    <Button type="button" size="sm" variant="primary" onClick={commit} disabled={busy || !changed}>
      {adding ? APP_MODEL_ADDING : APP_MODEL_ADD_BUTTON}
    </Button>
  )

  const cancelButton = (
    <Button type="button" size="sm" variant="ghost" onClick={cancel} disabled={adding}>
      {CULLING_MODELS_CANCEL}
    </Button>
  )

  return (
    <div id={THIS_APP_SECTION_ID} className="rounded-card border border-border bg-bg shadow-card overflow-hidden scroll-mt-6">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 bg-surface">
        <h3 className="text-base font-semibold text-text">{THIS_APP_CARD_TITLE}</h3>
        <Badge variant="accent">System One</Badge>
        <Badge variant="success">{THIS_APP_BUILT_IN}</Badge>
        <span className="text-xs text-text-tertiary">{usedBy}</span>
      </div>
      <p className="px-4 pt-3 text-sm text-text-secondary">{THIS_APP_CARD_LEAD}</p>

      <div className="divide-y divide-border mt-3">
        {models === null ? (
          <p className="px-4 py-3 text-sm text-text-secondary">{APP_MODELS_LOADING}</p>
        ) : models.length === 0 ? (
          <p className="px-4 py-3 text-sm text-text-secondary">{APP_MODELS_EMPTY}</p>
        ) : (
          models.map((m) => (
            <div key={m.name} data-model className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-text">{m.name}</div>
                {m.source && (
                  <div className="mt-0.5 text-sm text-text-secondary">
                    <SourceSummary source={m.source} />
                  </div>
                )}
              </div>
              <div className="flex flex-shrink-0 items-center gap-2">
                {m.status === 'ready' ? (
                  <Badge variant="success">{APP_MODEL_READY}</Badge>
                ) : (
                  <>
                    <Badge variant="accent">{APP_MODEL_CONVERTING}</Badge>
                    <Link to={PROCESSING_JOB_QUEUE_ROUTE} className="text-sm text-accent underline">
                      {APP_MODEL_VIEW_JOB}
                    </Link>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div data-add className="border-t border-border">
        <SettingRow
          name={APP_MODEL_ADD}
          description={
            changed ? (
              <span className="flex min-w-0 text-warning">
                <SourceSummary source={draft.trim()} />
                <span className="flex-shrink-0">&nbsp;{APP_MODEL_NOT_ADDED}</span>
              </span>
            ) : (
              APP_MODEL_ADD_HINT
            )
          }
          control={
            <>
              {pickerUsable && (
                <Button type="button" size="sm" variant="secondary" onClick={pick} disabled={manual || busy}>
                  {picking ? APP_MODEL_CHOOSING : APP_MODEL_CHOOSE}
                </Button>
              )}
              {!manual && changed && (
                <>
                  {addButton}
                  {cancelButton}
                </>
              )}
            </>
          }
          under={
            <>
              {error && <p className="mb-3 text-sm text-error">{error}</p>}
              <details open={manual} className="group">
                <summary
                  aria-disabled={busy}
                  onClick={(e) => {
                    e.preventDefault()
                    if (busy) return
                    setTyping(!manual)
                  }}
                  className={`inline-flex list-none items-center gap-1 text-sm [&::-webkit-details-marker]:hidden ${
                    busy ? 'cursor-default text-text-tertiary' : 'cursor-pointer text-accent'
                  }`}
                >
                  <span className="inline-block transition-transform group-open:rotate-90">›</span>
                  {APP_MODEL_MANUAL}
                </summary>
                <div className="mt-3 space-y-3">
                  <Input
                    id="app-model-source"
                    label={APP_MODEL_INPUT_LABEL}
                    placeholder={APP_MODEL_INPUT_PLACEHOLDER}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    fullWidth
                  />
                  <div className="flex flex-wrap gap-2">
                    {addButton}
                    {cancelButton}
                  </div>
                </div>
              </details>
            </>
          }
        />
      </div>

      {costConfirmOpen && (
        <ConfirmModalFrame
          title={APP_MODEL_ADD_COST_TITLE}
          confirmLabel={APP_MODEL_ADD_COST_CONFIRM}
          cancelLabel={APP_MODEL_ADD_COST_CANCEL}
          confirmVariant="primary"
          busy={adding}
          onConfirm={() => void confirmAdd()}
          onCancel={() => setCostConfirmOpen(false)}
        >
          <p className="text-sm text-text-secondary">{APP_MODEL_ADD_COST_BODY}</p>
        </ConfirmModalFrame>
      )}
    </div>
  )
}
