import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LightroomWritebackSection } from '../LightroomWritebackSection'
import { LrWritebackAPI } from '../../../services/api'
import { LR_WRITEBACK_STARS_SWITCH, LR_WRITEBACK_WRITE_NOW } from '../../../constants/strings'

describe('LightroomWritebackSection', () => {
  it('shows stars switch label from strings', async () => {
    vi.spyOn(LrWritebackAPI, 'getSettings').mockResolvedValue({
      write_stars: false,
      write_reject: false,
      stars_recipe_slug: null,
      active_recipe_slugs: ['recipe-7h47'],
      active_recipes: [{ slug: 'recipe-7h47', name: 'Recipe 7H47' }],
      catalog_write_available: true,
      catalog_write_unavailable_reason: null,
      counts: { stars: { pending: 0, written: 0 }, reject: { pending: 0, written: 0 } },
    })
    render(<LightroomWritebackSection />)
    expect(await screen.findByText(LR_WRITEBACK_STARS_SWITCH)).toBeInTheDocument()
  })

  it('disables Write pending now when Lightroom is open', async () => {
    vi.spyOn(LrWritebackAPI, 'getSettings').mockResolvedValue({
      write_stars: true,
      write_reject: true,
      stars_recipe_slug: 'recipe-7h47',
      active_recipe_slugs: ['recipe-7h47'],
      active_recipes: [{ slug: 'recipe-7h47', name: 'Recipe 7H47' }],
      catalog_write_available: false,
      catalog_write_unavailable_reason: 'Close Lightroom before writing to catalog.',
      counts: { stars: { pending: 3, written: 0 }, reject: { pending: 2, written: 0 } },
    })
    render(<LightroomWritebackSection />)
    const btn = await screen.findByRole('button', { name: LR_WRITEBACK_WRITE_NOW })
    expect(btn).toBeDisabled()
  })
})
