import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CullingModelsSection } from '../CullingModelsSection'
import {
  AppModelsAPI,
  CullingModelsAPI,
  CullingProfilesAPI,
  JobsAPI,
  ScoreForecastQuestionsAPI,
  type AppModel,
  type CullingModelsResponse,
  type CullingModelsUsable,
  type CullingStageModel,
  type CullingStageUsability,
  type CullingSystemOneProvider,
  type PipelineSettingResponse,
  type ScoreForecastQuestion,
} from '../../../services/api'
import {
  CULLING_MODELS_SAVED,
  CULLING_MODELS_SAVED_JOB_WAITING,
  CULLING_MODELS_VIEW_QUEUE,
  CULLING_PROFILE_FILTER,
  CULLING_PROFILE_FILTER_UNAVAILABLE,
  CULLING_PROFILE_STAGE,
  MODEL_CHANGE_LATER,
  MODEL_CHANGE_PROCESS,
  PROCESSING_JOB_QUEUE_ROUTE,
  SCORE_FORECAST_CREATE_FROM_PERSPECTIVES,
  SCORE_FORECAST_EDIT_QUESTIONS,
  SCORE_FORECAST_HOW_TITLE,
  SCORE_FORECAST_NO_QUESTIONS_HOW,
  SCORE_FORECAST_QUESTION_COUNT,
  SCORE_FORECAST_QUESTIONS_ROUTE,
  SCORE_FORECAST_SKIPPED,
  SCORE_FORECAST_WRITE_THEM,
  SCORE_FORECAST_LEVEL,
  SCORE_FORECAST_STAGE,
  SCORE_FORECAST_THRESHOLD,
  SCORE_FORECAST_THRESHOLD_INVALID,
  PROCESSING_PROVIDERS_SYSTEM_ONE_ROUTE,
  STAGE_ADD_MODEL,
  STAGE_ENDPOINT_PARKED,
  STAGE_ENDPOINT_THIS_APP,
  STAGE_NO_QUESTIONS,
  STAGE_PROVIDERS_LINK,
} from '../../../constants/strings'
import type { Job } from '../../../types/job'

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
/** Models typed into each System One provider id. */
let providerModels: Record<string, string[]>
let systemOneProviders: CullingSystemOneProvider[]

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

const saved = { version: 2, redecide_job_id: 'job-9' }
const usableStage = (over: Partial<CullingStageUsability> = {}): CullingStageUsability => ({
  on: true,
  problem: null,
  model: 'culling-model',
  endpoint: 'this_app',
  job_id: null,
  detail: null,
  ...over,
})
/** What `GET /api/culling-models/usable` answers. */
let usable: CullingModelsUsable
/** How many Score forecast questions the library has. */
let questionCount: number
const question = (id: string): ScoreForecastQuestion => ({
  id,
  name: id,
  perspective_slug: id,
  instructions: `How ${id}?`,
  levels: Array.from({ length: 10 }, (_, i) => `level ${i + 1}`),
  optional: false,
  applies: null,
})
const questionsResponse = () => ({
  questions: Array.from({ length: questionCount }, (_, i) => question(`q${i}`)),
  version: questionCount ? 1 : 0,
  perspectives: [],
})

beforeEach(() => {
  vi.restoreAllMocks()
  socket.onJobUpdated = null
  pipeline()
  usable = { culling_profile: usableStage(), score_forecast: usableStage({ model: 'forecast-model' }), culling_profile_filter: true }
  systemOneProviders = [
    { id: PROVIDER_ID, name: 'Ollama', url: OLLAMA, enabled: true, has_key: true },
  ]
  providerModels = { [PROVIDER_ID]: ['intern-decision-2b', 'clef-flash'] }
  stages = {
    culling_profile: stage(),
    score_forecast: stage(),
    total_photos: 3,
    system_one_providers: systemOneProviders,
  }
  appModels = [ready('culling-model'), ready('forecast-model')]
  questionCount = 4
  vi.spyOn(ScoreForecastQuestionsAPI, 'get').mockImplementation(async () => questionsResponse())
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
    return listed
      ? { answers: true, models: listed, error: null }
      : { answers: false, models: [], error: 'Unknown provider' }
  })
  vi.spyOn(AppModelsAPI, 'list').mockImplementation(async () => ({ models: appModels, picker_available: true }))
  vi.spyOn(JobsAPI, 'create').mockResolvedValue({ id: 'job-cull' } as Job)
  vi.spyOn(CullingModelsAPI, 'usable').mockImplementation(async () => usable)
  vi.spyOn(CullingProfilesAPI, 'getPipeline').mockImplementation(async () => ({ version: 1, config: stored }))
  vi.spyOn(CullingProfilesAPI, 'saveCullingProfileSwitches').mockImplementation(async (body) => {
    if (body.enabled !== undefined) stored = { ...stored, culling_profiles_enabled: body.enabled }
    if (body.filter_enabled !== undefined) stored = { ...stored, culling_profiles_filter_enabled: body.filter_enabled }
    return saved
  })
  vi.spyOn(CullingProfilesAPI, 'saveScoreForecast').mockImplementation(async (body) => {
    stored = { ...stored, score_forecast: { ...stored.score_forecast, ...body } }
    return saved
  })
})

