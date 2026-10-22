import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CullingModelsSection } from '../CullingModelsSection'
import { CullingProfilesAPI, type PipelineSettingResponse } from '../../../services/api'
import {
  CULLING_MODELS_SAVED,
  CULLING_MODELS_SAVED_JOB_WAITING,
  CULLING_MODELS_VIEW_QUEUE,
  CULLING_PROFILE_FILTER,
  CULLING_PROFILE_FILTER_UNAVAILABLE,
  CULLING_PROFILE_STAGE,
  PROCESSING_JOB_QUEUE_ROUTE,
  SCORE_FORECAST_LEVEL,
  SCORE_FORECAST_STAGE,
  SCORE_FORECAST_THRESHOLD,
  SCORE_FORECAST_THRESHOLD_INVALID,
} from '../../../constants/strings'

type Config = PipelineSettingResponse['config']

let stored: Config

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

beforeEach(() => {
  vi.restoreAllMocks()
  pipeline()
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
