import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { AppModel, CullingStageKind, CullingStageModel } from '../../services/api'
import {
  APP_MODEL_VIEW_JOB,
  PROCESSING_JOB_QUEUE_ROUTE,
  STAGE_CONVERTING,
  STAGE_DOWN,
  STAGE_GONE,
  STAGE_IN_SENTENCE,
  STAGE_NO_MODEL,
  STAGE_NO_QUESTIONS,
  STAGE_OFF,
  STAGE_OFF_WITH,
  STAGE_RUNS,
  STAGE_STILL_CONVERTING,
  STAGE_THIS_APP,
} from '../../constants/strings'

/** What Check found at a stage's saved URL. */
export type EndpointCheck = { status: 'checking' } | { status: 'ok'; models: string[] } | { status: 'down'; error: string }

/** The endpoint as the row shows it: "Another…" stays unsaved until Check. */
export interface EndpointDraft {
  other: boolean
  url: string
  key: string
}

export type StageProblem = 'down' | 'gone' | 'nomodel' | 'converting' | 'noquestions'

export interface StageView {
  on: boolean
  saved: CullingStageModel
  draft: EndpointDraft
  check: EndpointCheck | null
  appModels: AppModel[]
  /** The Score forecast's questions; unset for the culling profile. */
  questionCount?: number
}

/** The model the row shows: none while "Another…" is chosen but not saved yet. */
export function shownModel(v: StageView): string | null {
  return v.draft.other && v.saved.endpoint === 'this_app' ? null : v.saved.model
}

/** The models the row offers: this app's (converting ones included), or what Check found. */
export function offeredModels(v: StageView): { name: string; ready: boolean }[] {
  if (!v.draft.other) return v.appModels.map((m) => ({ name: m.name, ready: m.status === 'ready' }))
  return v.check?.status === 'ok' ? v.check.models.map((name) => ({ name, ready: true })) : []
}

/** Why a stage that is on cannot run; null when it can, is off, or Check has not answered yet. */
export function stageProblem(v: StageView): StageProblem | null {
  if (!v.on) return null
  if (v.draft.other && v.check?.status !== 'ok') return v.check?.status === 'checking' ? null : 'down'
  const model = shownModel(v)
  if (!model) return 'nomodel'
  const found = offeredModels(v).find((m) => m.name === model)
  if (!found) return v.draft.other ? 'gone' : 'nomodel'
  if (!found.ready) return 'converting'
  return v.questionCount === 0 ? 'noquestions' : null
}

/** The row's description: which model the stage runs where, or what keeps jobs from starting. */
export function stageDescription(kind: CullingStageKind, v: StageView): ReactNode {
  const model = shownModel(v)
  const where = v.draft.other ? v.saved.endpoint : STAGE_THIS_APP
  if (!v.on) return model ? STAGE_OFF_WITH(model, where) : STAGE_OFF
  const problem = stageProblem(v)
  if (problem === 'down') return <span className="text-error">{STAGE_DOWN(v.draft.url)}</span>
  if (problem === 'gone') return <span className="text-error">{STAGE_GONE(model!, v.saved.endpoint)}</span>
  if (problem === 'nomodel') return <span className="text-error">{STAGE_NO_MODEL(STAGE_IN_SENTENCE[kind])}</span>
  if (problem === 'converting') {
    return (
      <>
        {STAGE_CONVERTING(model!)}
        <span className="text-warning">{STAGE_STILL_CONVERTING}</span> ·{' '}
        <Link to={PROCESSING_JOB_QUEUE_ROUTE} className="text-accent underline">
          {APP_MODEL_VIEW_JOB}
        </Link>
      </>
    )
  }
  if (problem === 'noquestions') {
    return (
      <>
        {STAGE_RUNS(model!, where)} — <span className="text-error">{STAGE_NO_QUESTIONS}</span>
      </>
    )
  }
  return STAGE_RUNS(model ?? '', where)
}
