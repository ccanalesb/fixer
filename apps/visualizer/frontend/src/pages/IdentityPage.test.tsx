import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { IdentityPage } from './IdentityPage'
import { ConfigAPI, IdentityAPI, SystemAPI } from '../services/api'
import { invalidateAll } from '../data'
import {
  EMPTY_MIRROR_RESPONSE,
  EMPTY_POST_NEXT_META,
} from '../__test-utils__/identityFixtures'
import {
  FIRST_RUN_GO_TO_SETUP,
  FIRST_RUN_IDENTITY_EMPTY_HINT,
  IDENTITY_ADVISOR_EMPTY_FALLBACK,
  IDENTITY_DIVIDER_BACKWARD,
  IDENTITY_DIVIDER_FORWARD,
  IDENTITY_MIRROR_EMPTY,
  IDENTITY_PAGE_TITLE,
  IDENTITY_SECTION_ADVISOR,
  IDENTITY_MIRROR_SECTION,
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

describe('IdentityPage', () => {
  beforeEach(() => {
    invalidateAll(['identity'])
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
    vi.spyOn(SystemAPI, 'insightsSummary').mockResolvedValue({
      first_catalog_import_completed: true,
      catalog_images: 10,
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
    vi.spyOn(IdentityAPI, 'getMirror').mockResolvedValue(EMPTY_MIRROR_RESPONSE)
    vi.spyOn(IdentityAPI, 'getSuggestions').mockResolvedValue({
      candidates: [],
      total: 0,
      meta: EMPTY_POST_NEXT_META,
      empty_state: null,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders page title and section headings in narrative order', async () => {
    render(
      <MemoryRouter>
        <IdentityPage />
      </MemoryRouter>,
    )

    expect(screen.getByRole('heading', { level: 1, name: IDENTITY_PAGE_TITLE })).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { level: 2, name: IDENTITY_MIRROR_SECTION }),
    ).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { level: 2, name: IDENTITY_SECTION_ADVISOR }),
    ).toBeInTheDocument()

    const body = document.body.innerHTML
    expect(body.indexOf(IDENTITY_MIRROR_SECTION) < body.indexOf(IDENTITY_SECTION_ADVISOR)).toBe(
      true,
    )
    expect(screen.getByText(IDENTITY_DIVIDER_BACKWARD)).toBeInTheDocument()
    expect(screen.getByText(IDENTITY_DIVIDER_FORWARD)).toBeInTheDocument()
  })

  it('points to setup when the library has no photos', async () => {
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
    vi.spyOn(SystemAPI, 'cachePipelineStatus').mockResolvedValue({
      catalog_sync: null,
      embed_catalog: null,
      stack_detect: null,
      catalog_similarity: null,
      catalog_cache_build: null,
    })

    render(
      <MemoryRouter>
        <IdentityPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText(FIRST_RUN_IDENTITY_EMPTY_HINT)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: FIRST_RUN_GO_TO_SETUP })).toBeInTheDocument()
    expect(screen.queryByText(IDENTITY_MIRROR_EMPTY)).not.toBeInTheDocument()
  })

  it('shows empty-state copy when APIs return no data', async () => {
    render(
      <MemoryRouter>
        <IdentityPage />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getByText(IDENTITY_MIRROR_EMPTY)).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.getByText(IDENTITY_ADVISOR_EMPTY_FALLBACK)).toBeInTheDocument()
    })
  })
})
