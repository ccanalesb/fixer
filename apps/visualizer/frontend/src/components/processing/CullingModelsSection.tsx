import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  AppModelsAPI,
  CullingModelsAPI,
  CullingProfilesAPI,
  ScoreForecastQuestionsAPI,
  type AppModel,
  type CullingModelsResponse,
  type PipelineChangeResponse,
  type PipelineSettingResponse,
} from '../../services/api'
import { invalidateAll } from '../../data'
import {
  CULLING_CHANGE_IN_PROVIDERS,
  CULLING_FIX_IN_PROVIDERS_LINK,
  CULLING_MODEL_NOT_READY,
  CULLING_MODEL_SUMMARY,
  CULLING_MODELS_CANCEL,
  CULLING_MODELS_LOADING,
  CULLING_MODELS_NOT_SAVED,
  CULLING_MODELS_SAVE,
  CULLING_MODELS_SAVED,
  CULLING_MODELS_SAVED_JOB_WAITING,
  CULLING_MODELS_SECTION,
  CULLING_MODELS_SECTION_LEAD,
  CULLING_MODELS_VIEW_QUEUE,
  CULLING_PROFILE_FILTER,
  CULLING_PROFILE_FILTER_OFF,
  CULLING_PROFILE_FILTER_ON,
  CULLING_PROFILE_FILTER_UNAVAILABLE,
  CULLING_PROFILE_STAGE,
  CULLING_PROFILE_STAGE_HELP,
  PROCESSING_JOB_QUEUE_ROUTE,
  PROCESSING_PROVIDERS_ROUTE,
  PROCESSING_PROVIDERS_STAGE_ROUTE,
  SCORE_FORECAST_CREATE_FROM_PERSPECTIVES,
  SCORE_FORECAST_EDIT_QUESTIONS,
  SCORE_FORECAST_HOW,
  SCORE_FORECAST_HOW_TITLE,
  SCORE_FORECAST_LEVEL,
  SCORE_FORECAST_LEVEL_LABEL,
  SCORE_FORECAST_NO_QUESTIONS_HOW,
  SCORE_FORECAST_QUESTION_COUNT,
  SCORE_FORECAST_QUESTIONS_ROUTE,
  SCORE_FORECAST_SKIPPED,
  SCORE_FORECAST_STAGE,
  SCORE_FORECAST_STAGE_HELP,
  SCORE_FORECAST_THRESHOLD,
  SCORE_FORECAST_THRESHOLD_INVALID,
  SCORE_FORECAST_THRESHOLD_LABEL,
  SCORE_FORECAST_WRITE_THEM,
} from '../../constants/strings'
import { applyPipelineStageChange } from '../cull/pipelineStageSwitch'
import { Button } from '../ui/Button'
import { SettingRow } from './SettingRow'
import { endpointLabel, stageProblem, type StageView } from '../providers/stageModelView'

type Config = PipelineSettingResponse['config']
type Stage = 'culling_profile' | 'score_forecast'

const LEVELS = [5, 6, 7, 8, 9]
const LINK_BUTTON =
  'inline-flex items-center rounded-base border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-hover'

const validThreshold = (text: string) => {
  const n = Number(text)
  return text.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 1
}

