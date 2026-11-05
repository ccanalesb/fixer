import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Suspense } from 'react'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { deleteMatching } from '../../../../data/cache'
import { useQuery } from '../../../../data'
import { keys } from '../../../../data/keys'
import { MemoryRouter } from 'react-router-dom'
import {
  CullAPI,
  CullingModelsAPI,
  type CullingModelsUsable,
  type CullingStageUsability,
  type FrameSubstanceResponse,
} from '../../../../services/api'
import { CullingTab } from '../CullingTab'

const mockGet = vi.fn()
const mockCreateOverride = vi.fn()
const mockDeleteOverride = vi.fn()

vi.mock('../../../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../services/api')>()
  const { cullingChanged } = await import('../../../../data/keys')
  return {
    ...actual,
    FrameSubstanceAPI: {
      get: (...args: unknown[]) => mockGet(...args),
      createOverride: async (...args: unknown[]) => {
        const result = await mockCreateOverride(...args)
        cullingChanged()
        return result
      },
      deleteOverride: async (...args: unknown[]) => {
        const result = await mockDeleteOverride(...args)
        cullingChanged()
        return result
      },
    },
  }
})

const KEY = '2024-01-01_photo.jpg'

function frame(overrides: Partial<FrameSubstanceResponse> = {}): FrameSubstanceResponse {
  return {
    image_key: KEY,
    has_detection_run: true,
    verdict: 'void',
    unknown_reason: null,
    detector_version: 'v1',
    judged_at: '2024-01-01T00:00:00+00:00',
    is_stale: false,
    has_override: false,
    flagged: true,
    instrument: { kind: 'pixel_detector', verdict: 'void', tier: 'A', advisory: false },
    restore_tier: 'A',
    ...overrides,
  }
}

function renderTab() {
  return render(
    <Suspense fallback={null}>
      <CullingTab imageKey={KEY} showVerdict={false} />
    </Suspense>,
  )
}

describe('CullingTab — frame substance', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    mockGet.mockReset()
    mockCreateOverride.mockReset()
    mockDeleteOverride.mockReset()
  })

  afterEach(() => {
    cleanup()
    deleteMatching(() => true)
  })

  it('says when no detection run has judged the frame', async () => {
    mockGet.mockResolvedValue(
      frame({ has_detection_run: false, verdict: null, flagged: false, instrument: null, restore_tier: null }),
    )
    renderTab()
    expect(await screen.findByText(/Not judged yet/i)).toBeInTheDocument()
  })

  it('tells an unmounted share and a broken file apart', async () => {
    mockGet.mockResolvedValue(
      frame({ verdict: 'unknown', unknown_reason: 'cache_file_missing', flagged: false, instrument: null, restore_tier: null }),
    )
    const { unmount } = renderTab()
    expect(await screen.findByText(/mount the share/i)).toBeInTheDocument()
    unmount()
    deleteMatching(() => true)

    mockGet.mockResolvedValue(
      frame({ verdict: 'unknown', unknown_reason: 'decode_failed', flagged: false, instrument: null, restore_tier: null }),
    )
    renderTab()
    expect(await screen.findByText(/could not be decoded/i)).toBeInTheDocument()
  })

  it('never renders an unknown verdict as OK, even with no reason recorded', async () => {
    mockGet.mockResolvedValue(
      frame({ verdict: 'unknown', unknown_reason: null, flagged: false, instrument: null, restore_tier: null }),
    )
    renderTab()
    expect(await screen.findByText(/Not judged/i)).toBeInTheDocument()
    expect(screen.queryByText(/Judged OK/i)).not.toBeInTheDocument()
  })

  it('warns a Tier A restore needs a rescore, and a Tier B one does not', async () => {
    mockGet.mockResolvedValue(frame())
    const { unmount } = renderTab()
    expect(await screen.findByText(/next scoring run/i)).toBeInTheDocument()
    unmount()
    deleteMatching(() => true)

    mockGet.mockResolvedValue(
      frame({
        verdict: 'illegible',
        instrument: { kind: 'pixel_detector', verdict: 'illegible', tier: 'B', advisory: false },
        restore_tier: 'B',
      }),
    )
    renderTab()
    await screen.findByText(/illegible frame/i)
    expect(screen.queryByText(/next scoring run/i)).not.toBeInTheDocument()
  })

  it('labels the excusal channel as advisory', async () => {
    mockGet.mockResolvedValue(
      frame({
        verdict: 'ok',
        flagged: false,
        instrument: { kind: 'excusal_channel', verdict: null, tier: null, advisory: true },
        restore_tier: null,
      }),
    )
    renderTab()
    expect(await screen.findByText(/Advisory excusal hint/i)).toBeInTheDocument()
  })

  it('shows nothing when the detector judged the frame OK', async () => {
    mockGet.mockResolvedValue(frame({ verdict: 'ok', flagged: false, instrument: null, restore_tier: null }))
    const { container } = renderTab()
    await waitFor(() => expect(mockGet).toHaveBeenCalled())
    await waitFor(() => expect(container.textContent).toBe(''))
  })

  it('still shows an OK verdict judged against an older preview', async () => {
    mockGet.mockResolvedValue(
      frame({ verdict: 'ok', flagged: false, instrument: null, restore_tier: null, is_stale: true }),
    )
    renderTab()
    expect(await screen.findByText(/Judged OK/i)).toBeInTheDocument()
    expect(screen.getByText(/older preview/i)).toBeInTheDocument()
  })

  it('offers only the restore, and no way to mark the photo in Lightroom', async () => {
    mockGet.mockResolvedValue(frame())
    renderTab()
    await screen.findByRole('button', { name: /Restore to ranking/i })
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('calls the override API on restore', async () => {
    mockGet.mockResolvedValue(frame())
    mockCreateOverride.mockResolvedValue({ image_key: KEY, has_override: true })
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: /Restore to ranking/i }))
    await waitFor(() => expect(mockCreateOverride).toHaveBeenCalledWith(KEY))
  })

  it('refetches dashboard and identity queries after a frame-substance override', async () => {
    const mockDashboard = vi.fn().mockResolvedValue({ stats: null })
    const mockIdentity = vi.fn().mockResolvedValue({ mirror: null })
    mockGet.mockResolvedValue(frame())

    function Harness() {
      useQuery(keys.dashboard(), () => mockDashboard())
      useQuery(keys.identity.mirror(), () => mockIdentity())
      return <CullingTab imageKey={KEY} showVerdict={false} />
    }

    render(
      <Suspense fallback={null}>
        <Harness />
      </Suspense>,
    )
    await waitFor(() => expect(mockDashboard).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mockIdentity).toHaveBeenCalledTimes(1))
    mockCreateOverride.mockResolvedValue({ image_key: KEY, has_override: true })
    fireEvent.click(await screen.findByRole('button', { name: /Restore to ranking/i }))
    await waitFor(() => expect(mockCreateOverride).toHaveBeenCalledWith(KEY))
    await waitFor(() => expect(mockDashboard).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(mockIdentity).toHaveBeenCalledTimes(2))
  })
})

