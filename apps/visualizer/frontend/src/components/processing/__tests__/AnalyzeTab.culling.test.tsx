import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Suspense } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

import { deleteMatching } from '../../../data/cache'
import { AnalyzeTab } from '../AnalyzeTab'
import type { CullingModelsUsable, CullingStageUsability } from '../../../services/api'
import { CULLING_JOB_TYPE } from '../../../services/api'
import { ANALYZE_ADVANCED_CULL_ONLY, ADVANCED_OPTIONS_TITLE } from '../../../constants/strings'

vi.mock('../../../stores/analyzeOptionsContext', () => ({
  useAnalyzeOptions: () => ({ options: { maxWorkers: 4 }, updateOption: vi.fn() }),
}))
vi.mock('../../ui/ProviderModelSelect', () => ({ ProviderModelSelect: () => null }))
vi.mock('../../ui/WorkerSlider', () => ({ WorkerSlider: () => null }))

const mockCreate = vi.fn()
const mockUsable = vi.fn()

vi.mock('../../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/api')>()
  return {
    ...actual,
    JobsAPI: { create: (...a: unknown[]) => mockCreate(...a) },
    PerspectivesAPI: { list: () => Promise.resolve([{ slug: 'street', display_name: 'Street' }]) },
    ProvidersAPI: {
      getDefaults: () => Promise.resolve({ description: { provider: 'ollama', model: 'llava' } }),
    },
    CullingModelsAPI: { usable: () => mockUsable() },
    CullingProfilesAPI: {
      saveCullingProfileSwitches: vi.fn().mockResolvedValue({ version: 2, redecide_job_id: null }),
      saveScoreForecast: vi.fn().mockResolvedValue({ version: 2, redecide_job_id: null }),
    },
  }
})

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

describe('AnalyzeTab: culling gate', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    mockCreate.mockReset().mockResolvedValue({ id: 'job-1', type: 'batch_analyze' })
    mockUsable.mockReset()
  })

  it('starts the job when every stage that is on can run', async () => {
    mockUsable.mockResolvedValue(usable())
    renderTab()
    await screen.findByText(/Street/)
    fireEvent.click(screen.getByRole('button', { name: /^Analyze/i }))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith('batch_analyze', expect.any(Object)))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens the dialog instead of queuing when a stage that is on cannot run', async () => {
    mockUsable.mockResolvedValue(usable({ culling_profile: broken('no_model', { model: null }) }))
    renderTab()
    await screen.findByText(/Street/)
    fireEvent.click(screen.getByRole('button', { name: /^Analyze/i }))
    const dialog = await screen.findByRole('dialog', { name: 'Culling profile has no model' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('culling only queues the culling job with no options', async () => {
    mockUsable.mockResolvedValue(usable())
    renderTab()
    await screen.findByText(/Street/)
    fireEvent.click(screen.getByText(ADVANCED_OPTIONS_TITLE))
    fireEvent.click(screen.getByRole('button', { name: ANALYZE_ADVANCED_CULL_ONLY }))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith(CULLING_JOB_TYPE, {}))
  })
})
