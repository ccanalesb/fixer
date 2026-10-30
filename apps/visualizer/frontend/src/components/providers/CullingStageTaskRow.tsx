import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { AppModel, CullingModelsResponse, CullingStageKind, CullingSystemOneProvider } from '../../services/api'
import {
  CULLING_MODELS_VIEW_QUEUE,
  CULLING_PROFILE_STAGE,
  MODEL_CHANGE_ANSWERED,
  MODEL_CHANGE_LATER,
  MODEL_CHANGE_PROCESS,
  MODEL_CHANGE_QUEUED,
  MODEL_CHANGE_TITLE,
  MODEL_CHANGE_UNANSWERED,
  PROCESSING_JOB_QUEUE_ROUTE,
  PROCESSING_SETTINGS_STAGE_ROUTE,
  SCORE_FORECAST_STAGE,
  STAGE_IN_SENTENCE,
  TASK_CULLING_STAGE_SUB,
  TASK_OFF_IN_SETTINGS,
  TASK_TURN_ON_IN_SETTINGS,
} from '../../constants/strings'
import { Badge } from '../ui/badges'
import { Button } from '../ui/Button'
import { StageModelFields } from './StageModelFields'
import { stageDescription, stageProblem, shownModel, type StageView } from './stageModelView'

type Stage = CullingStageKind

const STAGE_NAME: Record<Stage, string> = {
  culling_profile: CULLING_PROFILE_STAGE,
  score_forecast: SCORE_FORECAST_STAGE,
}

export interface CullingStageTaskRowProps {
  stage: Stage
  stageOn: boolean
  stageModels: CullingModelsResponse
  appModels: AppModel[]
  providers: CullingSystemOneProvider[]
  providerModels: string[] | null
  busy: boolean
  suggest: Stage | null
  queued: Stage | null
  queueing: boolean
  questionCount?: number
  onEndpoint: (endpoint: string) => void
  onModel: (model: string | null) => void
  onAddModel: () => void
  onUnparkProvider: (providerId: string) => void
  onProcessPhotos: () => void
  onDismissSuggest: () => void
}

export function CullingStageTaskRow({
  stage,
  stageOn,
  stageModels,
  appModels,
  providers,
  providerModels,
  busy,
  suggest,
  queued,
  queueing,
  questionCount,
  onEndpoint,
  onModel,
  onAddModel,
  onUnparkProvider,
  onProcessPhotos,
  onDismissSuggest,
}: CullingStageTaskRowProps) {
  const view: StageView = {
    on: stageOn,
    saved: stageModels[stage],
    providerModels,
    appModels,
    providers,
    onUnparkProvider,
    ...(stage === 'score_forecast' && questionCount !== undefined ? { questionCount } : {}),
  }

  const problem = stageOn ? stageProblem(view) : null
  const showRedRow =
    stageOn &&
    problem &&
    (problem === 'parked' || problem === 'removed' || problem === 'nomodel' || problem === 'converting')

  const modelChangeNote = (): ReactNode => {
    if (queued === stage) {
      return (
        <p className="text-sm text-success">
          {MODEL_CHANGE_QUEUED}{' '}
          <Link to={PROCESSING_JOB_QUEUE_ROUTE} className="text-accent underline">
            {CULLING_MODELS_VIEW_QUEUE}
          </Link>
        </p>
      )
    }
    const model = shownModel(view)
    if (suggest !== stage || !stageOn || !model || stageProblem(view)) return null
    const answered = stageModels[stage].answered
    return (
      <div className="rounded-base border border-accent/25 bg-accent-light px-4 py-3 text-sm">
        <div className="font-semibold text-text">{MODEL_CHANGE_TITLE(STAGE_NAME[stage], model)}</div>
        <div className="text-text-secondary">
          {answered.photos > 0 && answered.model
            ? MODEL_CHANGE_ANSWERED(answered.photos, answered.model, model)
            : MODEL_CHANGE_UNANSWERED(STAGE_IN_SENTENCE[stage], stageModels.total_photos)}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="primary" disabled={queueing} onClick={onProcessPhotos}>
            {MODEL_CHANGE_PROCESS}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onDismissSuggest}>
            {MODEL_CHANGE_LATER}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div
      id={`task-${stage}`}
      data-stage={stage}
      className={`px-4 py-4 ${!stageOn ? 'opacity-80' : ''}`}
    >
      <div className="grid gap-4 md:grid-cols-[180px_1fr]">
        <div>
          <div className="text-sm font-semibold text-text">{STAGE_NAME[stage]}</div>
          <div className="text-xs text-text-tertiary">{TASK_CULLING_STAGE_SUB}</div>
        </div>
        <div className="flex flex-col gap-3 min-w-0">
          <div className="flex flex-wrap items-start gap-2">
            <StageModelFields
              kind={stage}
              view={view}
              busy={busy}
              onEndpoint={onEndpoint}
              onModel={onModel}
              onAddModel={onAddModel}
            />
            {!stageOn && (
              <div className="flex flex-wrap items-center gap-2 self-start">
                <Badge variant="default">{TASK_OFF_IN_SETTINGS}</Badge>
                <Link
                  to={PROCESSING_SETTINGS_STAGE_ROUTE(stage)}
                  className="text-sm text-accent underline"
                >
                  {TASK_TURN_ON_IN_SETTINGS}
                </Link>
              </div>
            )}
          </div>
          {showRedRow && (
            <div className="rounded-base border border-error/30 bg-error/5 px-3 py-2 text-sm text-error">
              <span data-stage-description>{stageDescription(stage, view)}</span>
            </div>
          )}
          {modelChangeNote()}
        </div>
      </div>
    </div>
  )
}
