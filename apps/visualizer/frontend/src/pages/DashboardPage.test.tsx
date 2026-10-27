import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { Suspense } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { DashboardPage } from './DashboardPage'
import { invalidateAll } from '../data'
import {
  ConfigAPI,
  IdentityAPI,
  SystemAPI,
} from '../services/api'
import {
  EMPTY_BEST_PHOTOS_META,
} from '../__test-utils__/identityFixtures'
import {
  FIRST_RUN_CHOOSE_CATALOG,
  FIRST_RUN_WELCOME_TITLE,
  INSIGHTS_KPI_SCORING_9_PLUS,
  INSIGHTS_PAGE_TITLE,
  INSIGHTS_SECTION_EXPLORE,
  INSIGHTS_SECTION_HIGHLIGHTS,
  INSIGHTS_SECTION_NEXT_ACTIONS,
  INSIGHTS_SECTION_PERSPECTIVE_COVERAGE,
} from '../constants/strings'

const completedImportPipeline = {
  catalog_sync: null,
  embed_catalog: null,
  stack_detect: null,
  catalog_similarity: null,
  catalog_cache_build: {
    job_id: 'done',
    type: 'catalog_cache_build',
    status: 'completed',
    created_at: '2026-01-01T00:00:00Z',
    started_at: '2026-01-01T00:00:01Z',
    completed_at: '2026-01-01T00:00:02Z',
    error: null,
  },
}

describe('DashboardPage', () => {
  beforeEach(() => {
    invalidateAll(['dashboard'])
    invalidateAll(['firstRun'])
    vi.spyOn(ConfigAPI, 'getCatalog').mockResolvedValue({
      catalog_path: '/tmp/test.lrcat',
      resolved_path: '/tmp/test.lrcat',
      exists: true,
      picker_available: false,
      synced_catalog_path: null,
      needs_catalog_sync: false,
    })
    vi.spyOn(SystemAPI, 'cachePipelineStatus').mockResolvedValue(completedImportPipeline)
    vi.spyOn(SystemAPI, 'clipModel').mockResolvedValue({
      model_on_disk: true,
      cache_dir: '/tmp/clip',
    })
    vi.spyOn(SystemAPI, 'insightsSummary').mockResolvedValue({
      first_catalog_import_completed: true,
      catalog_images: 1,
      scoring_9_plus: 2,
      burst_stacks: 3,
      pending_stack_suggestions: 6,
      unscored_on_active_perspectives: 4,
      no_current_score: 5,
      frame_substance_flagged: 2,
      frame_substance_unknown: { never_judged: 10 },
      frame_substance_run: null,
      perspective_coverage: [
        {
          slug: 'framing',
          display_name: 'Framing',
          active: true,
          scored_images: 1,
        },
      ],
    })
    vi.spyOn(IdentityAPI, 'getBestPhotos').mockImplementation(() =>
      Promise.resolve({
        items: [],
        total: 0,
        meta: EMPTY_BEST_PHOTOS_META,
      }),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders insights title and section headings', async () => {
    render(
      <MemoryRouter>
        <Suspense fallback={null}>
          <DashboardPage />
        </Suspense>
      </MemoryRouter>,
    )

    expect(
      await screen.findByRole('heading', { level: 1, name: INSIGHTS_PAGE_TITLE }),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Unposted' })).toBeInTheDocument()
    })
    expect(screen.getByRole('tab', { name: 'Posted' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'All' })).toBeInTheDocument()
    expect(IdentityAPI.getBestPhotos).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 8, posted: false }),
    )
    expect(IdentityAPI.getBestPhotos).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 8, posted: true }),
    )
    expect(IdentityAPI.getBestPhotos).toHaveBeenCalledWith({ limit: 8 })
    expect(SystemAPI.insightsSummary).toHaveBeenCalled()
    expect(screen.getByRole('link', { name: new RegExp(INSIGHTS_KPI_SCORING_9_PLUS) })).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 2, name: INSIGHTS_SECTION_HIGHLIGHTS }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 2, name: INSIGHTS_SECTION_NEXT_ACTIONS }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 2, name: INSIGHTS_SECTION_PERSPECTIVE_COVERAGE }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 2, name: INSIGHTS_SECTION_EXPLORE }),
    ).toBeInTheDocument()
  })
})

describe('DashboardPage first-run setup', () => {
  beforeEach(() => {
    invalidateAll(['dashboard'])
    invalidateAll(['firstRun'])
    vi.spyOn(ConfigAPI, 'getCatalog').mockResolvedValue({
      catalog_path: '',
      resolved_path: '',
      exists: false,
      picker_available: true,
      synced_catalog_path: null,
      needs_catalog_sync: false,
    })
    vi.spyOn(SystemAPI, 'cachePipelineStatus').mockResolvedValue({
      catalog_sync: null,
      embed_catalog: null,
      stack_detect: null,
      catalog_similarity: null,
      catalog_cache_build: null,
    })
    vi.spyOn(SystemAPI, 'clipModel').mockResolvedValue({
      model_on_disk: true,
      cache_dir: '/tmp/clip',
    })
    vi.spyOn(SystemAPI, 'insightsSummary').mockResolvedValue({
      first_catalog_import_completed: false,
      catalog_images: 0,
      scoring_9_plus: 0,
      burst_stacks: 0,
      pending_stack_suggestions: 0,
      unscored_on_active_perspectives: 0,
      no_current_score: 0,
      frame_substance_flagged: 0,
      frame_substance_unknown: { never_judged: 0 },
      frame_substance_run: null,
      perspective_coverage: [],
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the setup screen when no import has finished', async () => {
    render(
      <MemoryRouter>
        <Suspense fallback={null}>
          <DashboardPage />
        </Suspense>
      </MemoryRouter>,
    )

    expect(await screen.findByRole('heading', { name: FIRST_RUN_WELCOME_TITLE })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: FIRST_RUN_CHOOSE_CATALOG })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: INSIGHTS_PAGE_TITLE })).not.toBeInTheDocument()
  })
})
