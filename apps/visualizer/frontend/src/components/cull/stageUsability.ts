import type { CullingModelsUsable, CullingStageKind, CullingStageUsability } from '../../services/api'
import {
  CULLING_PROFILE_CONVERTING_SUB,
  CULLING_PROFILE_STAGE,
  CULLING_PROFILE_UNUSABLE,
  CULLING_PROFILE_UNUSABLE_SUB,
  SCORE_FORECAST_STAGE,
  SCORE_FORECAST_UNUSABLE,
  SCORE_FORECAST_WHY,
  STAGE_DIALOG_FIX,
  STAGE_DIALOG_RUNS,
  STAGE_DIALOG_WITHOUT_ANY,
  STAGE_DIALOG_WITHOUT_FORECAST_ALL,
  STAGE_DIALOG_WITHOUT_FORECAST_RULE,
  STAGE_DIALOG_WITHOUT_PROFILE,
  STAGE_IN_SENTENCE,
  STAGE_THIS_APP,
  STAGE_UNUSABLE_TITLE,
} from '../../constants/strings'

/** What is being started: describe / score / analyze, a send by hand, or a culling job on its own. */
export type CullingGateVerb = 'start' | 'send' | 'cull'

export const STAGE_NAME: Record<CullingStageKind, string> = {
  culling_profile: CULLING_PROFILE_STAGE,
  score_forecast: SCORE_FORECAST_STAGE,
}

/** The culling profile is asked about first. */
const ORDER: readonly CullingStageKind[] = ['culling_profile', 'score_forecast']

export const isUnusable = (s: CullingStageUsability): boolean => s.on && s.problem !== null

export function firstUnusable(u: CullingModelsUsable): CullingStageKind | null {
  return ORDER.find((k) => isUnusable(u[k])) ?? null
}

/** The answer once a stage was turned off: it no longer keeps anything from starting. */
export function withStageOff(u: CullingModelsUsable, stage: CullingStageKind): CullingModelsUsable {
  return { ...u, [stage]: { ...u[stage], on: false, problem: null } }
}

const endpointLabel = (s: CullingStageUsability) => (s.endpoint === 'this_app' ? STAGE_THIS_APP : s.endpoint)

/** The Cull tab's note when the culling profile is on and cannot run. */
export function cullingProfileNote(s: CullingStageUsability): { text: string; sub: string } {
  const where = endpointLabel(s)
  const text =
    s.problem === 'down' || s.problem === 'refused'
      ? CULLING_PROFILE_UNUSABLE[s.problem](where)
      : s.problem === 'not_listed'
        ? CULLING_PROFILE_UNUSABLE.not_listed(where, s.model ?? '')
        : s.problem === 'converting'
          ? CULLING_PROFILE_UNUSABLE.converting()
          : CULLING_PROFILE_UNUSABLE.no_model()
  return { text, sub: s.problem === 'converting' ? CULLING_PROFILE_CONVERTING_SUB : CULLING_PROFILE_UNUSABLE_SUB }
}

/** The Cull tab's warning when the Score forecast is on and cannot run. */
export function scoreForecastWarning(s: CullingStageUsability): string {
  return SCORE_FORECAST_UNUSABLE(SCORE_FORECAST_WHY[s.problem ?? 'no_model'])
}

/** The Start dialog's title and text: what the stage is missing, and what turning it off means. */
export function stageDialogText(
  stage: CullingStageKind,
  u: CullingModelsUsable,
  verb: CullingGateVerb,
): { title: string; body: string } {
  const s = u[stage]
  const title = STAGE_UNUSABLE_TITLE[s.problem ?? 'no_model'](STAGE_NAME[stage])
  const inRange = verb === 'start'
  const without =
    stage === 'culling_profile'
      ? u.score_forecast.on
        ? STAGE_DIALOG_WITHOUT_PROFILE
        : STAGE_DIALOG_WITHOUT_ANY(inRange)
      : u.culling_profile.on && u.culling_profile_filter
        ? STAGE_DIALOG_WITHOUT_FORECAST_RULE
        : STAGE_DIALOG_WITHOUT_FORECAST_ALL(inRange)
  const name = STAGE_IN_SENTENCE[stage]
  const body = `${STAGE_DIALOG_RUNS[verb](name)} ${STAGE_DIALOG_FIX(name, verb === 'send' ? 'send' : 'start')} ${without}`
  return { title, body }
}