const stageOk = (model: string): CullingStageUsability => ({
  on: true,
  problem: null,
  model,
  endpoint: 'this_app',
  job_id: null,
  provider_name: null,
})

const allStagesOk = (u: Partial<CullingModelsUsable> = {}): CullingModelsUsable => ({
  culling_profile: stageOk('culling-model'),
  score_forecast: stageOk('forecast-model'),
  culling_profile_filter: true,
  ...u,
})

describe('CullingTab — send through the culling gate', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    mockGet.mockReset()
    mockGet.mockResolvedValue(frame({ verdict: 'ok', flagged: false, restore_tier: null, instrument: null }))
    vi.spyOn(CullAPI, 'photoDetail').mockResolvedValue({
      image_key: KEY,
      filename: 'filtered-one.jpg',
      verdict: 'filtered',
      sent_by_hand: false,
      completion: 'none',
      needs_send_work: true,
      score_forecast: [],
      profile: { slug: '', name: '', level_sets: [] },
      user_actions: [],
      filtered_by: 'culling_profile',
      score_forecast_p8: null,
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    deleteMatching(() => true)
  })

  function renderWithVerdict() {
    return render(
      <MemoryRouter>
        <Suspense fallback={null}>
          <CullingTab imageKey={KEY} showVerdict />
        </Suspense>
      </MemoryRouter>,
    )
  }

  it('sends the photo when every stage that is on can run', async () => {
    vi.spyOn(CullingModelsAPI, 'usable').mockResolvedValue(allStagesOk())
    const send = vi.spyOn(CullAPI, 'sendPhotos').mockResolvedValue({ sent_by_hand: [KEY], job_id: 'j', skipped_complete: 0 })
    renderWithVerdict()
    fireEvent.click(await screen.findByRole('button', { name: 'Send to scoring' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith([KEY]))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens the gate dialog and does not send when a stage that is on cannot run', async () => {
    vi.spyOn(CullingModelsAPI, 'usable').mockResolvedValue(
      allStagesOk({ score_forecast: { ...stageOk('forecast-model'), problem: 'no_model' } }),
    )
    const send = vi.spyOn(CullAPI, 'sendPhotos')
    renderWithVerdict()
    fireEvent.click(await screen.findByRole('button', { name: 'Send to scoring' }))
    expect(await screen.findByRole('dialog', { name: 'Score forecast has no model' })).toBeInTheDocument()
    expect(send).not.toHaveBeenCalled()
  })
})
