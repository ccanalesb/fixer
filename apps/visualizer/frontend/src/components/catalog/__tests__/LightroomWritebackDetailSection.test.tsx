import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LightroomWritebackDetailSection } from '../LightroomWritebackDetailSection'
import { LrWritebackAPI } from '../../../services/api'

describe('LightroomWritebackDetailSection', () => {
  it('disables undo when user changed rating in Lightroom', async () => {
    vi.spyOn(LrWritebackAPI, 'getPhoto').mockResolvedValue({
      image_key: 'k',
      rating: {
        live: 4,
        app_wrote: true,
        before_label: null,
        undo_available: false,
        user_changed: true,
      },
      flag: {
        live_pick: 0,
        app_wrote_reject: false,
        undo_available: false,
        user_changed: false,
      },
      keywords: [],
      strong_dimensions_line: null,
    })
    render(<LightroomWritebackDetailSection imageKey="k" />)
    expect(await screen.findByText(/You changed this in Lightroom/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })
})
