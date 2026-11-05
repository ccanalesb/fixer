import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { CullAPI, CullingModelsAPI, type CullReviewRow, type CullingStageUsability } from '../../../services/api'
import { cullingChanged } from '../../../data/keys'
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

const ok = (model: string): CullingStageUsability => ({
  on: true,
  problem: null,
  model,
  endpoint: 'this_app',
  job_id: null,
  provider_name: null,
})
const broken = (problem: CullingStageUsability['problem']) => ({ ...ok('forecast-model'), problem })

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
    const ok = { on: true, problem: null, model: 'culling-model', endpoint: 'this_app', job_id: null, provider_name: null }
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

  it('records "agrees with the filter" for the selected photos and refetches summary and list', async () => {
    const record = vi.spyOn(CullAPI, 'recordAction').mockImplementation(async () => {
      cullingChanged()
      return { ok: true }
    })
    render(<CullReviewTab />)
    await waitFor(() => expect(CullAPI.summary).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(CullAPI.listPhotos).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByLabelText('Select DSCF4401.RAF'))
    fireEvent.click(screen.getByRole('button', { name: CULL_AGREE }))
    await waitFor(() => expect(record).toHaveBeenCalledWith('filtered-one', 'agrees_with_filter'))
    await waitFor(() => expect(CullAPI.summary).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(CullAPI.listPhotos).toHaveBeenCalledTimes(2))
  })

  it('opens the gate dialog when sending and a stage that is on cannot run', async () => {
    vi.spyOn(CullingModelsAPI, 'usable').mockResolvedValue({
      culling_profile: ok('culling-model'),
      score_forecast: broken('no_model'),
      culling_profile_filter: true,
    })
    const send = vi.spyOn(CullAPI, 'sendPhotos').mockResolvedValue({ sent_by_hand: [], job_id: 'j', skipped_complete: 0 })
    render(
      <MemoryRouter>
        <CullReviewTab />
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByLabelText('Select DSCF4401.RAF'))
    fireEvent.click(screen.getByRole('button', { name: /^Send 1/ }))
    expect(await screen.findByRole('dialog', { name: 'Score forecast has no model' })).toBeInTheDocument()
    expect(send).not.toHaveBeenCalled()
  })

  it('queues send when every stage that is on can run', async () => {
    const send = vi.spyOn(CullAPI, 'sendPhotos').mockResolvedValue({ sent_by_hand: ['filtered-one'], job_id: 'j', skipped_complete: 0 })
    render(
      <MemoryRouter>
        <CullReviewTab />
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByLabelText('Select DSCF4401.RAF'))
    fireEvent.click(screen.getByRole('button', { name: /^Send 1/ }))
    await waitFor(() => expect(send).toHaveBeenCalledWith(['filtered-one']))
  })

  it('shows send errors from the gate when usable fails', async () => {
    vi.spyOn(CullingModelsAPI, 'usable').mockRejectedValue(new Error('cannot reach backend'))
    render(
      <MemoryRouter>
        <CullReviewTab />
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByLabelText('Select DSCF4401.RAF'))
    fireEvent.click(screen.getByRole('button', { name: /^Send 1/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot reach backend')
  })
})
