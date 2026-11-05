import { act, Suspense } from 'react'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteMatching } from '../../../../data/cache'
import { LrWritebackAPI, type LrWritebackPhotoDetailResponse } from '../../../../services/api'
import { LR_WRITEBACK_UNDO, LR_WRITEBACK_UNDO_STARS_ROW } from '../../../../constants/strings'
import { useSocketStore } from '../../../../stores/socketStore'
import { useBackendSocket } from '../../../../hooks/useBackendSocket'
import { LightroomTab } from '../LightroomTab'

const handlers: Record<string, (payload: unknown) => void> = {}
const socket = {
  on: (event: string, fn: (payload: unknown) => void) => {
    handlers[event] = fn
  },
  off: vi.fn(),
}

function detail(
  overrides: Partial<LrWritebackPhotoDetailResponse['rating']> = {},
  live = 4,
): LrWritebackPhotoDetailResponse {
  return {
    image_key: 'k',
    rating: {
      live,
      app_wrote: true,
      before_label: null,
      undo_available: false,
      user_changed: false,
      ...overrides,
    },
    flag: { live_pick: 0, app_wrote_reject: false, undo_available: false, user_changed: false },
    keywords: [],
    strong_dimensions_line: null,
  }
}

function renderTab(image: Parameters<typeof LightroomTab>[0]['image'], withSocket = false) {
  if (withSocket) {
    useSocketStore.setState({ socket: socket as never, connected: true, connect: () => {} })
    return render(
      <Suspense fallback={null}>
        <SocketShell />
        <LightroomTab image={image} />
      </Suspense>,
    )
  }
  return render(
    <Suspense fallback={null}>
      <LightroomTab image={image} />
    </Suspense>,
  )
}

function SocketShell() {
  useBackendSocket()
  return null
}

describe('LightroomTab', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    delete handlers.job_updated
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('offers no undo once you changed the rating in Lightroom', async () => {
    vi.spyOn(LrWritebackAPI, 'getPhoto').mockResolvedValue(detail({ undo_available: false, user_changed: true }))
    renderTab({ image_type: 'catalog', key: 'k' })
    expect(await screen.findByText(/You changed this in Lightroom Classic/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: LR_WRITEBACK_UNDO })).toBeNull()
  })

  it('undoes the app’s stars from the action area', async () => {
    vi.spyOn(LrWritebackAPI, 'getPhoto').mockResolvedValue(detail({ undo_available: true }))
    const undo = vi.spyOn(LrWritebackAPI, 'undo').mockResolvedValue({ ok: true } as never)
    renderTab({ image_type: 'catalog', key: 'k' })
    expect(await screen.findByText(LR_WRITEBACK_UNDO_STARS_ROW)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: LR_WRITEBACK_UNDO }))
    await waitFor(() => expect(undo).toHaveBeenCalledWith('k', 'stars'))
  })

  it('falls back to the catalog rating and keywords when nothing was written back', async () => {
    vi.spyOn(LrWritebackAPI, 'getPhoto').mockRejectedValue(new Error('not found'))
    renderTab({
      image_type: 'catalog',
      key: 'k',
      rating: 3,
      pick: true,
      keywords: ['street'],
    })
    expect(await screen.findByText('3★')).toBeInTheDocument()
    expect(screen.getByText('Pick')).toBeInTheDocument()
    expect(screen.getByText('street')).toBeInTheDocument()
  })

  it('shows new stars after an lr_writeback job finishes without reopening the tab', async () => {
    let live = 3
    vi.spyOn(LrWritebackAPI, 'getPhoto').mockImplementation(async () => detail({}, live))

    renderTab({ image_type: 'catalog', key: 'k' }, true)
    expect(await screen.findByText('3★')).toBeInTheDocument()

    live = 5
    await act(async () => {
      handlers.job_updated!({ id: 'j', type: 'lr_writeback', status: 'completed' })
    })
    expect(await screen.findByText('5★')).toBeInTheDocument()
  })
})
