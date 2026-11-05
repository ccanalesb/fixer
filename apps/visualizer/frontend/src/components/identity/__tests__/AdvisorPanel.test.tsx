import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AdvisorPanel } from '../AdvisorPanel'
import { IdentityAPI, type PostNextCandidate } from '../../../services/api'
import { deleteMatching } from '../../../data/cache'
import { EMPTY_POST_NEXT_META } from '../../../__test-utils__/identityFixtures'
import {
  mockImageDetailFilenames,
  mockImageDetailModalDeps,
  stepModalPrevNext,
} from '../../image-view/__tests__/modalNavTestUtils'

function candidate(imageKey: string): PostNextCandidate {
  return {
    image_key: imageKey,
    filename: `${imageKey}.jpg`,
    date_taken: '2024-01-01',
    rating: 3,
    peak_percentile: 0.9,
    peak_perspective_slug: 'street',
    peak_perspective_display_name: 'Street',
    is_signature: false,
    perspectives_covered: 1,
    per_perspective: [],
    reason_codes: [],
    reasons: ['Strong on street'],
  }
}

describe('AdvisorPanel', () => {
  beforeEach(() => {
    deleteMatching(() => true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('steps through post-next rows with Prev / Next', async () => {
    const keys = ['adv-a', 'adv-b', 'adv-c']
    vi.spyOn(IdentityAPI, 'getSuggestions').mockResolvedValue({
      candidates: keys.map(candidate),
      total: 3,
      meta: EMPTY_POST_NEXT_META,
      empty_state: null,
    })
    mockImageDetailModalDeps()
    mockImageDetailFilenames(keys)

    render(
      <MemoryRouter>
        <AdvisorPanel />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getByText('adv-b.jpg')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'adv-b.jpg' }))
    await stepModalPrevNext('adv-a.jpg', 'adv-b.jpg', 'adv-c.jpg')
  })
})
