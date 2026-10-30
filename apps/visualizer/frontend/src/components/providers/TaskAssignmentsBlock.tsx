import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  AppModelsAPI,
  CullingModelsAPI,
  CullingProfilesAPI,
  JobsAPI,
  ProvidersAPI,
  ScoreForecastQuestionsAPI,
  type AppModel,
  type CullingModelsResponse,
  type CullingStageModelPutRequest,
  type Provider,
  type ProviderModel,
} from '../../services/api'
import { invalidateAll } from '../../data'
import { useJobSocket } from '../../hooks/useJobSocket'
import type { Job } from '../../types/job'
import {
  CULLING_MODELS_SAVED,
  CULLING_MODELS_SAVED_JOB_WAITING,
  CULLING_MODELS_VIEW_QUEUE,
  PROCESSING_JOB_QUEUE_ROUTE,
  TASK_ASSIGNMENTS_HEADING,
  TASK_ASSIGNMENTS_LEAD,
  THIS_APP_SECTION_ID,
} from '../../constants/strings'
import { applyPipelineStageChange } from '../cull/pipelineStageSwitch'
import { useCullingGate } from '../cull/useCullingGate'
import { CullingStageTaskRow } from './CullingStageTaskRow'
import { DescriptionTaskRow } from './DescriptionTaskRow'

type Stage = 'culling_profile' | 'score_forecast'
const STAGES: readonly Stage[] = ['culling_profile', 'score_forecast']
const INSTALL_JOB_TYPE = 'app_model_install'
const CULLING_JOB_TYPE = 'batch_cull_photos_before_scoring'

interface TaskAssignmentsBlockProps {
  openAiProviders: Provider[]
  fallbackOrder: string[]
  modelCache: Record<string, ProviderModel[]>
  defaults: { description?: { provider?: string; model?: string | null } | null }
  defaultsNotice: string | null
  onRefreshBundle: () => void
}

