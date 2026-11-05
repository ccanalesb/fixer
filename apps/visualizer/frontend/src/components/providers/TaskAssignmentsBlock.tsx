import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import {
  AppModelsAPI,
  CullingModelsAPI,
  CULLING_JOB_TYPE,
  JobsAPI,
  ProvidersAPI,
  ScoreForecastQuestionsAPI,
  type AppModel,
  type CullingStageModelPutRequest,
  type Provider,
  type ProviderModel,
} from '../../services/api'
import { keys, useQuery } from '../../data'
import { useJobSocket } from '../../hooks/useJobSocket'
import type { Job } from '../../types/job'
import {
  TASK_ASSIGNMENTS_HEADING,
  TASK_ASSIGNMENTS_LEAD,
  THIS_APP_SECTION_ID,
} from '../../constants/strings'
import { applyPipelineStageChange } from '../cull/pipelineStageSwitch'
import { PipelineSavedNote } from '../cull/PipelineSavedNote'
import { useOptimisticPipeline } from '../cull/useOptimisticPipeline'
import { useCullingGate } from '../cull/useCullingGate'
import { CullingStageTaskRow } from './CullingStageTaskRow'
import { DescriptionTaskRow } from './DescriptionTaskRow'

type Stage = 'culling_profile' | 'score_forecast'
const STAGES: readonly Stage[] = ['culling_profile', 'score_forecast']
const INSTALL_JOB_TYPE = 'app_model_install'

interface TaskAssignmentsBlockProps {
  openAiProviders: Provider[]
  fallbackOrder: string[]
  modelCache: Record<string, ProviderModel[]>
  defaults: { description?: { provider?: string; model?: string | null } | null }
  defaultsNotice: string | null
  onRefreshBundle: () => void
}

export function TaskAssignmentsBlock(props: TaskAssignmentsBlockProps) {
  return (
    <Suspense fallback={null}>
      <TaskAssignmentsBlockInner {...props} />
    </Suspense>
  )
}

function TaskAssignmentsBlockInner({
  openAiProviders,
  fallbackOrder,
  modelCache,
  defaults,
  defaultsNotice,
  onRefreshBundle,
}: TaskAssignmentsBlockProps) {
  const { config: pipelineConfig, show: showPipeline } = useOptimisticPipeline()
  const questions = useQuery(keys.scoreForecastQuestions(), () => ScoreForecastQuestionsAPI.get())
  const stageModels = useQuery(keys.cullingModels(), () => CullingModelsAPI.get())
  const pipelineOn = {
    culling_profile: pipelineConfig.culling_profiles_enabled,
    score_forecast: pipelineConfig.score_forecast.enabled,
  }
  const questionCount = questions.questions.length
  const [descriptionProvider, setDescriptionProvider] = useState<string | null>(null)
  const [descriptionModel, setDescriptionModel] = useState<string | null>(null)
  const [defaultsSaveMsg, setDefaultsSaveMsg] = useState<string | null>(null)

  const [appModels, setAppModels] = useState<AppModel[]>([])
  const [providerModels, setProviderModels] = useState<Record<Stage, string[] | null>>({
    culling_profile: null,
    score_forecast: null,
  })
  const [busy, setBusy] = useState<Stage | null>(null)
  const [suggest, setSuggest] = useState<Stage | null>(null)
  const [queued, setQueued] = useState<Stage | null>(null)
  const [queueing, setQueueing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ stage: Stage; jobId: string | null } | null>(null)
  const [turningOn, setTurningOn] = useState<Stage | null>(null)

  const stageModelsRef = useRef(stageModels)
  stageModelsRef.current = stageModels
  const appModelsRef = useRef(appModels)
  appModelsRef.current = appModels

  const { hash } = useLocation()

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

  useEffect(() => {
    for (const stage of STAGES) void loadProviderModels(stage, stageModels[stage].endpoint)
  }, [stageModels, loadProviderModels])

  useEffect(() => {
    void refreshAppModels()
  }, [refreshAppModels])

  useEffect(() => {
    if (hash.startsWith('#task-')) {
      document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [hash, stageModels])

  const { run: runCullingGate, dialog: cullingDialog } = useCullingGate()

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
    const result = await runCullingGate('cull', () => JobsAPI.create(CULLING_JOB_TYPE, {}))
    if (result.status === 'started') {
      setQueued(stage)
      setSuggest(null)
    } else if (result.status === 'failed') {
      setError(result.error instanceof Error ? result.error.message : String(result.error))
    }
    setQueueing(false)
  }

  const scrollToThisApp = () =>
    document.getElementById(THIS_APP_SECTION_ID)?.scrollIntoView({ behavior: 'smooth' })

  const turnOnStage = async (stage: Stage) => {
    if (turningOn) return
    setTurningOn(stage)
    setSaved(null)
    setError(null)
    showPipeline(
      stage === 'culling_profile'
        ? { ...pipelineConfig, culling_profiles_enabled: true }
        : { ...pipelineConfig, score_forecast: { ...pipelineConfig.score_forecast, enabled: true } },
    )
    try {
      const { redecide_job_id } = await applyPipelineStageChange(stage, { enabled: true })
      setSaved({ stage, jobId: redecide_job_id })
    } catch (e) {
      showPipeline(null)
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setTurningOn(null)
    }
  }

  const savedNote = (stage: Stage): ReactNode =>
    saved?.stage === stage ? <PipelineSavedNote jobId={saved.jobId} /> : null

  const unparkProvider = async (providerId: string) => {
    setError(null)
    try {
      await ProvidersAPI.update(providerId, { enabled: true })
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
          questionCount={stage === 'score_forecast' ? questionCount : undefined}
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
