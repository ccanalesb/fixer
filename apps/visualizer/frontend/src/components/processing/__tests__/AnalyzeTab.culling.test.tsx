import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Suspense } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

import { deleteMatching } from '../../../data/cache'
import { AnalyzeTab } from '../AnalyzeTab'
import type { CullingModelsUsable, CullingStageUsability } from '../../../services/api'
import {
  ADVANCED_OPTIONS_TITLE,
  ANALYZE_ADVANCED_CULL_ONLY,
  ANALYZE_ADVANCED_DESCRIBE_ONLY,
  ANALYZE_ADVANCED_SCORE_ONLY,
  CULLING_CHECKING,
  CULLING_FIX_IN_PROVIDERS,
  PROCESSING_PROVIDERS_STAGE_ROUTE,
  STAGE_DIALOG_TURN_BACK_ON,
} from '../../../constants/strings'

vi.mock('../../../stores/analyzeOptionsContext', () => ({
  useAnalyzeOptions: () => ({ options: { maxWorkers: 4 }, updateOption: vi.fn() }),
}))
vi.mock('../../ui/ProviderModelSelect', () => ({ ProviderModelSelect: () => null }))
vi.mock('../../ui/WorkerSlider', () => ({ WorkerSlider: () => null }))

const mockCreate = vi.fn()
const mockUsable = vi.fn()
const mockSaveSwitches = vi.fn()
const mockSaveForecast = vi.fn()
const mockProviderUpdate = vi.fn()

vi.mock('../../../services/api', () => ({
  JobsAPI: { create: (...a: unknown[]) => mockCreate(...a) },
  PerspectivesAPI: { list: () => Promise.resolve([{ slug: 'street', display_name: 'Street' }]) },
  ProvidersAPI: {
    getDefaults: () => Promise.resolve({ description: { provider: 'ollama', model: 'llava' } }),
    update: (...a: unknown[]) => mockProviderUpdate(...a),
  },
  CullingModelsAPI: { usable: () => mockUsable() },
  CullingProfilesAPI: {
    saveCullingProfileSwitches: (b: unknown) => mockSaveSwitches(b),
    saveScoreForecast: (b: unknown) => mockSaveForecast(b),
  },
}))

const ok = (model: string): CullingStageUsability => ({
  on: true,
  problem: null,
  model,
  endpoint: 'this_app',
  job_id: null,
  provider_name: null,
})
const broken = (problem: CullingStageUsability['problem'], extra: Partial<CullingStageUsability> = {}) => ({
  ...ok('model-x'),
  problem,
  ...extra,
})
const usable = (u: Partial<CullingModelsUsable> = {}): CullingModelsUsable => ({
  culling_profile: ok('culling-model'),
  score_forecast: ok('forecast-model'),
  culling_profile_filter: true,
  ...u,
})

function renderTab() {
  return render(
    <MemoryRouter>
      <Suspense fallback={null}>
        <AnalyzeTab />
      </Suspense>
    </MemoryRouter>,
  )
}

async function start() {
  renderTab()
  await screen.findByText(/Street/)
  fireEvent.click(screen.getByRole('button', { name: /^Analyze/i }))
}

