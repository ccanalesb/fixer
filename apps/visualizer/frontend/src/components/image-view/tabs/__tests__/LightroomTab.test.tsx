import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LrWritebackAPI, type LrWritebackPhotoDetailResponse } from '../../../../services/api'
import { LR_WRITEBACK_UNDO, LR_WRITEBACK_UNDO_STARS_ROW } from '../../../../constants/strings'
import { LightroomTab } from '../LightroomTab'

function detail(overrides: Partial<LrWritebackPhotoDetailResponse['rating']> = {}): LrWritebackPhotoDetailResponse {
  return {
    image_key: 'k',
    rating: { live: 4, app_wrote: true, before_label: null, undo_available: false, user_changed: false, ...overrides },
    flag: { live_pick: 0, app_wrote_reject: false, undo_available: false, user_changed: false },
    keywords: [],
    strong_dimensions_line: null,
  }
}

describe('LightroomTab', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('offers no undo once you changed the rating in Lightroom', async () => {
    vi.spyOn(LrWritebackAPI, 'getPhoto').mockResolvedValue(detail({ undo_available: false, user_changed: true }))
    render(<LightroomTab image={{ image_type: 'catalog', key: 'k' }} />)
    expect(await screen.findByText(/You changed this in Lightroom Classic/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: LR_WRITEBACK_UNDO })).toBeNull()
  })

  it('undoes the app’s stars from the action area', async () => {
    vi.spyOn(LrWritebackAPI, 'getPhoto').mockResolvedValue(detail({ undo_available: true }))
    const undo = vi.spyOn(LrWritebackAPI, 'undo').mockResolvedValue({ ok: true } as never)
    render(<LightroomTab image={{ image_type: 'catalog', key: 'k' }} />)
    expect(await screen.findByText(LR_WRITEBACK_UNDO_STARS_ROW)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: LR_WRITEBACK_UNDO }))
    await waitFor(() => expect(undo).toHaveBeenCalledWith('k', 'stars'))
  })

  it('falls back to the catalog rating and keywords when nothing was written back', async () => {
    vi.spyOn(LrWritebackAPI, 'getPhoto').mockRejectedValue(new Error('not found'))
    render(<LightroomTab image={{ image_type: 'catalog', key: 'k', rating: 3, pick: true, keywords: ['street'] }} />)
    expect(await screen.findByText('3★')).toBeInTheDocument()
    expect(screen.getByText('Pick')).toBeInTheDocument()
    expect(screen.getByText('street')).toBeInTheDocument()
  })
})
