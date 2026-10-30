import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskAssignmentsBlock } from '../TaskAssignmentsBlock'
import {
  AppModelsAPI,
  CullingModelsAPI,
  CullingProfilesAPI,
  JobsAPI,
  ProvidersAPI,
  ScoreForecastQuestionsAPI,
  type AppModel,
  type CullingModelsResponse,
  type CullingModelsUsable,
  type CullingStageModel,
  type CullingStageUsability,
  type CullingSystemOneProvider,
  type PipelineSettingResponse,
} from '../../../services/api'
import {
  CULLING_PROFILE_STAGE,
  MODEL_CHANGE_LATER,
  MODEL_CHANGE_PROCESS,
  SCORE_FORECAST_STAGE,
  STAGE_ADD_MODEL,
  STAGE_ENDPOINT_PARKED,
  STAGE_ENDPOINT_THIS_APP,
  STAGE_PARKED,
  STAGE_PROVIDERS_LINK,
  STAGE_TURN_PROVIDER_BACK_ON,
  TASK_ASSIGNMENTS_HEADING,
  TASK_FALLBACK_LABEL,
  CULLING_MODELS_SAVED,
  TASK_OFF_IN_SETTINGS,
  TASK_TURN_ON_IN_SETTINGS,
  THIS_APP_SECTION_ID,
  PROCESSING_PROVIDERS_SYSTEM_ONE_ROUTE,
} from '../../../constants/strings'
import type { Job } from '../../../types/job'

vi.mock('../../ui/ProviderModelSelect', () => ({ ProviderModelSelect: () => null }))

const socket = vi.hoisted(() => ({ onJobUpdated: null as null | ((job: Job) => void) }))
vi.mock('../../../hooks/useJobSocket', () => ({
  useJobSocket: (opts: { onJobUpdated?: (job: Job) => void }) => {
    socket.onJobUpdated = opts.onJobUpdated ?? null
    return { connected: true, socket: null, jobListRevision: 0, refreshJobList: () => {} }
  },
}))

type Config = PipelineSettingResponse['config']
type Stage = 'culling_profile' | 'score_forecast'

let stored: Config
let stages: CullingModelsResponse
let appModels: AppModel[]
let providerModels: Record<string, string[]>
let systemOneProviders: CullingSystemOneProvider[]
let usable: CullingModelsUsable

const OLLAMA = 'http://localhost:11434'
const PROVIDER_ID = 'localhost-11434'
const stage = (over: Partial<CullingStageModel> = {}): CullingStageModel => ({
  endpoint: 'this_app',
  model: null,
  answered: { photos: 0, model: null },
  ...over,
})
const ready = (name: string): AppModel => ({ name, source: null, revision: null, status: 'ready', job_id: null })

function pipeline(over: Partial<Config> = {}, forecast: Partial<Config['score_forecast']> = {}) {
  stored = {
    culling_profiles_enabled: true,
    culling_profiles_filter_enabled: true,
    culling_profiles: [],
    score_forecast: { enabled: true, threshold: 0.111, high_from_level: 8, excused_at: 0.5 },
    ...over,
  } as Config
  stored.score_forecast = { ...stored.score_forecast, ...forecast }
}

const usableStage = (over: Partial<CullingStageUsability> = {}): CullingStageUsability => ({
  on: true,
  problem: null,
  model: 'culling-model',
  endpoint: 'this_app',
  job_id: null,
  provider_name: null,
  ...over,
})

