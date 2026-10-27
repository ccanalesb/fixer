import { useCallback, useState } from 'react'
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
  APP_MODELS_SECTION,
  CULLING_MODELS_CANCEL,
  PROCESSING_JOB_QUEUE_ROUTE,
} from '../../constants/strings'
import { useAppModelPicker } from '../../hooks/useAppModelPicker'
import { useJobSocket } from '../../hooks/useJobSocket'
import type { Job } from '../../types/job'
import { Badge } from '../ui/badges'
import { Button } from '../ui/Button/Button'
import { ConfirmModalFrame } from '../ui/ConfirmUndoAction'
import { Input } from '../ui/Input/Input'
import { PathSummary, SettingRow } from './SettingRow'

const INSTALL_JOB_TYPE = 'app_model_install'

/** Where a stage row's "Add a model to this app" scrolls to. */
export const APP_MODELS_SECTION_ID = 'app-models'

/** A folder as a path that truncates its directory; a Hugging Face id as it is. */
function SourceSummary({ source }: { source: string }) {
  return source.startsWith('/') || source.startsWith('~') ? <PathSummary path={source} /> : <span>{source}</span>
}

/** Processing → Settings → Models in this app: what this app's System One endpoint serves, and adding one. */
export function AppModelsSection() {
  const { models, pickerUsable, draft, setDraft, picking, adding, error, pick, add, clear, refresh } =
    useAppModelPicker()
  // `null` means the user has not touched the disclosure, so it follows whether
  // there is a dialog to prefer over it.
  const [typing, setTyping] = useState<boolean | null>(null)
  const [costConfirmOpen, setCostConfirmOpen] = useState(false)

  // A conversion job that ends moves its model from Converting to Ready, or off
  // the list when it failed.
  const onJobUpdated = useCallback(
    (job: Job) => {
      if (job.type === INSTALL_JOB_TYPE && job.status !== 'pending' && job.status !== 'running') void refresh()
    },
    [refresh],
  )
  useJobSocket({ onJobUpdated })

  const manual = typing ?? !pickerUsable
  const changed = draft.trim() !== ''
  const busy = picking || adding

  // Only a queued conversion closes the field: on failure the value stays where
  // the user can correct it.
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
    <div id={APP_MODELS_SECTION_ID} className="divide-y divide-border rounded-base border border-border bg-bg">
      <div className="p-4">
        <h4 className="text-sm font-semibold text-text">{APP_MODELS_SECTION}</h4>
        <p className="mt-1 text-sm text-text-secondary">
          What this app serves on its own System One endpoint. Add one as a folder in Hugging Face format
          (<code>model.safetensors</code>, <code>processor/</code>, config) or a Hugging Face id; it is converted once in
          a job, which needs <code>uv</code>. Today only SmolVLM (Idefics3) models with a decision head convert.
        </p>
      </div>

      <div className="divide-y divide-border">
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

      <div data-add>
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
                // One way in at a time: with the field open, the dialog would
                // overwrite what is being typed.
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
