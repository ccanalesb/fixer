import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  AppModelsAPI,
  CullingModelsAPI,
  CullingProfilesAPI,
  JobsAPI,
  ScoreForecastQuestionsAPI,
  type AppModel,
  type CullingModelsResponse,
  type CullingStageModelPutRequest,
  type CullingSystemOneProvider,
  type PipelineChangeResponse,
  type PipelineSettingResponse,
} from '../../services/api'
import { invalidateAll } from '../../data'
import { useJobSocket } from '../../hooks/useJobSocket'
import type { Job } from '../../types/job'
import { Button } from '../ui/Button'
import { SettingRow } from './SettingRow'
import { StageModelFields } from './StageModelFields'
import { stageDescription, stageProblem, shownModel, type StageView } from './stageModelView'
import { APP_MODELS_SECTION_ID } from './AppModelsSection'
import { useCullingGate } from '../cull/useCullingGate'
import {
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
  MODEL_CHANGE_ANSWERED,
  MODEL_CHANGE_LATER,
  MODEL_CHANGE_PROCESS,
  MODEL_CHANGE_QUEUED,
  MODEL_CHANGE_TITLE,
  MODEL_CHANGE_UNANSWERED,
  PROCESSING_JOB_QUEUE_ROUTE,
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
  STAGE_IN_SENTENCE,
} from '../../constants/strings'

type Config = PipelineSettingResponse['config']
type Stage = 'culling_profile' | 'score_forecast'

const STAGES: readonly Stage[] = ['culling_profile', 'score_forecast']
const STAGE_NAME: Record<Stage, string> = { culling_profile: CULLING_PROFILE_STAGE, score_forecast: SCORE_FORECAST_STAGE }
const LEVELS = [5, 6, 7, 8, 9]
const INSTALL_JOB_TYPE = 'app_model_install'
const CULLING_JOB_TYPE = 'batch_cull_photos_before_scoring'
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

/**
 * Processing → Settings → Culling models: each stage's switch, endpoint and model, the culling profile's
 * filter, and the Score forecast's level and threshold.
 */
