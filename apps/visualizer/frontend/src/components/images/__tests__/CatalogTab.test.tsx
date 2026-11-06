import { Suspense, act } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CatalogTab } from '../CatalogTab'
import {
  CATALOG_FILTER_LABEL_KEYWORD,
  CATALOG_FILTER_LABEL_CATALOG,
  CATALOG_FILTER_LABEL_MIN_RATING,
  CATALOG_MIN_RATING_CLEAR,
  CATALOG_MIN_RATING_EMPTY_INTRO,
  CATALOG_MIN_RATING_EMPTY_SOURCE_FOLDER,
  FILTER_DESCRIPTION_SEARCH_ARIA,
  formatStackCountBadge,
} from '../../../constants/strings'
import type { CatalogImageInput } from '../../../services/api'
import { deleteMatching, setEntry } from '../../../data/cache'
import { keys, cullingChanged } from '../../../data/keys'
import { CULL_MODAL_NEXT, CULL_MODAL_PREV } from '../../../constants/strings'
import {
  clickModalNav,
  clickTileByKey,
  expectModalFilename,
  mockImageDetailFilenames,
  mockImageDetailModalDeps,
  stepModalPrevNext,
} from '../../image-view/__tests__/modalNavTestUtils'

const apiMocks = vi.hoisted(() => ({
  listCatalogMock: vi.fn(),
  getCatalogMonthsMock: vi.fn(),
  getCatalogMock: vi.fn(),
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
    ConfigAPI: {
      ...actual.ConfigAPI,
      getCatalog: (...args: unknown[]) => apiMocks.getCatalogMock(...args),
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

function seedFulfilledQuery(key: readonly unknown[], value: unknown): void {
  setEntry(JSON.stringify(key), {
    status: 'fulfilled',
    promise: Promise.resolve(value),
    value,
  })
}

describe('CatalogTab', () => {
  beforeEach(() => {
    localStorage.clear()
    deleteMatching(() => true)
    vi.clearAllMocks()
    apiMocks.listCatalogMock.mockResolvedValue({ images: [], total: 0 })
    apiMocks.getCatalogMonthsMock.mockResolvedValue({ months: [] })
    apiMocks.getCatalogMock.mockResolvedValue({
      catalog_path: '/test.lrcat',
      resolved_path: '/test.lrcat',
      exists: true,
      catalog_kind: 'lightroom',
      photo_count: 0,
      folder_count: null,
      unreadable_directories: [],
      picker_available: false,
    })
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

  it('shows folder Min rating empty copy in the grid when nothing is rated', async () => {
    const folderCatalog = {
      catalog_path: '/photos',
      resolved_path: '/photos',
      exists: true,
      catalog_kind: 'folder' as const,
      photo_count: 2,
      folder_count: 1,
      unreadable_directories: [],
      picker_available: false,
    }
    apiMocks.getCatalogMock.mockResolvedValue(folderCatalog)
    seedFulfilledQuery(keys.config.catalog(), folderCatalog)
    seedFulfilledQuery(keys.images.catalogList({ min_rating: 1, limit: 0, offset: 0 }), {
      images: [],
      total: 0,
    })
    seedFulfilledQuery(keys.images.catalogList({ catalog_presence: 'missing', limit: 0, offset: 0 }), {
      images: [],
      total: 0,
    })
    apiMocks.listCatalogMock.mockImplementation(async (params: Record<string, unknown> = {}) => {
      const limit = params.limit
      const minRating = params.min_rating
      if (limit === 0) {
        return { images: [], total: 0 }
      }
      if (minRating != null && Number(minRating) >= 1) {
        return { images: [], total: 0 }
      }
      return {
        images: [
          { ...catalogRow('unrated-a', 1), rating: 0 },
          { ...catalogRow('unrated-b', 2), rating: 0 },
        ],
        total: 2,
      }
    })

    render(
      <MemoryRouter>
        <Suspense fallback={null}>
          <CatalogTab />
        </Suspense>
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getAllByTestId('image-tile')).toHaveLength(2)
    })

    const minRatingSelect = screen.getByLabelText(CATALOG_FILTER_LABEL_MIN_RATING)
    await act(async () => {
      fireEvent.change(minRatingSelect, { target: { value: '3' } })
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: CATALOG_MIN_RATING_CLEAR })).toBeInTheDocument()
    })
    expect(screen.getByText(CATALOG_MIN_RATING_EMPTY_INTRO(3), { exact: false })).toBeInTheDocument()
    expect(screen.getByText(CATALOG_MIN_RATING_EMPTY_SOURCE_FOLDER, { exact: false })).toBeInTheDocument()
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
      expect(screen.getAllByText(CATALOG_FILTER_LABEL_CATALOG).length).toBeGreaterThan(0)
    })

    await waitFor(() => {
      expect(apiMocks.listCatalogMock).toHaveBeenCalled()
    })
    const pageCall = apiMocks.listCatalogMock.mock.calls.find(
      (call) =>
        (call[0] as { limit?: number; offset?: number; catalog_presence?: string }).limit === 50 &&
        (call[0] as { offset?: number }).offset === 0 &&
        !(call[0] as { catalog_presence?: string }).catalog_presence,
    )
    expect(pageCall).toBeTruthy()
    const params = pageCall![0] as Record<string, unknown>
    expect(params).not.toHaveProperty('posted')
    expect(params).not.toHaveProperty('analyzed')
    expect(params).not.toHaveProperty('keyword')
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

  it('stays on the photo stepped to when the catalog list reloads', async () => {
    const keys = ['cat-a', 'cat-b', 'cat-c']
    apiMocks.listCatalogMock.mockImplementation(async () => ({
      images: keys.map((key, i) => catalogRow(key, i + 1)),
      total: 3,
    }))
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
    await expectModalFilename('cat-b.jpg')
    clickModalNav('next')
    await expectModalFilename('cat-c.jpg')

    const calls = apiMocks.listCatalogMock.mock.calls.length
    act(() => cullingChanged())
    await waitFor(() => expect(apiMocks.listCatalogMock.mock.calls.length).toBeGreaterThan(calls))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    await expectModalFilename('cat-c.jpg')
  })

  it('a photo opened from a link that is not on the page has no Prev / Next', async () => {
    const keys = ['cat-a', 'cat-b', 'cat-c']
    apiMocks.listCatalogMock.mockResolvedValue({
      images: keys.map((key, i) => catalogRow(key, i + 1)),
      total: 3,
    })
    mockImageDetailModalDeps()
    mockImageDetailFilenames([...keys, 'elsewhere'])

    render(
      <MemoryRouter initialEntries={['/?image_key=elsewhere']}>
        <Suspense fallback={null}>
          <CatalogTab />
        </Suspense>
      </MemoryRouter>,
    )

    await expectModalFilename('elsewhere.jpg')
    expect(screen.queryByRole('button', { name: new RegExp(CULL_MODAL_PREV) })).toBeNull()
    expect(screen.queryByRole('button', { name: new RegExp(CULL_MODAL_NEXT) })).toBeNull()
  })
})
