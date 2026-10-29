import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { AppModel, CullingStageKind, CullingStageModel, CullingSystemOneProvider } from '../../services/api'
import {
  APP_MODEL_VIEW_JOB,
  PROCESSING_JOB_QUEUE_ROUTE,
  STAGE_CONVERTING,
  STAGE_IN_SENTENCE,
  STAGE_NO_MODEL,
  STAGE_NO_QUESTIONS,
  STAGE_OFF,
  STAGE_OFF_WITH,
  STAGE_PARKED,
  STAGE_REMOVED,
  STAGE_RUNS,
  STAGE_STILL_CONVERTING,
  STAGE_THIS_APP,
  STAGE_TURN_PROVIDER_BACK_ON,
} from '../../constants/strings'

export type StageProblem = 'nomodel' | 'converting' | 'noquestions' | 'parked' | 'removed'

export interface StageView {
  on: boolean
  saved: CullingStageModel
  /** Models typed into the saved provider; null while loading. */
  providerModels: string[] | null
  appModels: AppModel[]
  providers: CullingSystemOneProvider[]
  /** The Score forecast's questions; unset for the culling profile. */
  questionCount?: number
  /** Unpark a System One provider from the stage row. */
  onUnparkProvider?: (providerId: string) => void
}

export function shownModel(v: StageView): string | null {
  return v.saved.model
}

export function endpointLabel(v: StageView): string {
  if (v.saved.endpoint === 'this_app') return STAGE_THIS_APP
  const p = v.providers.find((x) => x.id === v.saved.endpoint)
  return p ? `${p.name} (${p.url})` : v.saved.endpoint
}

function providerForEndpoint(v: StageView): CullingSystemOneProvider | null {
  if (v.saved.endpoint === 'this_app' || !v.saved.endpoint.trim()) return null
  return v.providers.find((x) => x.id === v.saved.endpoint) ?? null
}

/** The models the row offers: this app's (converting ones included), or the provider's typed models. */
export function offeredModels(v: StageView): { name: string; ready: boolean }[] {
  if (v.saved.endpoint === 'this_app') {
    return v.appModels.map((m) => ({ name: m.name, ready: m.status === 'ready' }))
  }
  return (v.providerModels ?? []).map((name) => ({ name, ready: true }))
}

/** Why a stage that is on cannot run; null when it can or is off. */
export function stageProblem(v: StageView): StageProblem | null {
  if (!v.on) return null
  const model = shownModel(v)
  if (!model) return 'nomodel'
  if (v.saved.endpoint !== 'this_app') {
    const endpoint = v.saved.endpoint.trim()
    if (!endpoint) return 'removed'
    const p = providerForEndpoint(v)
    if (!p) return 'removed'
    if (!p.enabled) return 'parked'
    return null
  }
  const found = offeredModels(v).find((m) => m.name === model)
  if (!found) return 'nomodel'
  if (!found.ready) return 'converting'
  return v.questionCount === 0 ? 'noquestions' : null
}

const stageOffLabel = (kind: CullingStageKind) => STAGE_IN_SENTENCE[kind]

/** The row's description: which model the stage runs where, or what keeps jobs from starting. */
export function stageDescription(kind: CullingStageKind, v: StageView): ReactNode {
  const model = shownModel(v)
  const where = endpointLabel(v)
  if (!v.on) return model ? STAGE_OFF_WITH(model, where) : STAGE_OFF
  const problem = stageProblem(v)
  const off = stageOffLabel(kind)
  if (problem === 'parked') {
    const p = providerForEndpoint(v)!
    return (
      <span className="text-error">
        {STAGE_PARKED(p.name, off)}{' '}
        <button
          type="button"
          className="text-accent underline"
          onClick={() => v.onUnparkProvider?.(p.id)}
        >
          {STAGE_TURN_PROVIDER_BACK_ON(p.name)}
        </button>
      </span>
    )
  }
  if (problem === 'removed') {
    return <span className="text-error">{STAGE_REMOVED(off)}</span>
  }
  if (problem === 'nomodel') return <span className="text-error">{STAGE_NO_MODEL(off)}</span>
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
