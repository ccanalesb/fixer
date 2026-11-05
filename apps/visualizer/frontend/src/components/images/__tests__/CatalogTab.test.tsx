import { Suspense, act } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CatalogTab } from '../CatalogTab'
import {
  CATALOG_FILTER_LABEL_KEYWORD,
  FILTER_DESCRIPTION_SEARCH_ARIA,
  formatStackCountBadge,
} from '../../../constants/strings'
import type { CatalogImageInput } from '../../../services/api'
import { deleteMatching } from '../../../data/cache'
import {
  clickTileByKey,
  mockImageDetailFilenames,
  mockImageDetailModalDeps,
  stepModalPrevNext,
} from '../../image-view/__tests__/modalNavTestUtils'

const apiMocks = vi.hoisted(() => ({
  listCatalogMock: vi.fn(),
  getCatalogMonthsMock: vi.fn(),
  getStackMembersMock: vi.fn(),
  splitStackMemberMock: vi.fn(),
  setStackRepresentativeMock: vi.fn(),
  mergeStacksMock: vi.fn(),
  perspectivesListMock: vi.fn(),
}))

vi.mock('../../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/api')>()
  return {
    ...actual,
    ImagesAPI: {
      ...actual.ImagesAPI,
      listCatalog: (...args: unknown[]) => apiMocks.listCatalogMock(...args),
      getCatalogMonths: (...args: unknown[]) => apiMocks.getCatalogMonthsMock(...args),
      getStackMembers: (...args: unknown[]) => apiMocks.getStackMembersMock(...args),
      splitStackMember: (...args: unknown[]) => apiMocks.splitStackMemberMock(...args),
      setStackRepresentative: (...args: unknown[]) => apiMocks.setStackRepresentativeMock(...args),
      mergeStacks: (...args: unknown[]) => apiMocks.mergeStacksMock(...args),
    },
    PerspectivesAPI: {
      ...actual.PerspectivesAPI,
      list: (...args: unknown[]) => apiMocks.perspectivesListMock(...args),
    },
  }
})

function stackRepAndMember(): { rep: CatalogImageInput; member: CatalogImageInput } {
  const rep: CatalogImageInput = {
    id: 1,
    key: 'a/b/seed.jpg',
    filename: 'seed.jpg',
    filepath: '/a/b/seed.jpg',
    date_taken: '2024-01-01',
    rating: 3,
    pick: false,
    color_label: 'none',
    keywords: [],
    title: '',
    caption: '',
    copyright: '',
    width: 1000,
    height: 1000,
    instagram_posted: false,
    stack_id: 42,
    stack_member_count: 3,
    is_stack_representative: true,
  }
  const member: CatalogImageInput = {
    ...rep,
    id: 2,
    key: 'a/b/member.jpg',
    filename: 'member.jpg',
    is_stack_representative: false,
  }
  return { rep, member }
}

function catalogRow(key: string, id: number): CatalogImageInput {
  return {
    id,
    key,
    filename: `${key}.jpg`,
    filepath: `/${key}.jpg`,
    date_taken: '2024-01-01',
    rating: 3,
    pick: false,
    color_label: 'none',
    keywords: [],
    title: '',
    caption: '',
    copyright: '',
    width: 1000,
    height: 1000,
    instagram_posted: false,
    stack_id: null,
    stack_member_count: null,
    is_stack_representative: null,
  }
}

describe('CatalogTab', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    vi.clearAllMocks()
    apiMocks.listCatalogMock.mockResolvedValue({ images: [], total: 0 })
    apiMocks.getCatalogMonthsMock.mockResolvedValue({ months: [] })
    apiMocks.getStackMembersMock.mockResolvedValue({ items: [] })
    apiMocks.perspectivesListMock.mockResolvedValue([])
    apiMocks.splitStackMemberMock.mockResolvedValue({
      split_out_key: 'a/b/member.jpg',
      remaining_stack: {
        stack_id: 42,
        representative_key: 'a/b/seed.jpg',
        stack_member_count: 2,
        member_keys: ['a/b/seed.jpg', 'a/b/other.jpg'],
      },
      dissolved: false,
    })
    apiMocks.setStackRepresentativeMock.mockResolvedValue({
      stack: {
        stack_id: 42,
        representative_key: 'a/b/member.jpg',
        stack_member_count: 2,
        member_keys: [],
      },
    })
    apiMocks.mergeStacksMock.mockResolvedValue({
      stack: {
        stack_id: 42,
        representative_key: 'a/b/seed.jpg',
        stack_member_count: 4,
        member_keys: [],
      },
      merged_stack_id: 7,
    })
  })

  it('renders catalog filter labels and calls listCatalog with pagination defaults', async () => {
    render(
      <MemoryRouter>
        <Suspense fallback={null}>
          <CatalogTab />
        </Suspense>
      </MemoryRouter>,
    )

    // Keyword filter label is rendered once schema mounts.
    await waitFor(() => {
      expect(screen.getAllByText(CATALOG_FILTER_LABEL_KEYWORD).length).toBeGreaterThan(0)
    })

    // Initial load fires listCatalog with limit + offset only (no filters set).
    await waitFor(() => {
      expect(apiMocks.listCatalogMock).toHaveBeenCalled()
    })
    const firstCall = apiMocks.listCatalogMock.mock.calls[0]?.[0] ?? {}
    expect(firstCall.limit).toBe(50)
    expect(firstCall.offset).toBe(0)
    expect(firstCall).not.toHaveProperty('posted')
    expect(firstCall).not.toHaveProperty('analyzed')
    expect(firstCall).not.toHaveProperty('keyword')
  })

  it('sends description_search in listCatalog after debounce when description search is committed', async () => {
    render(
      <MemoryRouter>
        <Suspense fallback={null}>
          <CatalogTab />
        </Suspense>
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getAllByText(CATALOG_FILTER_LABEL_KEYWORD).length).toBeGreaterThan(0)
    })
    apiMocks.listCatalogMock.mockClear()

    vi.useFakeTimers()
    const input = screen.getByLabelText(FILTER_DESCRIPTION_SEARCH_ARIA)
    act(() => {
      fireEvent.change(input, { target: { value: 'sunset' } })
    })
    act(() => {
      vi.advanceTimersByTime(350)
    })

    const withDesc = apiMocks.listCatalogMock.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>)?.description_search === 'sunset',
    )
    expect(withDesc).toBeDefined()
    vi.useRealTimers()
  })

  it('shows stack badge in grid without stack action controls', async () => {
    const { rep } = stackRepAndMember()
    apiMocks.listCatalogMock.mockResolvedValue({ images: [rep], total: 1 })

    render(
      <MemoryRouter>
        <Suspense fallback={null}>
          <CatalogTab />
        </Suspense>
      </MemoryRouter>,
    )

    expect(await screen.findByText(formatStackCountBadge(3))).toBeTruthy()
    expect(apiMocks.getStackMembersMock).not.toHaveBeenCalled()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('steps through loaded catalog photos with Prev / Next in grid order', async () => {
    const keys = ['cat-a', 'cat-b', 'cat-c']
    apiMocks.listCatalogMock.mockResolvedValue({
      images: keys.map((key, i) => catalogRow(key, i + 1)),
      total: 3,
    })
    mockImageDetailModalDeps()
    mockImageDetailFilenames(keys)

    render(
      <MemoryRouter>
        <Suspense fallback={null}>
          <CatalogTab />
        </Suspense>
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getAllByTestId('image-tile')).toHaveLength(3)
    })

    clickTileByKey('cat-b')
    await stepModalPrevNext('cat-a.jpg', 'cat-b.jpg', 'cat-c.jpg')
  })
})