export function CullingModelsSection() {
  const [config, setConfig] = useState<Config | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ stage: Stage; jobId: string | null } | null>(null)
  const [threshold, setThreshold] = useState('')
  const [stageModels, setStageModels] = useState<CullingModelsResponse | null>(null)
  const [providers, setProviders] = useState<CullingSystemOneProvider[]>([])
  const [appModels, setAppModels] = useState<AppModel[]>([])
  const [providerModels, setProviderModels] = useState<Record<Stage, string[] | null>>({
    culling_profile: null,
    score_forecast: null,
  })
  const [busy, setBusy] = useState<Stage | null>(null)
  const [suggest, setSuggest] = useState<Stage | null>(null)
  const [queued, setQueued] = useState<Stage | null>(null)
  const [queueing, setQueueing] = useState(false)
  const [questionCount, setQuestionCount] = useState<number | null>(null)
  const [explain, setExplain] = useState(false)
  const [created, setCreated] = useState<{ skipped: string[] } | null>(null)
  const stageModelsRef = useRef(stageModels)
  stageModelsRef.current = stageModels
  const appModelsRef = useRef(appModels)
  appModelsRef.current = appModels

  const loadProviderModels = useCallback(async (stage: Stage, endpoint: string) => {
    if (endpoint === 'this_app') {
      setProviderModels((m) => ({ ...m, [stage]: null }))
      return
    }
    setProviderModels((m) => ({ ...m, [stage]: null }))
    try {
      const listed = await CullingModelsAPI.models(stage)
      setProviderModels((m) => ({
        ...m,
        [stage]: listed.answers ? listed.models : [],
      }))
    } catch {
      setProviderModels((m) => ({ ...m, [stage]: [] }))
    }
  }, [])

  const load = useCallback(async () => {
    try {
      const { config: next } = await CullingProfilesAPI.getPipeline()
      setConfig(next)
      setThreshold(String(next.score_forecast.threshold))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the pipeline setting')
    }
  }, [])

  const refreshAppModels = useCallback(async () => {
    try {
      const before = appModelsRef.current
      const { models } = await AppModelsAPI.list()
      setAppModels(models)
      const current = stageModelsRef.current
      if (!current) return
      for (const stage of STAGES) {
        const s = current[stage]
        if (s.endpoint !== 'this_app' || !s.model) continue
        const was = before.find((m) => m.name === s.model)
        const now = models.find((m) => m.name === s.model)
        if (was?.status === 'converting' && now?.status === 'ready') {
          setSuggest(stage)
          setQueued(null)
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
    void refreshAppModels()
    ScoreForecastQuestionsAPI.get()
      .then((r) => setQuestionCount(r.questions.length))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    void (async () => {
      try {
        const next = await CullingModelsAPI.get()
        setStageModels(next)
        setProviders(next.system_one_providers)
        for (const stage of STAGES) void loadProviderModels(stage, next[stage].endpoint)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load the culling models')
      }
    })()
  }, [load, refreshAppModels, loadProviderModels])

  const { run: runCullingGate, dialog: cullingDialog } = useCullingGate({ onStageOff: () => void load() })

  const { hash } = useLocation()
  const loaded = config !== null && stageModels !== null
  useEffect(() => {
    if (loaded && hash.startsWith('#stage-')) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [loaded, hash])

  const onJobUpdated = useCallback(
    (job: Job) => {
      if (job.type === INSTALL_JOB_TYPE && job.status !== 'pending' && job.status !== 'running') void refreshAppModels()
    },
    [refreshAppModels],
  )
  useJobSocket({ onJobUpdated })

  const saveStage = async (stage: Stage, body: CullingStageModelPutRequest) => {
    setBusy(stage)
    setError(null)
    try {
      const next = await CullingModelsAPI.save(stage, body)
      setStageModels((s) => (s ? { ...s, [stage]: next } : s))
      if (body.endpoint !== undefined) void loadProviderModels(stage, next.endpoint)
      return next
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
      return null
    } finally {
      setBusy(null)
    }
  }

  const onEndpoint = async (stage: Stage, endpoint: string) => {
    setSuggest(null)
    setQueued(null)
    if (stageModels![stage].endpoint === endpoint) return
    await saveStage(stage, { endpoint })
  }

  const onModel = async (stage: Stage, model: string | null) => {
    const previous = stageModels![stage].model
    const next = await saveStage(stage, { model })
    if (!next) return
    setQueued(null)
    setSuggest(model && model !== previous ? stage : null)
  }

  const processPhotos = async (stage: Stage) => {
    if (queueing) return
    setQueueing(true)
    setError(null)
    const failed = (e: unknown) => setError(e instanceof Error ? e.message : String(e))
    try {
      await runCullingGate('cull', async () => {
        try {
          await JobsAPI.create(CULLING_JOB_TYPE, {})
          setQueued(stage)
          setSuggest(null)
        } catch (e) {
          failed(e)
        }
      })
    } catch (e) {
      failed(e)
    } finally {
      setQueueing(false)
    }
  }

  const scrollToAppModels = () => document.getElementById(APP_MODELS_SECTION_ID)?.scrollIntoView({ behavior: 'smooth' })

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
    providerModels: providerModels[stage],
    appModels,
    providers,
    ...(stage === 'score_forecast' && questionCount !== null ? { questionCount } : {}),
  })

  const modelFields = (stage: Stage) => (
    <StageModelFields
      kind={stage}
      view={view(stage)}
      busy={busy === stage}
      onEndpoint={(endpoint) => void onEndpoint(stage, endpoint)}
      onModel={(model) => void onModel(stage, model)}
      onAddModel={scrollToAppModels}
    />
  )

  const description = (stage: Stage) => <span data-stage-description>{stageDescription(stage, view(stage))}</span>

  const modelChangeNote = (stage: Stage): ReactNode => {
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
    const v = view(stage)
    const model = shownModel(v)
    if (suggest !== stage || !v.on || !model || stageProblem(v)) return null
    const answered = v.saved.answered
    return (
      <div className="rounded-base border border-accent/25 bg-accent-light px-4 py-3 text-sm">
        <div className="font-semibold text-text">{MODEL_CHANGE_TITLE(STAGE_NAME[stage], model)}</div>
        <div className="text-text-secondary">
          {answered.photos > 0 && answered.model
            ? MODEL_CHANGE_ANSWERED(answered.photos, answered.model, model)
            : MODEL_CHANGE_UNANSWERED(STAGE_IN_SENTENCE[stage], stageModels.total_photos)}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="primary" disabled={queueing} onClick={() => void processPhotos(stage)}>
            {MODEL_CHANGE_PROCESS}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setSuggest(null)}>
            {MODEL_CHANGE_LATER}
          </Button>
        </div>
      </div>
    )
  }
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
      () => CullingProfilesAPI.saveCullingProfileSwitches(body),
    )

  const setForecast = (body: { enabled?: boolean; threshold?: number; high_from_level?: number }) =>
    void save('score_forecast', { ...config, score_forecast: { ...forecast, ...body } }, () =>
      CullingProfilesAPI.saveScoreForecast(body),
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
        <p className="mt-1 text-sm text-text-secondary">{CULLING_MODELS_SECTION_LEAD}</p>
        {error ? <p className="mt-2 text-sm text-error">{error}</p> : null}
      </div>

      <div id="stage-culling_profile" data-stage="culling_profile">
        <SettingRow
          name={CULLING_PROFILE_STAGE}
          description={description('culling_profile')}
          control={
            <Switch label={CULLING_PROFILE_STAGE} checked={cullingProfileOn} onChange={(on) => setCullingProfile({ enabled: on })} />
          }
          under={
            <div className="flex flex-col gap-3">
              <p className="text-xs text-text-tertiary">{CULLING_PROFILE_STAGE_HELP}</p>
              {modelFields('culling_profile')}
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
              {modelChangeNote('culling_profile')}
            </div>
          }
        />
      </div>

      <div id="stage-score_forecast" data-stage="score_forecast">
        <SettingRow
          name={SCORE_FORECAST_STAGE}
          description={description('score_forecast')}
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
              {modelFields('score_forecast')}
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
              {modelChangeNote('score_forecast')}
            </div>
          }
        />
      </div>
      {cullingDialog}
    </div>
  )
}