function Switch({ label, checked, disabled, onChange }: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className={`relative inline-flex h-5 w-9 flex-none ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        className="peer sr-only"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="absolute inset-0 rounded-full bg-border-strong transition peer-checked:bg-accent peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-accent" />
      <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition peer-checked:translate-x-4" />
    </label>
  )
}

function ModelSummaryLine({ stage, view }: { stage: Stage; view: StageView }) {
  const model = view.saved.model
  const where = endpointLabel(view)
  const problem = view.on ? stageProblem(view) : null
  const providersStageRoute = PROCESSING_PROVIDERS_STAGE_ROUTE(stage)

  return (
    <div className="text-sm text-text-secondary">
      <span>{CULLING_MODEL_SUMMARY(model, where)} · </span>
      <Link to={providersStageRoute} className="text-accent underline">
        {CULLING_CHANGE_IN_PROVIDERS}
      </Link>
      {problem && problem !== 'noquestions' ? (
        <div className="mt-1 text-error">
          {CULLING_MODEL_NOT_READY} ·{' '}
          <Link to={providersStageRoute} className="text-accent underline">
            {CULLING_FIX_IN_PROVIDERS_LINK}
          </Link>
        </div>
      ) : null}
    </div>
  )
}

/** Processing → Settings → Culling: stage switches, filter, and Score forecast level, threshold and questions. */
export function CullingModelsSection() {
  const [config, setConfig] = useState<Config | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ stage: Stage; jobId: string | null } | null>(null)
  const [threshold, setThreshold] = useState('')
  const [stageModels, setStageModels] = useState<CullingModelsResponse | null>(null)
  const [appModels, setAppModels] = useState<AppModel[]>([])
  const [questionCount, setQuestionCount] = useState<number | null>(null)
  const [explain, setExplain] = useState(false)
  const [created, setCreated] = useState<{ skipped: string[] } | null>(null)

  const load = useCallback(async () => {
    try {
      const { config: next } = await CullingProfilesAPI.getPipeline()
      setConfig(next)
      setThreshold(String(next.score_forecast.threshold))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the pipeline setting')
    }
  }, [])

  useEffect(() => {
    void load()
    void AppModelsAPI.list()
      .then(({ models }) => setAppModels(models))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    ScoreForecastQuestionsAPI.get()
      .then((r) => setQuestionCount(r.questions.length))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    void CullingModelsAPI.get()
      .then(setStageModels)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load culling models'))
  }, [load])

  const { hash } = useLocation()
  const loaded = config !== null && stageModels !== null
  useEffect(() => {
    if (loaded && hash.startsWith('#stage-')) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [loaded, hash])

  const save = async (stage: Stage, shown: Config, call: () => Promise<PipelineChangeResponse>) => {
    setConfig(shown)
    setSaved(null)
    setError(null)
    try {
      const { redecide_job_id } = await call()
      setSaved({ stage, jobId: redecide_job_id })
      invalidateAll(['culling-profiles.pipeline'])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    }
    await load()
  }

  if (!config || !stageModels) {
    return error ? (
      <p className="text-sm text-error">{error}</p>
    ) : (
      <p className="text-sm text-text-secondary">{CULLING_MODELS_LOADING}</p>
    )
  }

  const forecast = config.score_forecast
  const cullingProfileOn = config.culling_profiles_enabled
  const on: Record<Stage, boolean> = { culling_profile: cullingProfileOn, score_forecast: forecast.enabled }

  const view = (stage: Stage): StageView => ({
    on: on[stage],
    saved: stageModels[stage],
    providerModels: null,
    appModels,
    providers: stageModels.system_one_providers,
    ...(stage === 'score_forecast' && questionCount !== null ? { questionCount } : {}),
  })

  const thresholdChanged = threshold.trim() !== String(forecast.threshold)
  const thresholdValid = validThreshold(threshold)

  const setCullingProfile = (body: { enabled?: boolean; filter_enabled?: boolean }) =>
    void save(
      'culling_profile',
      {
        ...config,
        culling_profiles_enabled: body.enabled ?? config.culling_profiles_enabled,
        culling_profiles_filter_enabled: body.filter_enabled ?? config.culling_profiles_filter_enabled,
      },
      () => applyPipelineStageChange('culling_profile', body),
    )

  const setForecast = (body: { enabled?: boolean; threshold?: number; high_from_level?: number }) =>
    void save('score_forecast', { ...config, score_forecast: { ...forecast, ...body } }, () =>
      applyPipelineStageChange('score_forecast', body),
    )

  const saveThreshold = () => {
    if (!thresholdChanged || !thresholdValid) return
    setForecast({ threshold: Number(threshold) })
  }

  const createQuestions = async () => {
    setError(null)
    try {
      const res = await ScoreForecastQuestionsAPI.fromPerspectives()
      setQuestionCount(res.questions.length)
      setCreated({ skipped: res.skipped })
      invalidateAll(['score-forecast-questions'])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const forecastExplain = (): ReactNode => {
    if (questionCount === null) return null
    const line =
      questionCount > 0 ? (
        <p className="text-sm text-text-secondary">
          {SCORE_FORECAST_QUESTION_COUNT(questionCount, created !== null)}{' '}
          <Link to={SCORE_FORECAST_QUESTIONS_ROUTE} className="text-accent underline">
            {SCORE_FORECAST_EDIT_QUESTIONS}
          </Link>
          {created?.skipped.length ? <span className="block text-warning">{SCORE_FORECAST_SKIPPED(created.skipped)}</span> : null}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="primary" onClick={() => void createQuestions()}>
            {SCORE_FORECAST_CREATE_FROM_PERSPECTIVES}
          </Button>
          <Link to={SCORE_FORECAST_QUESTIONS_ROUTE} className={LINK_BUTTON}>
            {SCORE_FORECAST_WRITE_THEM}
          </Link>
        </div>
      )
    if (!explain && questionCount > 0) return line
    return (
      <div className="rounded-base border border-accent/25 bg-accent-light px-4 py-3 text-sm">
        <div className="font-semibold text-text">{SCORE_FORECAST_HOW_TITLE}</div>
        <p className="mt-1 text-text-secondary">{SCORE_FORECAST_HOW(forecast.high_from_level)}</p>
        {questionCount === 0 ? <p className="mt-2 text-text-secondary">{SCORE_FORECAST_NO_QUESTIONS_HOW}</p> : null}
        <div className="mt-2">{line}</div>
      </div>
    )
  }

  const savedNote = (stage: Stage): ReactNode => {
    if (saved?.stage !== stage) return null
    return (
      <p className="text-sm text-success">
        {saved.jobId ? CULLING_MODELS_SAVED : CULLING_MODELS_SAVED_JOB_WAITING}{' '}
        <Link to={PROCESSING_JOB_QUEUE_ROUTE} className="text-accent underline">
          {CULLING_MODELS_VIEW_QUEUE}
        </Link>
      </p>
    )
  }

  return (
    <div className="divide-y divide-border rounded-base border border-border bg-bg">
      <div className="p-4">
        <h4 className="text-sm font-semibold text-text">{CULLING_MODELS_SECTION}</h4>
        <p className="mt-1 text-sm text-text-secondary">
          {CULLING_MODELS_SECTION_LEAD}{' '}
          <Link to={PROCESSING_PROVIDERS_ROUTE} className="text-accent underline">
            Providers
          </Link>
          .
        </p>
        {error ? <p className="mt-2 text-sm text-error">{error}</p> : null}
      </div>

      <div id="stage-culling_profile" data-stage="culling_profile">
        <SettingRow
          name={CULLING_PROFILE_STAGE}
          description={<ModelSummaryLine stage="culling_profile" view={view('culling_profile')} />}
          control={
            <Switch label={CULLING_PROFILE_STAGE} checked={cullingProfileOn} onChange={(on) => setCullingProfile({ enabled: on })} />
          }
          under={
            <div className="flex flex-col gap-3">
              <p className="text-xs text-text-tertiary">{CULLING_PROFILE_STAGE_HELP}</p>
              <div className="ml-4 flex items-center justify-between gap-4 rounded-base border border-border px-4 py-3">
                <div className="min-w-0">
                  <div className={`text-sm font-medium ${cullingProfileOn ? 'text-text' : 'text-text-tertiary'}`}>
                    {CULLING_PROFILE_FILTER}
                  </div>
                  <div className={`mt-0.5 text-sm ${cullingProfileOn ? 'text-text-secondary' : 'text-text-tertiary'}`}>
                    {!cullingProfileOn
                      ? CULLING_PROFILE_FILTER_UNAVAILABLE
                      : config.culling_profiles_filter_enabled
                        ? CULLING_PROFILE_FILTER_ON
                        : CULLING_PROFILE_FILTER_OFF}
                  </div>
                </div>
                <Switch
                  label={CULLING_PROFILE_FILTER}
                  checked={config.culling_profiles_filter_enabled}
                  disabled={!cullingProfileOn}
                  onChange={(on) => setCullingProfile({ filter_enabled: on })}
                />
              </div>
              {savedNote('culling_profile')}
            </div>
          }
        />
      </div>

      <div id="stage-score_forecast" data-stage="score_forecast">
        <SettingRow
          name={SCORE_FORECAST_STAGE}
          description={<ModelSummaryLine stage="score_forecast" view={view('score_forecast')} />}
          control={
            <Switch
              label={SCORE_FORECAST_STAGE}
              checked={forecast.enabled}
              onChange={(on) => {
                setExplain(on)
                setForecast({ enabled: on })
              }}
            />
          }
          under={
            <div className="flex flex-col gap-3">
              <p className="text-xs text-text-tertiary">{SCORE_FORECAST_STAGE_HELP}</p>
              {forecast.enabled ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium text-text-secondary">{SCORE_FORECAST_LEVEL_LABEL}</span>
                  <select
                    aria-label={SCORE_FORECAST_LEVEL}
                    className="border border-border rounded-base px-2 py-1 bg-bg"
                    value={forecast.high_from_level}
                    onChange={(e) => setForecast({ high_from_level: Number(e.target.value) })}
                  >
                    {LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                  <span className="font-medium text-text-secondary">{SCORE_FORECAST_THRESHOLD_LABEL}</span>
                  <input
                    aria-label={SCORE_FORECAST_THRESHOLD}
                    className="w-20 border border-border rounded-base px-2 py-1 bg-bg"
                    value={threshold}
                    onChange={(e) => setThreshold(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveThreshold()
                    }}
                  />
                  {thresholdChanged ? (
                    <>
                      <Button type="button" size="sm" variant="primary" disabled={!thresholdValid} onClick={saveThreshold}>
                        {CULLING_MODELS_SAVE}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setThreshold(String(forecast.threshold))}
                      >
                        {CULLING_MODELS_CANCEL}
                      </Button>
                    </>
                  ) : null}
                  {!thresholdValid && threshold.trim() !== '' ? (
                    <span className="text-error">{SCORE_FORECAST_THRESHOLD_INVALID}</span>
                  ) : thresholdChanged && thresholdValid ? (
                    <span className="text-warning">{CULLING_MODELS_NOT_SAVED}</span>
                  ) : null}
                </div>
              ) : null}
              {forecast.enabled ? forecastExplain() : null}
              {savedNote('score_forecast')}
            </div>
          }
        />
      </div>
    </div>
  )
}
