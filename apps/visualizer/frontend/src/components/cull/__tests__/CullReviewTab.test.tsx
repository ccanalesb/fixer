import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { CullAPI, CullingModelsAPI, type CullReviewRow } from '../../../services/api'
import { CullReviewTab } from '../CullReviewTab'
import { CULL_AGREE, CULL_SUB_AUTO } from '../../../constants/strings'
import { deleteMatching } from '../../../data/cache'

const ROW: CullReviewRow = {
  image_key: 'filtered-one',
  filename: 'DSCF4401.RAF',
  date_taken: '2026-09-11',
  filtered_by: 'culling_profile',
  score_forecast_p8: 0.05,
  profile: { slug: 'default', name: 'Default culling profile', level_sets: [] },
  completion: 'none',
  needs_send_work: true,
  thumbnail_url: '/thumb.jpg',
}

describe('CullReviewTab', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    vi.spyOn(CullAPI, 'summary').mockResolvedValue({
      not_passed_count: 1204,
      sent_manually_count: 0,
      tab_counts: { all: 1204, culling_profile: 83, score_forecast: 1121 },
      last_checked_at: null,
    })
    vi.spyOn(CullAPI, 'listPhotos').mockResolvedValue({ data: [ROW], total: 1, limit: 50, offset: 0 })
    const ok = { on: true, problem: null, model: 'culling-model', endpoint: 'this_app', job_id: null, detail: null }
    vi.spyOn(CullingModelsAPI, 'usable').mockResolvedValue({ culling_profile: ok, score_forecast: ok, culling_profile_filter: true })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('says how many photos were filtered, and that one can be sent by hand', async () => {
    render(<CullReviewTab />)
    expect(await screen.findByRole('heading', { name: '1204 photos filtered' })).toBeInTheDocument()
    expect(screen.getByText(CULL_SUB_AUTO)).toBeInTheDocument()
    expect(CULL_SUB_AUTO).toBe('Filtered photos are not described or scored. Send one by hand to change that.')
  })

  it('names the tabs All, Culling profile and Score forecast', async () => {
    render(<CullReviewTab />)
    expect(await screen.findByRole('button', { name: 'All (1204)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Culling profile (83)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Score forecast (1121)' })).toBeInTheDocument()
  })

  it('records "agrees with the filter" for the selected photos', async () => {
    const record = vi.spyOn(CullAPI, 'recordAction').mockResolvedValue({ ok: true } as never)
    render(<CullReviewTab />)
    fireEvent.click(await screen.findByLabelText('Select DSCF4401.RAF'))
    fireEvent.click(screen.getByRole('button', { name: CULL_AGREE }))
    await waitFor(() => expect(record).toHaveBeenCalledWith('filtered-one', 'agrees_with_filter'))
  })
})
