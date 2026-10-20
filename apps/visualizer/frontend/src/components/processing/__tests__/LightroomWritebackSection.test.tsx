import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LightroomWritebackSection } from '../LightroomWritebackSection'
import { LrWritebackAPI } from '../../../services/api'
import { LR_WRITEBACK_STARS_SWITCH } from '../../../constants/strings'

describe('LightroomWritebackSection', () => {
  it('shows stars switch label from strings', async () => {
    vi.spyOn(LrWritebackAPI, 'getSettings').mockResolvedValue({
      write_stars: false,
      write_reject: false,
      stars_recipe_slug: null,
      active_recipe_slugs: ['recipe-7h47'],
      catalog_write_available: true,
      catalog_write_unavailable_reason: null,
      counts: { stars: { pending: 0, written: 0 }, reject: { pending: 0, written: 0 } },
    })
    render(<LightroomWritebackSection />)
    expect(await screen.findByText(LR_WRITEBACK_STARS_SWITCH)).toBeInTheDocument()
  })
})