export function TaskAssignmentsBlock({
  openAiProviders,
  fallbackOrder,
  modelCache,
  defaults,
  defaultsNotice,
  onRefreshBundle,
}: TaskAssignmentsBlockProps) {
  const [descriptionProvider, setDescriptionProvider] = useState<string | null>(null)
  const [descriptionModel, setDescriptionModel] = useState<string | null>(null)
  const [defaultsSaveMsg, setDefaultsSaveMsg] = useState<string | null>(null)

  const [pipelineOn, setPipelineOn] = useState<{ culling_profile: boolean; score_forecast: boolean } | null>(null)
  const [stageModels, setStageModels] = useState<CullingModelsResponse | null>(null)
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
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ stage: Stage; jobId: string | null } | null>(null)
  const [turningOn, setTurningOn] = useState<Stage | null>(null)

  const stageModelsRef = useRef(stageModels)
  stageModelsRef.current = stageModels
  const appModelsRef = useRef(appModels)
  appModelsRef.current = appModels

  const { hash } = useLocation()
  const loaded = pipelineOn !== null && stageModels !== null

  useEffect(() => {
    const block = defaults.description
    if (block?.provider) {
      setDescriptionProvider(block.provider)
      setDescriptionModel(block.model ?? null)
    }
  }, [defaults])

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

  const load = useCallback(async () => {
    try {
      const [{ config }, next] = await Promise.all([CullingProfilesAPI.getPipeline(), CullingModelsAPI.get()])
      setPipelineOn({
        culling_profile: config.culling_profiles_enabled,
        score_forecast: config.score_forecast.enabled,
      })
      setStageModels(next)
      for (const stage of STAGES) void loadProviderModels(stage, next[stage].endpoint)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load task assignments')
    }
  }, [loadProviderModels])

  useEffect(() => {
    void load()
    void refreshAppModels()
    ScoreForecastQuestionsAPI.get()
      .then((r) => setQuestionCount(r.questions.length))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [load, refreshAppModels])

  useEffect(() => {
    if (!loaded) return
    if (hash.startsWith('#task-')) {
      document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [loaded, hash])

  const { run: runCullingGate, dialog: cullingDialog } = useCullingGate({ onStageOff: () => void load() })

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
    if (!stageModels || stageModels[stage].endpoint === endpoint) return
    await saveStage(stage, { endpoint })
  }

  const onModel = async (stage: Stage, model: string | null) => {
    if (!stageModels) return
    const previous = stageModels[stage].model
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

  const scrollToThisApp = () =>
    document.getElementById(THIS_APP_SECTION_ID)?.scrollIntoView({ behavior: 'smooth' })

  const turnOnStage = async (stage: Stage) => {
    if (turningOn) return
    setTurningOn(stage)
    setSaved(null)
    setError(null)
    setPipelineOn((p) => (p ? { ...p, [stage]: true } : p))
    try {
      const { redecide_job_id } = await applyPipelineStageChange(stage, { enabled: true })
      setSaved({ stage, jobId: redecide_job_id })
      invalidateAll(['culling-profiles.pipeline'])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setTurningOn(null)
    }
    await load()
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

  const unparkProvider = async (providerId: string) => {
    setError(null)
    try {
      await ProvidersAPI.update(providerId, { enabled: true })
      await load()
      onRefreshBundle()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const updateFallbackOrder = async (order: string[]) => {
    await ProvidersAPI.updateFallbackOrder(order)
    onRefreshBundle()
  }

  const saveDescriptionDefaults = () => {
    if (!descriptionProvider) return
    ProvidersAPI.updateDefaults({
      description: {
        provider: descriptionProvider,
        model: descriptionModel,
      },
    })
      .then(() => {
        setDefaultsSaveMsg('Saved')
        window.setTimeout(() => setDefaultsSaveMsg(null), 2000)
        onRefreshBundle()
      })
      .catch(console.error)
  }

  if (!pipelineOn || !stageModels) {
    return error ? <p className="text-sm text-error">{error}</p> : null
  }

  return (
    <div className="divide-y divide-border rounded-base border border-border bg-bg">
      <div className="p-4">
        <h4 className="text-sm font-semibold text-text">{TASK_ASSIGNMENTS_HEADING}</h4>
        <p className="mt-1 text-sm text-text-secondary">{TASK_ASSIGNMENTS_LEAD}</p>
        {error ? <p className="mt-2 text-sm text-error">{error}</p> : null}
      </div>

      <DescriptionTaskRow
        providers={openAiProviders}
        fallbackOrder={fallbackOrder}
        modelCache={modelCache}
        descriptionProvider={descriptionProvider}
        descriptionModel={descriptionModel}
        defaultsNotice={defaultsNotice}
        onDescriptionChange={(providerId, modelId) => {
          setDescriptionProvider(providerId)
          setDescriptionModel(modelId)
        }}
        onSave={saveDescriptionDefaults}
        onReorderFallback={(order) => {
          updateFallbackOrder(order).catch(console.error)
        }}
        saveMessage={defaultsSaveMsg}
      />

      {STAGES.map((stage) => (
        <CullingStageTaskRow
          key={stage}
          stage={stage}
          stageOn={pipelineOn[stage]}
          stageModels={stageModels}
          appModels={appModels}
          providers={stageModels.system_one_providers}
          providerModels={providerModels[stage]}
          busy={busy === stage}
          suggest={suggest}
          queued={queued}
          queueing={queueing}
          questionCount={stage === 'score_forecast' && questionCount !== null ? questionCount : undefined}
          onEndpoint={(endpoint) => void onEndpoint(stage, endpoint)}
          onModel={(model) => void onModel(stage, model)}
          onAddModel={scrollToThisApp}
          onUnparkProvider={(id) => void unparkProvider(id)}
          onTurnOn={() => void turnOnStage(stage)}
          turnOnBusy={turningOn === stage}
          savedNote={savedNote(stage)}
          onProcessPhotos={() => void processPhotos(stage)}
          onDismissSuggest={() => setSuggest(null)}
        />
      ))}
      {cullingDialog}
    </div>
  )
}
