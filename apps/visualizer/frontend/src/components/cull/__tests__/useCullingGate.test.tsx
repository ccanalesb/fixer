import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import {
  CullingModelsAPI,
  CullingProfilesAPI,
  ProvidersAPI,
  type CullingModelsUsable,
  type CullingStageUsability,
} from '../../../services/api'
import { useCullingGate } from '../useCullingGate'
import { turnStageOff } from '../pipelineStageSwitch'

vi.mock('../pipelineStageSwitch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pipelineStageSwitch')>()
  return {
    ...actual,
    turnStageOff: vi.fn(actual.turnStageOff),
  }
})

const mockTurnStageOff = vi.mocked(turnStageOff)

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

function GateHarness({ onResult }: { onResult: (r: unknown) => void }) {
  const { run, dialog } = useCullingGate()
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void run('start', () => Promise.resolve('done')).then(onResult)
        }}
      >
        Go
      </button>
      {dialog}
    </>
  )
}

const renderGate = (ui: ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

describe('useCullingGate', () => {
  beforeEach(() => {
    mockTurnStageOff.mockReset()
    mockTurnStageOff.mockImplementation(async (stage) => {
      if (stage === 'culling_profile') {
        return CullingProfilesAPI.saveCullingProfileSwitches({ enabled: false })
      }
      return CullingProfilesAPI.saveScoreForecast({ enabled: false })
    })
    vi.spyOn(CullingProfilesAPI, 'saveCullingProfileSwitches').mockResolvedValue({ version: 2, redecide_job_id: null })
    vi.spyOn(CullingProfilesAPI, 'saveScoreForecast').mockResolvedValue({ version: 2, redecide_job_id: null })
    vi.spyOn(ProvidersAPI, 'update').mockResolvedValue({ provider: {} } as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['no_model', 'Culling profile has no model'],
    ['converting', "Culling profile's model is still converting"],
    ['removed', 'Its endpoint was removed'],
    ['parked', 'Studio GPU is parked'],
    ['no_questions', 'Score forecast has no questions'],
  ] as const)('%s opens the dialog with title "%s"', async (problem, title) => {
    const stage = problem === 'no_questions' ? 'score_forecast' : 'culling_profile'
    const patch =
      stage === 'culling_profile'
        ? { culling_profile: broken(problem, { model: problem === 'no_model' ? null : 'model-x', job_id: problem === 'converting' ? 'j' : null, endpoint: problem === 'parked' ? 'studio_gpu' : 'this_app', provider_name: problem === 'parked' ? 'Studio GPU' : null }) }
        : { score_forecast: broken(problem, { model: 'forecast-model' }) }
    vi.spyOn(CullingModelsAPI, 'usable').mockResolvedValue(usable(patch))
    const onResult = vi.fn()
    renderGate(<GateHarness onResult={onResult} />)
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(await screen.findByRole('dialog', { name: title })).toBeInTheDocument()
    expect(onResult).not.toHaveBeenCalled()
  })

  it('asks about the culling profile before the Score forecast', async () => {
    vi.spyOn(CullingModelsAPI, 'usable').mockResolvedValue(
      usable({
        culling_profile: broken('no_model', { model: null }),
        score_forecast: broken('no_questions', { model: 'forecast-model' }),
      }),
    )
    const onResult = vi.fn()
    renderGate(<GateHarness onResult={onResult} />)
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    const first = await screen.findByRole('dialog', { name: 'Culling profile has no model' })
    fireEvent.click(within(first).getByRole('button', { name: 'Turn off and start' }))
    expect(await screen.findByRole('dialog', { name: 'Score forecast has no questions' })).toBeInTheDocument()
    expect(onResult).not.toHaveBeenCalled()
  })

  it('turning a stage off then starts', async () => {
    vi.spyOn(CullingModelsAPI, 'usable').mockResolvedValue(usable({ score_forecast: broken('no_model') }))
    const onResult = vi.fn()
    renderGate(<GateHarness onResult={onResult} />)
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    const dialog = await screen.findByRole('dialog', { name: 'Score forecast has no model' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off and start' }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'started', value: 'done' }))
    expect(mockTurnStageOff).toHaveBeenCalledWith('score_forecast')
  })

  it('switching a parked provider back on then starts', async () => {
    vi.spyOn(CullingModelsAPI, 'usable')
      .mockResolvedValueOnce(
        usable({
          culling_profile: broken('parked', { endpoint: 'studio_gpu', provider_name: 'Studio GPU' }),
        }),
      )
      .mockResolvedValueOnce(usable())
    const onResult = vi.fn()
    renderGate(<GateHarness onResult={onResult} />)
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    const dialog = await screen.findByRole('dialog', { name: 'Studio GPU is parked' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn it back on' }))
    await waitFor(() => expect(ProvidersAPI.update).toHaveBeenCalledWith('studio_gpu', { enabled: true }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'started', value: 'done' }))
  })

  it('cancel resolves cancelled and does not enqueue', async () => {
    vi.spyOn(CullingModelsAPI, 'usable').mockResolvedValue(usable({ culling_profile: broken('no_model', { model: null }) }))
    const enqueue = vi.fn()
    function Harness() {
      const { run, dialog } = useCullingGate()
      return (
        <>
          <button type="button" onClick={() => void run('start', enqueue).then(onResult)}>
            Go
          </button>
          {dialog}
        </>
      )
    }
    const onResult = vi.fn()
    renderGate(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'cancelled' }))
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('usable failure resolves failed', async () => {
    vi.spyOn(CullingModelsAPI, 'usable').mockRejectedValue(new Error('network down'))
    const onResult = vi.fn()
    renderGate(<GateHarness onResult={onResult} />)
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({ status: 'failed', error: expect.objectContaining({ message: 'network down' }) }),
    )
  })

  it('a turn-off failure shows in the dialog only; retrying then starts', async () => {
    vi.spyOn(CullingModelsAPI, 'usable').mockResolvedValue(usable({ score_forecast: broken('no_model') }))
    mockTurnStageOff.mockRejectedValueOnce(new Error('save failed'))
    const onResult = vi.fn()
    renderGate(<GateHarness onResult={onResult} />)
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    const dialog = await screen.findByRole('dialog', { name: 'Score forecast has no model' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off and start' }))
    expect(await within(dialog).findByText('save failed')).toBeInTheDocument()
    expect(onResult).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off and start' }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'started', value: 'done' }))
    expect(onResult).toHaveBeenCalledTimes(1)
  })

  it('a failure switching a provider back on shows in the dialog only; cancel then resolves cancelled', async () => {
    vi.spyOn(CullingModelsAPI, 'usable').mockResolvedValue(
      usable({ culling_profile: broken('parked', { endpoint: 'studio_gpu', provider_name: 'Studio GPU' }) }),
    )
    vi.mocked(ProvidersAPI.update).mockRejectedValueOnce(new Error('provider save failed'))
    const onResult = vi.fn()
    renderGate(<GateHarness onResult={onResult} />)
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    const dialog = await screen.findByRole('dialog', { name: 'Studio GPU is parked' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn it back on' }))
    expect(await within(dialog).findByText('provider save failed')).toBeInTheDocument()
    expect(onResult).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'cancelled' }))
  })

  it('enqueue failure resolves failed', async () => {
    vi.spyOn(CullingModelsAPI, 'usable').mockResolvedValue(usable())
    const onResult = vi.fn()
    function Harness() {
      const { run, dialog } = useCullingGate()
      return (
        <>
          <button
            type="button"
            onClick={() => void run('start', () => Promise.reject(new Error('queue failed'))).then(onResult)}
          >
            Go
          </button>
          {dialog}
        </>
      )
    }
    renderGate(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({ status: 'failed', error: expect.objectContaining({ message: 'queue failed' }) }),
    )
  })
})