beforeEach(() => {
  vi.restoreAllMocks()
  socket.onJobUpdated = null
  pipeline()
  usable = { culling_profile: usableStage(), score_forecast: usableStage({ model: 'forecast-model' }), culling_profile_filter: true }
  systemOneProviders = [{ id: PROVIDER_ID, name: 'Ollama', url: OLLAMA, enabled: true, has_key: true }]
  providerModels = { [PROVIDER_ID]: ['clef-flash'] }
  stages = {
    culling_profile: stage(),
    score_forecast: stage(),
    total_photos: 3,
    system_one_providers: systemOneProviders,
  }
  appModels = [ready('culling-model'), ready('forecast-model')]
  vi.spyOn(CullingModelsAPI, 'get').mockImplementation(async () => stages)
  vi.spyOn(CullingModelsAPI, 'save').mockImplementation(async (k: Stage, body) => {
    const s = stages[k]
    const endpoint = body.endpoint ?? s.endpoint
    const moved = endpoint !== s.endpoint
    const next = {
      ...s,
      endpoint,
      model: body.model !== undefined ? body.model : moved ? null : s.model,
    }
    stages = { ...stages, [k]: next }
    return next
  })
  vi.spyOn(CullingModelsAPI, 'models').mockImplementation(async (k: Stage) => {
    const ep = stages[k].endpoint
    if (ep === 'this_app') {
      return { answers: true, models: appModels.map((m) => m.name), error: null }
    }
    const listed = providerModels[ep]
    return listed ? { answers: true, models: listed, error: null } : { answers: false, models: [], error: 'Unknown provider' }
  })
  vi.spyOn(AppModelsAPI, 'list').mockImplementation(async () => ({ models: appModels, picker_available: true }))
  vi.spyOn(JobsAPI, 'create').mockResolvedValue({ id: 'job-cull' } as Job)
  vi.spyOn(CullingModelsAPI, 'usable').mockImplementation(async () => usable)
  vi.spyOn(CullingProfilesAPI, 'getPipeline').mockImplementation(async () => ({ version: 1, config: stored }))
  vi.spyOn(CullingProfilesAPI, 'saveCullingProfileSwitches').mockImplementation(async (body) => {
    if (body.enabled !== undefined) stored = { ...stored, culling_profiles_enabled: body.enabled }
    if (body.filter_enabled !== undefined) stored = { ...stored, culling_profiles_filter_enabled: body.filter_enabled }
    return { version: 2, redecide_job_id: 'job-9' }
  })
  vi.spyOn(CullingProfilesAPI, 'saveScoreForecast').mockImplementation(async (body) => {
    stored = { ...stored, score_forecast: { ...stored.score_forecast, ...body } }
    return { version: 2, redecide_job_id: 'job-9' }
  })
  vi.spyOn(ProvidersAPI, 'getFallbackOrder').mockResolvedValue({ order: [] })
  vi.spyOn(ProvidersAPI, 'updateFallbackOrder').mockResolvedValue({ order: [] })
  vi.spyOn(ScoreForecastQuestionsAPI, 'get').mockResolvedValue({ questions: [], version: 0, perspectives: [] })
})

function renderBlock(initial = '/processing?tab=providers') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <TaskAssignmentsBlock
        openAiProviders={[]}
        fallbackOrder={['ollama']}
        modelCache={{}}
        defaults={{ description: { provider: 'ollama', model: null } }}
        defaultsNotice={null}
        onRefreshBundle={() => {}}
      />
    </MemoryRouter>,
  )
}

