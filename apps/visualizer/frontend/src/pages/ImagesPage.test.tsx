import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Suspense } from 'react'
import { ImagesPage } from './ImagesPage'
import { invalidateAll } from '../data'
import { ConfigAPI, SystemAPI } from '../services/api'
import {
  FIRST_RUN_GO_TO_SETUP,
  FIRST_RUN_IMAGES_EMPTY_HINT,
  FIRST_RUN_READING_CATALOG,
  FIRST_RUN_SEE_PROGRESS,
  TAB_CATALOG,
} from '../constants/strings'

const EMPTY_PIPELINE = {
  catalog_sync: null,
  embed_catalog: null,
  stack_detect: null,
  catalog_similarity: null,
  catalog_cache_build: null,
}

function renderImages() {
  return render(
    <MemoryRouter>
      <Suspense fallback={null}>
        <ImagesPage />
      </Suspense>
    </MemoryRouter>,
  )
}

describe('ImagesPage first-run states', () => {
  beforeEach(() => {
    invalidateAll(['firstRun'])
    vi.spyOn(ConfigAPI, 'getCatalog').mockResolvedValue({
      catalog_path: '',
      resolved_path: '',
      exists: false,
      picker_available: false,
      synced_catalog_path: null,
      needs_catalog_sync: false,
    })
    vi.spyOn(SystemAPI, 'cachePipelineStatus').mockResolvedValue(EMPTY_PIPELINE)
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

  it('shows the empty library prompt before import', async () => {
    renderImages()
    expect(await screen.findByText(FIRST_RUN_IMAGES_EMPTY_HINT)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: FIRST_RUN_GO_TO_SETUP })).toHaveAttribute('href', '/')
    expect(screen.queryByRole('tab', { name: TAB_CATALOG })).not.toBeInTheDocument()
  })

  it('shows reading copy while sync runs on an empty library', async () => {
    vi.spyOn(SystemAPI, 'cachePipelineStatus').mockResolvedValue({
      ...EMPTY_PIPELINE,
      catalog_cache_build: {
        job_id: 'job-1',
        type: 'catalog_cache_build',
        status: 'running',
        created_at: '2026-01-01T00:00:00Z',
        started_at: '2026-01-01T00:00:01Z',
        completed_at: null,
        error: null,
      },
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
    const { JobsAPI } = await import('../services/api')
    vi.spyOn(JobsAPI, 'get').mockResolvedValue({
      id: 'job-1',
      type: 'catalog_cache_build',
      status: 'running',
      progress: 10,
      current_step: 'Catalog sync',
      logs: [],
      logs_total: 0,
      warning_count: 0,
      error_count: 0,
      created_at: '2026-01-01T00:00:00Z',
      metadata: {},
    })

    renderImages()
    expect(await screen.findByText(FIRST_RUN_READING_CATALOG)).toBeInTheDocument()
  })

  it('shows the grid with a setup link after sync while import continues', async () => {
    vi.spyOn(SystemAPI, 'insightsSummary').mockResolvedValue({
      first_catalog_import_completed: false,
      catalog_images: 42,
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
    vi.spyOn(SystemAPI, 'cachePipelineStatus').mockResolvedValue({
      ...EMPTY_PIPELINE,
      catalog_cache_build: {
        job_id: 'job-2',
        type: 'catalog_cache_build',
        status: 'running',
        created_at: '2026-01-01T00:00:00Z',
        started_at: '2026-01-01T00:00:01Z',
        completed_at: null,
        error: null,
      },
    })
    const { JobsAPI, ImagesAPI, PerspectivesAPI } = await import('../services/api')
    vi.spyOn(JobsAPI, 'get').mockResolvedValue({
      id: 'job-2',
      type: 'catalog_cache_build',
      status: 'running',
      progress: 40,
      current_step: '[embed] Embedded 1/42',
      logs: [],
      logs_total: 0,
      warning_count: 0,
      error_count: 0,
      created_at: '2026-01-01T00:00:00Z',
      metadata: {},
    })
    vi.spyOn(ImagesAPI, 'listCatalog').mockResolvedValue({ images: [], total: 0 })
    vi.spyOn(ImagesAPI, 'getCatalogMonths').mockResolvedValue({ months: [] })
    vi.spyOn(PerspectivesAPI, 'list').mockResolvedValue([])

    renderImages()
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: TAB_CATALOG })).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.getByRole('link', { name: FIRST_RUN_SEE_PROGRESS })).toHaveAttribute('href', '/')
    })
  })
})