describe('AnalyzeTab: a culling stage that is on but cannot run', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    mockCreate.mockReset().mockResolvedValue({ id: 'job-1', type: 'batch_analyze' })
    mockUsable.mockReset()
    mockSaveSwitches.mockReset().mockResolvedValue({ version: 2, redecide_job_id: null })
    mockSaveForecast.mockReset().mockResolvedValue({ version: 2, redecide_job_id: null })
    mockProviderUpdate.mockReset().mockResolvedValue({ provider: {} })
  })

  it('starts the job when every stage that is on can run', async () => {
    mockUsable.mockResolvedValue(usable())
    await start()
    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith('batch_analyze', expect.any(Object)))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('says it is checking while the backend is asked', async () => {
    let answer: (u: CullingModelsUsable) => void = () => {}
    mockUsable.mockReturnValue(new Promise((r) => (answer = r)))
    await start()
    const button = await screen.findByRole('button', { name: CULLING_CHECKING })
    expect(button).toBeDisabled()
    answer(usable())
    await waitFor(() => expect(mockCreate).toHaveBeenCalled())
  })

  it('opens the dialog instead of queuing the job, and Cancel queues nothing', async () => {
    mockUsable.mockResolvedValue(usable({ culling_profile: broken('no_model', { model: null }) }))
    await start()
    const dialog = await screen.findByRole('dialog', { name: 'Culling profile has no model' })
    expect(
      within(dialog).getByText(
        'This job runs the culling profile before the big model. Fix it, or turn the culling profile off and start without it. Without it, no stars or reject are given.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockSaveSwitches).not.toHaveBeenCalled()
  })

  it('"Turn off and start" saves the switch and queues the job in one action', async () => {
    mockUsable.mockResolvedValue(usable({ culling_profile: broken('removed') }))
    await start()
    const dialog = await screen.findByRole('dialog', { name: 'Its endpoint was removed' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off and start' }))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith('batch_analyze', expect.any(Object)))
    expect(mockSaveSwitches).toHaveBeenCalledWith({ enabled: false })
    expect(mockSaveSwitches.mock.invocationCallOrder[0]).toBeLessThan(mockCreate.mock.invocationCallOrder[0]!)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('a parked provider offers Turn it back on and then starts the job', async () => {
    mockUsable.mockResolvedValueOnce(
      usable({
        culling_profile: broken('parked', { endpoint: 'studio_gpu', provider_name: 'Studio GPU' }),
      }),
    )
    mockUsable.mockResolvedValueOnce(usable())
    await start()
    const dialog = await screen.findByRole('dialog', { name: 'Studio GPU is parked' })
    fireEvent.click(within(dialog).getByRole('button', { name: STAGE_DIALOG_TURN_BACK_ON }))
    await waitFor(() => expect(mockProviderUpdate).toHaveBeenCalledWith('studio_gpu', { enabled: true }))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith('batch_analyze', expect.any(Object)))
  })

  it('with both stages unusable, asks about the culling profile first, then the Score forecast', async () => {
    mockUsable.mockResolvedValue(
      usable({ culling_profile: broken('no_model', { model: null }), score_forecast: broken('no_questions', { model: 'forecast-model' }) }),
    )
    await start()
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Culling profile has no model' })).getByRole('button', {
        name: 'Turn off and start',
      }),
    )
    const second = await screen.findByRole('dialog', { name: 'Score forecast has no questions' })
    expect(
      within(second).getByText(
        'This job runs the Score forecast before the big model. Fix it, or turn the Score forecast off and start without it. Without it, every photo in the range goes to the big model.',
      ),
    ).toBeInTheDocument()
    expect(within(second).getByRole('link', { name: 'Create questions' })).toHaveAttribute(
      'href',
      '/processing?tab=settings#stage-score_forecast',
    )
    expect(mockCreate).not.toHaveBeenCalled()
    fireEvent.click(within(second).getByRole('button', { name: 'Turn off and start' }))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    expect(mockSaveSwitches).toHaveBeenCalledWith({ enabled: false })
    expect(mockSaveForecast).toHaveBeenCalledWith({ enabled: false })
  })

  it.each([
    ['no_model', 'Culling profile has no model', CULLING_FIX_IN_PROVIDERS],
    ['converting', "Culling profile's model is still converting", 'View job'],
    ['removed', 'Its endpoint was removed', CULLING_FIX_IN_PROVIDERS],
    ['parked', 'Studio GPU is parked', STAGE_DIALOG_TURN_BACK_ON],
  ] as const)('%s: the dialog says "%s" and offers %s', async (problem, title, fix) => {
    mockUsable.mockResolvedValue(
      usable({
        culling_profile: broken(problem, {
          job_id: problem === 'converting' ? 'install-1' : null,
          endpoint: problem === 'parked' ? 'studio_gpu' : 'this_app',
          provider_name: problem === 'parked' ? 'Studio GPU' : null,
        }),
      }),
    )
    await start()
    const dialog = await screen.findByRole('dialog', { name: title })
    if (fix === STAGE_DIALOG_TURN_BACK_ON) {
      expect(within(dialog).getByRole('button', { name: fix })).toBeInTheDocument()
    } else {
      expect(within(dialog).getByRole('link', { name: fix })).toHaveAttribute(
        'href',
        fix === 'View job' ? '/processing?tab=jobs' : PROCESSING_PROVIDERS_STAGE_ROUTE('culling_profile'),
      )
    }
  })

  it('with the Score forecast off, turning the culling profile off sends every photo to the big model', async () => {
    mockUsable.mockResolvedValue(
      usable({ culling_profile: broken('no_model'), score_forecast: { ...ok('forecast-model'), on: false } }),
    )
    await start()
    expect(
      await screen.findByText(
        'This job runs the culling profile before the big model. Fix it, or turn the culling profile off and start without it. Without it, every photo in the range goes to the big model and no stars or reject are given.',
      ),
    ).toBeInTheDocument()
  })

  it("with the culling profile's filter on, turning the Score forecast off leaves its rule to decide", async () => {
    mockUsable.mockResolvedValue(usable({ score_forecast: broken('no_model') }))
    await start()
    expect(
      await screen.findByText(
        "This job runs the Score forecast before the big model. Fix it, or turn the Score forecast off and start without it. Without it, the culling profile's rule decides what goes to the big model.",
      ),
    ).toBeInTheDocument()
  })

  it('describe only and score only ask first too', async () => {
    mockUsable.mockResolvedValue(usable({ score_forecast: broken('no_model') }))
    renderTab()
    await screen.findByText(/Street/)
    fireEvent.click(screen.getByText(ADVANCED_OPTIONS_TITLE))
    fireEvent.click(screen.getByRole('button', { name: ANALYZE_ADVANCED_DESCRIBE_ONLY }))
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Score forecast has no model' })).getByRole('button', {
        name: 'Cancel',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: ANALYZE_ADVANCED_SCORE_ONLY }))
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Score forecast has no model' })).getByRole('button', {
        name: 'Turn off and start',
      }),
    )
    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith('batch_score', expect.any(Object)))
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('culling only queues the culling job with no options', async () => {
    mockUsable.mockResolvedValue(usable())
    renderTab()
    await screen.findByText(/Street/)
    fireEvent.click(screen.getByText(ADVANCED_OPTIONS_TITLE))
    fireEvent.click(screen.getByRole('button', { name: ANALYZE_ADVANCED_CULL_ONLY }))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith('batch_cull_photos_before_scoring', {}))
  })
})