describe('TaskAssignmentsBlock', () => {
  const row = async (k: Stage) => {
    await screen.findByText(TASK_ASSIGNMENTS_HEADING)
    return document.querySelector(`[data-stage="${k}"]`) as HTMLElement
  }
  const control = (r: HTMLElement, name: string) => within(r).getByRole('combobox', { name })
  const desc = (r: HTMLElement) => r.querySelector('[data-stage-description]')!.textContent

  it('shows the task block with fallback order under Descriptions', async () => {
    renderBlock()
    expect(await screen.findByText(TASK_ASSIGNMENTS_HEADING)).toBeInTheDocument()
    expect(screen.getByText(TASK_FALLBACK_LABEL)).toBeInTheDocument()
    expect(screen.getByText('Descriptions')).toBeInTheDocument()
    expect(screen.getByText(CULLING_PROFILE_STAGE)).toBeInTheDocument()
    expect(screen.getByText(SCORE_FORECAST_STAGE)).toBeInTheDocument()
  })

  it('choosing a model saves it once and offers to process the photos the previous model answered', async () => {
    stages.culling_profile = stage({ model: 'culling-model', answered: { photos: 100, model: 'culling-model' } })
    appModels = [ready('culling-model'), ready('my-run-best')]
    renderBlock()
    const cull = await row('culling_profile')
    await waitFor(() => expect(within(cull).getByRole('option', { name: 'my-run-best' })).toBeInTheDocument())
    fireEvent.change(control(cull, 'Model'), { target: { value: 'my-run-best' } })
    expect(await within(cull).findByText('Culling profile now uses my-run-best.')).toBeInTheDocument()
    expect(CullingModelsAPI.save).toHaveBeenCalledWith('culling_profile', { model: 'my-run-best' })
    fireEvent.click(within(cull).getByRole('button', { name: MODEL_CHANGE_PROCESS }))
    expect(await within(cull).findByText('Job queued ·', { exact: false })).toBeInTheDocument()
    expect(JobsAPI.create).toHaveBeenCalledWith('batch_cull_photos_before_scoring', {})
  })

  it('arriving from Fix in Providers scrolls to that stage row', async () => {
    const scrolled: string[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id)
    }
    try {
      renderBlock('/processing?tab=providers#task-score_forecast')
      await waitFor(() => expect(scrolled).toEqual(['task-score_forecast']))
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it('marks a stage that is off in Settings', async () => {
    pipeline({}, { enabled: false })
    renderBlock()
    const forecast = await row('score_forecast')
    expect(within(forecast).getByText(TASK_OFF_IN_SETTINGS)).toBeInTheDocument()
  })

  it('Turn on enables the stage in place and shows the re-decide note', async () => {
    pipeline({}, { enabled: false })
    renderBlock()
    const forecast = await row('score_forecast')
    fireEvent.click(within(forecast).getByRole('button', { name: TASK_TURN_ON_IN_SETTINGS }))
    await waitFor(() => expect(CullingProfilesAPI.saveScoreForecast).toHaveBeenCalledWith({ enabled: true }))
    expect(within(forecast).queryByText(TASK_OFF_IN_SETTINGS)).not.toBeInTheDocument()
    expect(await within(forecast).findByText(CULLING_MODELS_SAVED, { exact: false })).toBeInTheDocument()
    expect(desc(forecast)).toContain("No model chosen")
  })

  it('a parked provider shows Turn back on in the red row', async () => {
    systemOneProviders = [{ id: PROVIDER_ID, name: 'Ollama', url: OLLAMA, enabled: false, has_key: true }]
    stages = {
      ...stages,
      system_one_providers: systemOneProviders,
      culling_profile: stage({ endpoint: PROVIDER_ID, model: 'clef-flash' }),
    }
    vi.spyOn(ProvidersAPI, 'update').mockResolvedValue({ provider: {} as never })
    renderBlock()
    const cull = await row('culling_profile')
    expect(desc(cull)).toContain(STAGE_PARKED('Ollama', 'the culling profile'))
    fireEvent.click(within(cull).getByRole('button', { name: STAGE_TURN_PROVIDER_BACK_ON('Ollama') }))
    await waitFor(() => expect(ProvidersAPI.update).toHaveBeenCalledWith(PROVIDER_ID, { enabled: true }))
  })

  it('"Add a model to this app" scrolls to the This app card', async () => {
    const target = document.createElement('div')
    target.id = THIS_APP_SECTION_ID
    target.scrollIntoView = vi.fn()
    document.body.appendChild(target)
    renderBlock()
    const cull = await row('culling_profile')
    fireEvent.click(within(cull).getByRole('button', { name: STAGE_ADD_MODEL }))
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1)
    target.remove()
  })

  it('lists system_one providers in the endpoint select with parked called out', async () => {
    systemOneProviders = [
      { id: PROVIDER_ID, name: 'Ollama', url: OLLAMA, enabled: true, has_key: true },
      { id: 'studio', name: 'Studio', url: 'http://studio:8000', enabled: false, has_key: true },
    ]
    stages = { ...stages, system_one_providers: systemOneProviders }
    renderBlock()
    const cull = await row('culling_profile')
    expect(within(cull).getByRole('option', { name: STAGE_ENDPOINT_THIS_APP })).toBeInTheDocument()
    expect(within(cull).getByRole('option', { name: `Studio (http://studio:8000) ${STAGE_ENDPOINT_PARKED}` })).toBeInTheDocument()
    expect(within(cull).getByRole('link', { name: STAGE_PROVIDERS_LINK })).toHaveAttribute(
      'href',
      PROCESSING_PROVIDERS_SYSTEM_ONE_ROUTE,
    )
  })

  it('Later dismisses the model-change offer without queueing a job', async () => {
    renderBlock()
    const cull = await row('culling_profile')
    await waitFor(() => expect(within(cull).getByRole('option', { name: 'culling-model' })).toBeInTheDocument())
    fireEvent.change(control(cull, 'Model'), { target: { value: 'culling-model' } })
    fireEvent.click(await within(cull).findByRole('button', { name: MODEL_CHANGE_LATER }))
    expect(within(cull).queryByRole('button', { name: MODEL_CHANGE_PROCESS })).not.toBeInTheDocument()
    expect(JobsAPI.create).not.toHaveBeenCalled()
  })
})