function renderSection() {
  return render(
    <MemoryRouter>
      <CullingModelsSection />
    </MemoryRouter>,
  )
}

const stageSwitch = (name: string) => screen.findByRole('checkbox', { name })

async function expectQueued() {
  expect(await screen.findByText(CULLING_MODELS_SAVED, { exact: false })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: CULLING_MODELS_VIEW_QUEUE })).toHaveAttribute('href', PROCESSING_JOB_QUEUE_ROUTE)
}

describe('CullingModelsSection', () => {
  it('shows each stage with its switch as the pipeline setting has it', async () => {
    pipeline({ culling_profiles_filter_enabled: false }, { enabled: false })
    renderSection()
    expect(await stageSwitch(CULLING_PROFILE_STAGE)).toBeChecked()
    expect(screen.getByRole('checkbox', { name: CULLING_PROFILE_FILTER })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: SCORE_FORECAST_STAGE })).not.toBeChecked()
  })

  it('the culling profile switch saves once and says the re-decide job is queued', async () => {
    renderSection()
    fireEvent.click(await stageSwitch(CULLING_PROFILE_STAGE))
    await expectQueued()
    expect(CullingProfilesAPI.saveCullingProfileSwitches).toHaveBeenCalledTimes(1)
    expect(CullingProfilesAPI.saveCullingProfileSwitches).toHaveBeenCalledWith({ enabled: false })
    expect(screen.getByRole('checkbox', { name: CULLING_PROFILE_STAGE })).not.toBeChecked()
  })

  it('the filter switch saves once', async () => {
    renderSection()
    fireEvent.click(await stageSwitch(CULLING_PROFILE_FILTER))
    await expectQueued()
    expect(CullingProfilesAPI.saveCullingProfileSwitches).toHaveBeenCalledTimes(1)
    expect(CullingProfilesAPI.saveCullingProfileSwitches).toHaveBeenCalledWith({ filter_enabled: false })
    expect(screen.getByRole('checkbox', { name: CULLING_PROFILE_FILTER })).not.toBeChecked()
  })

  it('the filter switch cannot be changed while the culling profile is off, and keeps its value', async () => {
    pipeline({ culling_profiles_enabled: false, culling_profiles_filter_enabled: true })
    renderSection()
    const filter = await stageSwitch(CULLING_PROFILE_FILTER)
    expect(filter).toBeDisabled()
    expect(filter).toBeChecked()
    expect(screen.getByText(CULLING_PROFILE_FILTER_UNAVAILABLE)).toBeInTheDocument()
  })

  it('the Score forecast switch saves once; level and threshold show only while it is on', async () => {
    renderSection()
    expect(await screen.findByRole('combobox', { name: SCORE_FORECAST_LEVEL })).toHaveValue('8')
    expect(screen.getByRole('textbox', { name: SCORE_FORECAST_THRESHOLD })).toHaveValue('0.111')
    fireEvent.click(screen.getByRole('checkbox', { name: SCORE_FORECAST_STAGE }))
    await expectQueued()
    expect(CullingProfilesAPI.saveScoreForecast).toHaveBeenCalledTimes(1)
    expect(CullingProfilesAPI.saveScoreForecast).toHaveBeenCalledWith({ enabled: false })
    expect(screen.queryByRole('combobox', { name: SCORE_FORECAST_LEVEL })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: SCORE_FORECAST_THRESHOLD })).not.toBeInTheDocument()
  })

  it('the level saves as soon as it changes', async () => {
    renderSection()
    fireEvent.change(await screen.findByRole('combobox', { name: SCORE_FORECAST_LEVEL }), { target: { value: '7' } })
    await expectQueued()
    expect(CullingProfilesAPI.saveScoreForecast).toHaveBeenCalledTimes(1)
    expect(CullingProfilesAPI.saveScoreForecast).toHaveBeenCalledWith({ high_from_level: 7 })
    expect(screen.getByRole('combobox', { name: SCORE_FORECAST_LEVEL })).toHaveValue('7')
  })

  it('the threshold shows Save only when it differs, and saves once', async () => {
    renderSection()
    const input = await screen.findByRole('textbox', { name: SCORE_FORECAST_THRESHOLD })
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    fireEvent.change(input, { target: { value: '0.2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await expectQueued()
    expect(CullingProfilesAPI.saveScoreForecast).toHaveBeenCalledTimes(1)
    expect(CullingProfilesAPI.saveScoreForecast).toHaveBeenCalledWith({ threshold: 0.2 })
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it('Enter saves the threshold too', async () => {
    renderSection()
    const input = await screen.findByRole('textbox', { name: SCORE_FORECAST_THRESHOLD })
    fireEvent.change(input, { target: { value: '0.05' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await expectQueued()
    expect(CullingProfilesAPI.saveScoreForecast).toHaveBeenCalledWith({ threshold: 0.05 })
  })

  it('only a number from 0 to 1 can be saved as the threshold; Cancel goes back to the saved one', async () => {
    renderSection()
    const input = await screen.findByRole('textbox', { name: SCORE_FORECAST_THRESHOLD })
    for (const bad of ['1.5', '-0.1', 'abc']) {
      fireEvent.change(input, { target: { value: bad } })
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
      expect(screen.getByText(SCORE_FORECAST_THRESHOLD_INVALID)).toBeInTheDocument()
      fireEvent.keyDown(input, { key: 'Enter' })
    }
    expect(CullingProfilesAPI.saveScoreForecast).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(input).toHaveValue('0.111')
  })

  it('a save while a re-decide job is still waiting says that job applies it', async () => {
    vi.mocked(CullingProfilesAPI.saveScoreForecast).mockResolvedValue({ version: 3, redecide_job_id: null })
    renderSection()
    fireEvent.change(await screen.findByRole('combobox', { name: SCORE_FORECAST_LEVEL }), { target: { value: '7' } })
    expect(await screen.findByText(CULLING_MODELS_SAVED_JOB_WAITING, { exact: false })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: CULLING_MODELS_VIEW_QUEUE })).toHaveAttribute('href', PROCESSING_JOB_QUEUE_ROUTE)
  })

  it('a failed save says so and shows the setting as stored', async () => {
    vi.mocked(CullingProfilesAPI.saveCullingProfileSwitches).mockRejectedValue(new Error('library.db is busy'))
    renderSection()
    fireEvent.click(await stageSwitch(CULLING_PROFILE_STAGE))
    expect(await screen.findByText('library.db is busy')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('checkbox', { name: CULLING_PROFILE_STAGE })).toBeChecked())
  })
})

describe('CullingModelsSection — endpoint and model per stage', () => {
  const row = async (k: Stage) => {
    await screen.findByRole('checkbox', { name: CULLING_PROFILE_STAGE })
    return document.querySelector(`[data-stage="${k}"]`) as HTMLElement
  }
  const control = (r: HTMLElement, role: 'combobox' | 'textbox', name: string) => within(r).getByRole(role, { name })
  const desc = (r: HTMLElement) => r.querySelector('[data-stage-description]')!.textContent

  it('a new install: this app, no model; a stage that is on says jobs won’t start, one that is off says Off', async () => {
    pipeline({}, { enabled: false })
    renderSection()
    const cull = await row('culling_profile')
    expect(control(cull, 'combobox', 'Endpoint')).toHaveValue('this_app')
    await waitFor(() => expect(within(cull).getByRole('option', { name: 'culling-model' })).toBeInTheDocument())
    expect(control(cull, 'combobox', 'Model')).toHaveValue('')
    expect(desc(cull)).toBe("No model chosen — jobs won't start until you choose one or turn the culling profile off")
    expect(desc(await row('score_forecast'))).toBe('Off')
  })

  it('lists the models in this app, a converting one disabled, and says which model a stage runs', async () => {
    appModels = [ready('culling-model'), { ...ready('my-run-best'), status: 'converting', job_id: 'job-2' }]
    stages.culling_profile = stage({ model: 'culling-model' })
    stages.score_forecast = stage({ model: 'my-run-best' })
    renderSection()
    const cull = await row('culling_profile')
    await waitFor(() => expect(desc(cull)).toBe('culling-model on this app'))
    const forecast = await row('score_forecast')
    expect(within(forecast).getByRole('option', { name: 'my-run-best (converting)' })).toBeDisabled()
    expect(desc(forecast)).toBe('my-run-best on this app — still converting · View job')
    expect(within(forecast).getByRole('link', { name: 'View job' })).toHaveAttribute('href', PROCESSING_JOB_QUEUE_ROUTE)
  })

  it('choosing a model saves it once and offers to process the photos the previous model answered', async () => {
    stages.culling_profile = stage({ model: 'culling-model', answered: { photos: 45793, model: 'culling-model' } })
    appModels = [ready('culling-model'), ready('my-run-best')]
    renderSection()
    const cull = await row('culling_profile')
    await waitFor(() => expect(within(cull).getByRole('option', { name: 'my-run-best' })).toBeInTheDocument())
    fireEvent.change(control(cull, 'combobox', 'Model'), { target: { value: 'my-run-best' } })
    expect(await within(cull).findByText('Culling profile now uses my-run-best.')).toBeInTheDocument()
    expect(CullingModelsAPI.save).toHaveBeenCalledTimes(1)
    expect(CullingModelsAPI.save).toHaveBeenCalledWith('culling_profile', { model: 'my-run-best' })
    expect(
      within(cull).getByText(
        '45,793 photos were answered by culling-model. Process them with my-run-best in a background job? Until then their verdicts stay as they are; earlier answers are kept.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(within(cull).getByRole('button', { name: MODEL_CHANGE_PROCESS }))
    fireEvent.click(within(cull).getByRole('button', { name: MODEL_CHANGE_PROCESS }))
    expect(await within(cull).findByText('Job queued ·', { exact: false })).toBeInTheDocument()
    expect(within(cull).getByRole('link', { name: CULLING_MODELS_VIEW_QUEUE })).toHaveAttribute('href', PROCESSING_JOB_QUEUE_ROUTE)
    expect(JobsAPI.create).toHaveBeenCalledTimes(1)
    expect(JobsAPI.create).toHaveBeenCalledWith('batch_cull_photos_before_scoring', {})
    expect(within(cull).queryByRole('button', { name: MODEL_CHANGE_PROCESS })).not.toBeInTheDocument()
  })

  it('Process photos asks first while the other stage cannot run, and can turn it off and start', async () => {
    stages.culling_profile = stage({ model: 'culling-model', answered: { photos: 45793, model: 'culling-model' } })
    appModels = [ready('culling-model'), ready('my-run-best')]
    usable = { ...usable, score_forecast: usableStage({ model: null, problem: 'no_model' }) }
    renderSection()
    const cull = await row('culling_profile')
    await waitFor(() => expect(within(cull).getByRole('option', { name: 'my-run-best' })).toBeInTheDocument())
    fireEvent.change(control(cull, 'combobox', 'Model'), { target: { value: 'my-run-best' } })
    fireEvent.click(await within(cull).findByRole('button', { name: MODEL_CHANGE_PROCESS }))
    const dialog = await screen.findByRole('dialog', { name: 'Score forecast has no model' })
    expect(
      within(dialog).getByText(
        "This job runs the Score forecast. Fix it, or turn the Score forecast off and start without it. Without it, the culling profile's rule decides what goes to the big model.",
      ),
    ).toBeInTheDocument()
    expect(JobsAPI.create).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off and start' }))
    expect(await within(cull).findByText('Job queued ·', { exact: false })).toBeInTheDocument()
    expect(CullingProfilesAPI.saveScoreForecast).toHaveBeenCalledWith({ enabled: false })
    expect(JobsAPI.create).toHaveBeenCalledWith('batch_cull_photos_before_scoring', {})
    expect(await stageSwitch(SCORE_FORECAST_STAGE)).not.toBeChecked()
  })

  it('arriving from "Open Settings" scrolls to that stage’s row', async () => {
    const scrolled: string[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id)
    }
    try {
      render(
        <MemoryRouter initialEntries={['/processing?tab=settings#stage-score_forecast']}>
          <CullingModelsSection />
        </MemoryRouter>,
      )
      await waitFor(() => expect(scrolled).toEqual(['stage-score_forecast']))
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it('with nothing answered yet the note says so; Later dismisses it', async () => {
    renderSection()
    const cull = await row('culling_profile')
    await waitFor(() => expect(within(cull).getByRole('option', { name: 'culling-model' })).toBeInTheDocument())
    fireEvent.change(control(cull, 'combobox', 'Model'), { target: { value: 'culling-model' } })
    expect(
      await within(cull).findByText('No photo has been answered by the culling profile yet. Process the 3 photos in a background job?'),
    ).toBeInTheDocument()
    fireEvent.click(within(cull).getByRole('button', { name: MODEL_CHANGE_LATER }))
    expect(within(cull).queryByRole('button', { name: MODEL_CHANGE_PROCESS })).not.toBeInTheDocument()
    expect(JobsAPI.create).not.toHaveBeenCalled()
  })

  it('a stage that is off saves the model but offers no processing', async () => {
    pipeline({}, { enabled: false })
    renderSection()
    const forecast = await row('score_forecast')
    await waitFor(() => expect(within(forecast).getByRole('option', { name: 'forecast-model' })).toBeInTheDocument())
    fireEvent.change(control(forecast, 'combobox', 'Model'), { target: { value: 'forecast-model' } })
    await waitFor(() => expect(desc(forecast)).toBe('Off · forecast-model on this app'))
    expect(within(forecast).queryByRole('button', { name: MODEL_CHANGE_PROCESS })).not.toBeInTheDocument()
  })

  it('a conversion job finishing for the model a stage runs offers to process the photos', async () => {
    appModels = [{ ...ready('culling-model'), status: 'converting', job_id: 'job-1' }]
    stages.culling_profile = stage({ model: 'culling-model' })
    renderSection()
    const cull = await row('culling_profile')
    await waitFor(() => expect(desc(cull)).toBe('culling-model on this app — still converting · View job'))
    appModels = [ready('culling-model')]
    socket.onJobUpdated?.({ id: 'job-1', type: 'app_model_install', status: 'completed' } as Job)
    expect(await within(cull).findByText('Culling profile now uses culling-model.')).toBeInTheDocument()
  })

  it('choosing a System One provider saves once and lists its typed models', async () => {
    renderSection()
    const cull = await row('culling_profile')
    fireEvent.change(control(cull, 'combobox', 'Endpoint'), { target: { value: PROVIDER_ID } })
    await waitFor(() => expect(CullingModelsAPI.save).toHaveBeenCalledWith('culling_profile', { endpoint: PROVIDER_ID }))
    await waitFor(() => expect(within(cull).getByRole('option', { name: 'clef-flash' })).toBeInTheDocument())
    expect(control(cull, 'combobox', 'Model')).not.toBeDisabled()
    fireEvent.change(control(cull, 'combobox', 'Model'), { target: { value: 'clef-flash' } })
    await waitFor(() => expect(desc(cull)).toBe(`clef-flash on Ollama (${OLLAMA})`))
  })

  it('a model no longer in the provider says so', async () => {
    stages.culling_profile = stage({ endpoint: PROVIDER_ID, model: 'gone-model' })
    renderSection()
    const cull = await row('culling_profile')
    await waitFor(() =>
      expect(desc(cull)).toBe(`gone-model is no longer listed by Ollama (${OLLAMA}) — jobs won't start`),
    )
    expect(CullingModelsAPI.models).toHaveBeenCalledWith('culling_profile')
  })

  it('going back to this app saves at once and clears the model', async () => {
    stages.culling_profile = stage({ endpoint: PROVIDER_ID, model: 'clef-flash' })
    renderSection()
    const cull = await row('culling_profile')
    fireEvent.change(control(cull, 'combobox', 'Endpoint'), { target: { value: 'this_app' } })
    await waitFor(() => expect(CullingModelsAPI.save).toHaveBeenCalledWith('culling_profile', { endpoint: 'this_app' }))
    await waitFor(() =>
      expect(desc(cull)).toBe("No model chosen — jobs won't start until you choose one or turn the culling profile off"),
    )
  })

  it('"Add a model to this app" goes to Models in this app; a provider has no such link', async () => {
    const target = document.createElement('div')
    target.id = 'app-models'
    target.scrollIntoView = vi.fn()
    document.body.appendChild(target)
    renderSection()
    const cull = await row('culling_profile')
    fireEvent.click(within(cull).getByRole('button', { name: STAGE_ADD_MODEL }))
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1)
    fireEvent.change(control(cull, 'combobox', 'Endpoint'), { target: { value: PROVIDER_ID } })
    await waitFor(() => expect(within(cull).queryByRole('button', { name: STAGE_ADD_MODEL })).not.toBeInTheDocument())
    target.remove()
  })

  it('the endpoint select offers this app and each system_one provider, with parked called out', async () => {
    systemOneProviders = [
      { id: PROVIDER_ID, name: 'Ollama', url: OLLAMA, enabled: true, has_key: true },
      { id: 'studio', name: 'Studio', url: 'http://studio:8000', enabled: false, has_key: true },
    ]
    stages = { ...stages, system_one_providers: systemOneProviders }
    renderSection()
    const cull = await row('culling_profile')
    expect(within(cull).getByRole('option', { name: STAGE_ENDPOINT_THIS_APP })).toBeInTheDocument()
    expect(within(cull).getByRole('option', { name: `Ollama (${OLLAMA})` })).toBeInTheDocument()
    expect(within(cull).getByRole('option', { name: `Studio (http://studio:8000) ${STAGE_ENDPOINT_PARKED}` })).toBeInTheDocument()
    expect(within(cull).getByRole('link', { name: STAGE_PROVIDERS_LINK })).toHaveAttribute(
      'href',
      PROCESSING_PROVIDERS_SYSTEM_ONE_ROUTE,
    )
  })
})

describe('CullingModelsSection — Score forecast questions', () => {
  beforeEach(() => {
    stages = { ...stages, score_forecast: stage({ model: 'forecast-model' }) }
  })

  it('with the Score forecast on and no questions: says so, explains it, and offers both ways to create them', async () => {
    questionCount = 0
    renderSection()
    expect(await screen.findByText(STAGE_NO_QUESTIONS)).toHaveClass('text-error')
    expect(screen.getByText(SCORE_FORECAST_HOW_TITLE)).toBeInTheDocument()
    expect(screen.getByText(SCORE_FORECAST_NO_QUESTIONS_HOW)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: SCORE_FORECAST_CREATE_FROM_PERSPECTIVES })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: SCORE_FORECAST_WRITE_THEM })).toHaveAttribute('href', SCORE_FORECAST_QUESTIONS_ROUTE)
  })

  it('"Create questions from my perspectives" creates them once and links to where they are edited', async () => {
    questionCount = 0
    vi.spyOn(ScoreForecastQuestionsAPI, 'fromPerspectives').mockImplementation(async () => {
      questionCount = 5
      return { ...questionsResponse(), skipped: ['Street'] }
    })
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: SCORE_FORECAST_CREATE_FROM_PERSPECTIVES }))
    expect(await screen.findByText(SCORE_FORECAST_QUESTION_COUNT(5, true), { exact: false })).toBeInTheDocument()
    expect(ScoreForecastQuestionsAPI.fromPerspectives).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('link', { name: SCORE_FORECAST_EDIT_QUESTIONS })).toHaveAttribute(
      'href',
      SCORE_FORECAST_QUESTIONS_ROUTE,
    )
    expect(screen.getByText(SCORE_FORECAST_SKIPPED(['Street']))).toBeInTheDocument()
    expect(screen.queryByText(STAGE_NO_QUESTIONS)).not.toBeInTheDocument()
  })

  it('with questions: only how many there are, until the Score forecast is turned on', async () => {
    renderSection()
    expect(await screen.findByText(SCORE_FORECAST_QUESTION_COUNT(4, false), { exact: false })).toBeInTheDocument()
    expect(screen.queryByText(SCORE_FORECAST_HOW_TITLE)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: SCORE_FORECAST_STAGE }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: SCORE_FORECAST_STAGE })).not.toBeChecked())
    expect(screen.queryByText(SCORE_FORECAST_QUESTION_COUNT(4, false), { exact: false })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: SCORE_FORECAST_STAGE }))
    expect(await screen.findByText(SCORE_FORECAST_HOW_TITLE)).toBeInTheDocument()
    expect(screen.queryByText(SCORE_FORECAST_NO_QUESTIONS_HOW)).not.toBeInTheDocument()
  })
})
