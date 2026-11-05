import { Suspense } from 'react'
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { StackSuggestionsPanel } from '../StackSuggestionsPanel'
import { deleteMatching } from '../../../data/cache'
import {
  STACK_SUGGESTIONS_ACCEPT,
  STACK_SUGGESTIONS_EMPTY,
  STACK_SUGGESTIONS_REJECT,
} from '../../../constants/strings'

const mockListStackSuggestions = vi.fn()
const mockRejectStackSuggestion = vi.fn()
const mockAcceptStackSuggestion = vi.fn()

vi.mock('../../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/api')>()
  return {
    ...actual,
    ImagesAPI: {
      ...actual.ImagesAPI,
      listStackSuggestions: (...args: unknown[]) => mockListStackSuggestions(...args),
      rejectStackSuggestion: (...args: unknown[]) => mockRejectStackSuggestion(...args),
      acceptStackSuggestion: (...args: unknown[]) => mockAcceptStackSuggestion(...args),
    },
  }
})

function renderPanel() {
  return render(
    <MemoryRouter>
      <Suspense fallback={null}>
        <StackSuggestionsPanel />
      </Suspense>
    </MemoryRouter>,
  )
}

describe('StackSuggestionsPanel', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    mockListStackSuggestions.mockResolvedValue({
      items: [
        {
          group_id: 1,
          image_a: {
            key: 'a',
            filename: 'a.jpg',
            date_taken: '2026-03-20T13:55:40',
            thumbnail_url: '/api/images/catalog/a/thumbnail',
          },
          image_b: {
            key: 'b',
            filename: 'b.jpg',
            date_taken: '2026-03-20T13:55:41',
            thumbnail_url: '/api/images/catalog/b/thumbnail',
          },
          similarity: 0.95,
          why_matched: 'Visual match (95%)',
          time_gap_seconds: 1,
        },
      ],
      total: 1,
    })
    mockRejectStackSuggestion.mockResolvedValue({
      image_key_a: 'a',
      image_key_b: 'b',
      rejected: true,
    })
    mockAcceptStackSuggestion.mockResolvedValue({
      stack: {
        stack_id: 9,
        representative_key: 'a',
        stack_member_count: 2,
        member_keys: ['a', 'b'],
      },
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders pending suggestions and rejects a pair', async () => {
    renderPanel()

    expect(await screen.findByText('a.jpg')).toBeInTheDocument()
    expect(screen.getByText('b.jpg')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: STACK_SUGGESTIONS_REJECT }))
    await waitFor(() => {
      expect(mockRejectStackSuggestion).toHaveBeenCalledWith('a', 'b')
    })
  })

  it('shows empty state when there are no suggestions', async () => {
    mockListStackSuggestions.mockResolvedValue({ items: [], total: 0 })
    renderPanel()
    expect(await screen.findByText(STACK_SUGGESTIONS_EMPTY)).toBeInTheDocument()
  })

  it('accepts a suggestion', async () => {
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: STACK_SUGGESTIONS_ACCEPT }))
    await waitFor(() => {
      expect(mockAcceptStackSuggestion).toHaveBeenCalledWith('a', 'b')
    })
  })
})
