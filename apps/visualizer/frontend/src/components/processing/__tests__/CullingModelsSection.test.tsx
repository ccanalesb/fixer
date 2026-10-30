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
  CULLING_CHANGE_IN_PROVIDERS,
  CULLING_FIX_IN_PROVIDERS_LINK,
  PROCESSING_PROVIDERS_STAGE_ROUTE,
  STAGE_NO_QUESTIONS,
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
  provider_name: null,
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

describe('CullingModelsSection — settings model summary', () => {
  const profileRow = () => document.querySelector('[data-stage="culling_profile"]') as HTMLElement

  it('links to Providers for the model and when it cannot run', async () => {
    pipeline()
    stages.culling_profile = stage({ model: 'culling-model' })
    renderSection()
    await screen.findByRole('checkbox', { name: CULLING_PROFILE_STAGE })
    expect(profileRow()).toBeTruthy()
    expect(
      within(profileRow()).getByRole('link', { name: CULLING_CHANGE_IN_PROVIDERS }),
    ).toHaveAttribute('href', PROCESSING_PROVIDERS_STAGE_ROUTE('culling_profile'))
  })

  it('shows the short not-ready line when the stage is on but the model cannot run', async () => {
    pipeline()
    systemOneProviders = [{ id: PROVIDER_ID, name: 'Ollama', url: OLLAMA, enabled: false, has_key: true }]
    stages = {
      ...stages,
      system_one_providers: systemOneProviders,
      culling_profile: stage({ endpoint: PROVIDER_ID, model: 'clef-flash' }),
    }
    renderSection()
    await screen.findByRole('checkbox', { name: CULLING_PROFILE_STAGE })
    expect(await within(profileRow()).findByText(/Its model isn't ready/)).toBeInTheDocument()
    expect(within(profileRow()).getByRole('link', { name: CULLING_FIX_IN_PROVIDERS_LINK })).toHaveAttribute(
      'href',
      PROCESSING_PROVIDERS_STAGE_ROUTE('culling_profile'),
    )
  })
})

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


describe('CullingModelsSection — Score forecast questions', () => {
  beforeEach(() => {
    stages = { ...stages, score_forecast: stage({ model: 'forecast-model' }) }
  })

  it('with the Score forecast on and no questions: says so, explains it, and offers both ways to create them', async () => {
    questionCount = 0
    renderSection()
    expect(await screen.findByText(SCORE_FORECAST_HOW_TITLE)).toBeInTheDocument()
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
