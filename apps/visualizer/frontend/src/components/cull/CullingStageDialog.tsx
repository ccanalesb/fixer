import { useEffect, useId } from 'react'
import { Link } from 'react-router-dom'
import type { CullingModelsUsable, CullingStageKind } from '../../services/api'
import { Button } from '../ui/Button'
import {
  APP_MODEL_VIEW_JOB,
  CULLING_CANCEL,
  CULLING_CREATE_QUESTIONS,
  CULLING_FIX_IN_SETTINGS,
  PROCESSING_JOB_QUEUE_ROUTE,
  PROCESSING_SETTINGS_STAGE_ROUTE,
  STAGE_DIALOG_TURN_OFF,
} from '../../constants/strings'
import { stageDialogText, type CullingGateVerb } from './stageUsability'

const LINK_BUTTON =
  'inline-flex items-center rounded-base border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-hover'

/** Where the stage gets fixed: its conversion job, or its row in Settings → Culling models. */
export function StageFixLink({
  stage,
  usable,
  label,
  onClick,
}: {
  stage: CullingStageKind
  usable: CullingModelsUsable
  label?: string
  onClick?: () => void
}) {
  const problem = usable[stage].problem
  if (problem === 'converting') {
    return (
      <Link to={PROCESSING_JOB_QUEUE_ROUTE} className={LINK_BUTTON} onClick={onClick}>
        {APP_MODEL_VIEW_JOB}
      </Link>
    )
  }
  return (
    <Link to={PROCESSING_SETTINGS_STAGE_ROUTE(stage)} className={LINK_BUTTON} onClick={onClick}>
      {label ?? (problem === 'no_questions' ? CULLING_CREATE_QUESTIONS : CULLING_FIX_IN_SETTINGS)}
    </Link>
  )
}

/** Before a job that runs culling first: a stage that is on cannot run. */
export function CullingStageDialog({
  stage,
  usable,
  verb,
  busy,
  error,
  onCancel,
  onTurnOff,
}: {
  stage: CullingStageKind
  usable: CullingModelsUsable
  verb: CullingGateVerb
  busy: boolean
  error: string | null
  onCancel: () => void
  onTurnOff: () => void
}) {
  const titleId = useId()
  const { title, body } = stageDialogText(stage, usable, verb)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/35 p-4" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-[480px] rounded-card border border-border-strong bg-bg p-6 shadow-deep"
        onClick={(e) => e.stopPropagation()}
      >
        <h5 id={titleId} className="mb-2 text-lg font-bold tracking-tight text-text" title={usable[stage].detail ?? undefined}>
          {title}
        </h5>
        <p className="text-sm text-text-secondary">{body}</p>
        {error && <p className="mt-2 text-sm text-error">{error}</p>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            {CULLING_CANCEL}
          </Button>
          <StageFixLink stage={stage} usable={usable} onClick={onCancel} />
          <Button type="button" variant="primary" size="sm" onClick={onTurnOff} disabled={busy}>
            {STAGE_DIALOG_TURN_OFF[verb === 'send' ? 'send' : 'start']}
          </Button>
        </div>
      </div>
    </div>
  )
}
