import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Suspense } from 'react'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { deleteMatching } from '../../../data/cache'
import { FrameSubstanceSection } from '../FrameSubstanceSection'
import type { FrameSubstanceResponse } from '../../../services/api'

const mockGet = vi.fn()
const mockCreateOverride = vi.fn()
const mockDeleteOverride = vi.fn()

vi.mock('../../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/api')>()
  return {
    ...actual,
    FrameSubstanceAPI: {
      get: (...args: unknown[]) => mockGet(...args),
      createOverride: (...args: unknown[]) => mockCreateOverride(...args),
      deleteOverride: (...args: unknown[]) => mockDeleteOverride(...args),
    },
  }
})

function basePayload(overrides: Partial<FrameSubstanceResponse> = {}): FrameSubstanceResponse {
  return {
    image_key: '2024-01-01_photo.jpg',
    has_detection_run: true,
    verdict: 'void',
    unknown_reason: null,
    detector_version: 'v1',
    judged_at: '2024-01-01T00:00:00+00:00',
    is_stale: false,
    has_override: false,
    flagged: true,
    instrument: {
      kind: 'pixel_detector',
      verdict: 'void',
      tier: 'A',
      advisory: false,
    },
    restore_tier: 'A',
    ...overrides,
  }
}

function renderSection() {
  return render(
    <Suspense fallback={null}>
      <FrameSubstanceSection imageKey="2024-01-01_photo.jpg" />
    </Suspense>,
  )
}

describe('FrameSubstanceSection', () => {
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

  it('shows no-run message when unjudged', async () => {
    mockGet.mockResolvedValue(
      basePayload({
        verdict: null,
        has_detection_run: false,
        flagged: false,
        instrument: null,
        restore_tier: null,
      }),
    )
    renderSection()
    expect(
      await screen.findByText(/Not judged yet/i),
    ).toBeInTheDocument()
  })

  it('tells an unmounted share and a broken file apart', async () => {
    mockGet.mockResolvedValue(
      basePayload({
        verdict: 'unknown',
        unknown_reason: 'cache_file_missing',
        flagged: false,
        instrument: null,
        restore_tier: null,
      }),
    )
    const { unmount } = renderSection()
    expect(await screen.findByText(/mount the share/i)).toBeInTheDocument()
    unmount()
    cleanup()
    deleteMatching(() => true)

    mockGet.mockResolvedValue(
      basePayload({
        verdict: 'unknown',
        unknown_reason: 'decode_failed',
        flagged: false,
        instrument: null,
        restore_tier: null,
      }),
    )
    renderSection()
    expect(await screen.findByText(/will not fix itself/i)).toBeInTheDocument()
    expect(screen.queryByText(/mount the share/i)).not.toBeInTheDocument()
  })

  it('never renders an unknown verdict as OK, even with no reason recorded', async () => {
    mockGet.mockResolvedValue(
      basePayload({
        verdict: 'unknown',
        unknown_reason: null,
        flagged: false,
        instrument: null,
        restore_tier: null,
      }),
    )
    renderSection()
    expect(await screen.findByText(/Not judged/i)).toBeInTheDocument()
    expect(screen.queryByText(/Judged OK/i)).not.toBeInTheDocument()
  })

  it('warns Tier A restore needs rescore and not Tier B', async () => {
    mockGet.mockResolvedValue(basePayload())
    const { unmount } = renderSection()
    expect(await screen.findByText(/next scoring run/i)).toBeInTheDocument()
    unmount()
    cleanup()
    deleteMatching(() => true)

    mockGet.mockResolvedValue(
      basePayload({
        verdict: 'illegible',
        instrument: {
          kind: 'pixel_detector',
          verdict: 'illegible',
          tier: 'B',
          advisory: false,
        },
        restore_tier: 'B',
      }),
    )
    renderSection()
    await screen.findByText(/illegible frame/i)
    expect(screen.queryByText(/next scoring run/i)).not.toBeInTheDocument()
  })

  it('labels excusal channel as advisory', async () => {
    mockGet.mockResolvedValue(
      basePayload({
        verdict: 'ok',
        flagged: false,
        instrument: {
          kind: 'excusal_channel',
          verdict: null,
          tier: null,
          advisory: true,
        },
        restore_tier: null,
      }),
    )
    renderSection()
    expect(
      await screen.findByText(/Advisory excusal hint/i),
    ).toBeInTheDocument()
  })

  it('shows nothing when the detector judged the frame OK', async () => {
    mockGet.mockResolvedValue(
      basePayload({ verdict: 'ok', flagged: false, instrument: null, restore_tier: null }),
    )
    const { container } = renderSection()
    await waitFor(() => expect(mockGet).toHaveBeenCalled())
    await waitFor(() => expect(container.textContent).toBe(''))
  })

  it('still shows an OK verdict judged against an older preview', async () => {
    mockGet.mockResolvedValue(
      basePayload({ verdict: 'ok', flagged: false, instrument: null, restore_tier: null, is_stale: true }),
    )
    renderSection()
    expect(await screen.findByText(/Judged OK/i)).toBeInTheDocument()
    expect(screen.getByText(/older preview/i)).toBeInTheDocument()
  })

  it('offers no way to mark the photo in Lightroom', async () => {
    mockGet.mockResolvedValue(basePayload())
    renderSection()
    await screen.findByRole('button', { name: /Restore to ranking/i })
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('calls override API on restore', async () => {
    mockGet.mockResolvedValue(basePayload())
    mockCreateOverride.mockResolvedValue({ image_key: '2024-01-01_photo.jpg', has_override: true })
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: /Restore to ranking/i }))
    await waitFor(() => expect(mockCreateOverride).toHaveBeenCalledWith('2024-01-01_photo.jpg'))
  })
})
