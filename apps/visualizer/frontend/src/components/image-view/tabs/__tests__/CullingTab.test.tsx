import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Suspense } from 'react'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { deleteMatching } from '../../../../data/cache'
import { useQuery } from '../../../../data'
import type { FrameSubstanceResponse } from '../../../../services/api'
import { CullingTab } from '../CullingTab'

const mockGet = vi.fn()
const mockCreateOverride = vi.fn()
const mockDeleteOverride = vi.fn()

vi.mock('../../../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../services/api')>()
  return {
    ...actual,
    FrameSubstanceAPI: {
      get: (...args: unknown[]) => mockGet(...args),
      createOverride: (...args: unknown[]) => mockCreateOverride(...args),
      deleteOverride: (...args: unknown[]) => mockDeleteOverride(...args),
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
      useQuery(['dashboard'] as const, () => mockDashboard())
      useQuery(['identity', 'probe'] as const, () => mockIdentity())
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
