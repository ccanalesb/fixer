import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react'
import {
  CullAPI,
  CullingModelsAPI,
  CullingProfilesAPI,
  type CullingModelsUsable,
  type CullingStageUsability,
  type CullReviewRow,
} from '../../../services/api'
import { CullReviewTab } from '../CullReviewTab'
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
const broken = (problem: CullingStageUsability['problem'], extra: Partial<CullingStageUsability> = {}) => ({
  ...ok('model-x'),
  problem,
  ...extra,
})
const usable = (u: Partial<CullingModelsUsable> = {}): CullingModelsUsable => ({
  culling_profile: ok('culling-model'),
  score_forecast: ok('forecast-model'),
  culling_profile_filter: true,
  ...u,
})

const renderTab = () =>
  render(
    <MemoryRouter>
      <CullReviewTab />
    </MemoryRouter>,
  )

const HEADING = '1204 photos filtered'
let usableSpy: MockInstance<[], Promise<CullingModelsUsable>>

describe('CullReviewTab: culling stages that cannot run', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    vi.spyOn(CullAPI, 'summary').mockResolvedValue({
      not_passed_count: 1204,
      sent_manually_count: 0,
      tab_counts: { all: 1204, culling_profile: 83, score_forecast: 1121 },
      last_checked_at: null,
    })
    vi.spyOn(CullAPI, 'listPhotos').mockResolvedValue({ data: [ROW], total: 1, limit: 50, offset: 0 })
    usableSpy = vi.spyOn(CullingModelsAPI, 'usable').mockResolvedValue(usable())
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('says it is checking until the backend answers, then shows the list', async () => {
    let answer: (u: CullingModelsUsable) => void = () => {}
    usableSpy.mockReturnValue(new Promise((r) => (answer = r)))
    renderTab()
    expect(screen.getByText('Checking culling models…')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: HEADING })).not.toBeInTheDocument()
    answer(usable())
    expect(await screen.findByRole('heading', { name: HEADING })).toBeInTheDocument()
  })

  it('culling profile off: a page note with Open Settings, no list', async () => {
    usableSpy.mockResolvedValue(usable({ culling_profile: { ...ok('culling-model'), on: false } }))
    renderTab()
    expect(await screen.findByText('Culling profile is off.')).toBeInTheDocument()
    expect(
      screen.getByText('Photos get no stars or reject, and only the Score forecast (if on) filters before the big model.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open Settings' })).toHaveAttribute(
      'href',
      '/processing?tab=settings#stage-culling_profile',
    )
    expect(screen.queryByRole('heading', { name: HEADING })).not.toBeInTheDocument()
  })

  it.each([
    ['no_model', {}, 'The culling profile is on but has no model.'],
    ['parked', { provider_name: 'Studio GPU' }, 'Studio GPU is parked.'],
    ['removed', {}, 'Its endpoint was removed.'],
  ] as const)('culling profile %s: a page note in place of the list', async (problem, extra, text) => {
    usableSpy.mockResolvedValue(usable({ culling_profile: broken(problem, extra) }))
    renderTab()
    expect(await screen.findByText(text)).toBeInTheDocument()
    expect(screen.getByText('Fix it in Providers, or turn the culling profile off.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open Providers' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Turn culling profile off' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: HEADING })).not.toBeInTheDocument()
  })

  it('culling profile converting: View job only', async () => {
    usableSpy.mockResolvedValue(usable({ culling_profile: broken('converting', { job_id: 'install-1' }) }))
    renderTab()
    expect(await screen.findByText("The culling profile's model is still converting.")).toBeInTheDocument()
    expect(screen.getByText('It can be used once the conversion job finishes.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View job' })).toHaveAttribute('href', '/processing?tab=jobs')
    expect(screen.queryByRole('button', { name: 'Turn culling profile off' })).not.toBeInTheDocument()
  })

  it('"Turn culling profile off" saves the switch and the page says it is off', async () => {
    const save = vi.spyOn(CullingProfilesAPI, 'saveCullingProfileSwitches').mockResolvedValue({ version: 2, redecide_job_id: null })
    usableSpy.mockResolvedValueOnce(usable({ culling_profile: broken('no_model') }))
    usableSpy.mockResolvedValueOnce(usable({ culling_profile: { ...ok('culling-model'), on: false } }))
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Turn culling profile off' }))
    expect(await screen.findByText('Culling profile is off.')).toBeInTheDocument()
    expect(save).toHaveBeenCalledWith({ enabled: false })
  })

  it.each([
    ['no_model', 'Score forecast is on but has no model.'],
    ['converting', 'Score forecast is on but its model is still converting.'],
    ['parked', 'Score forecast is on but Studio GPU is parked.'],
    ['removed', 'Score forecast is on but its endpoint was removed.'],
    ['no_questions', 'Score forecast is on but has no questions yet.'],
  ] as const)('Score forecast %s: a warning above the list', async (problem, text) => {
    usableSpy.mockResolvedValue(
      usable({
        score_forecast: broken(problem, problem === 'parked' ? { provider_name: 'Studio GPU' } : {}),
      }),
    )
    renderTab()
    const warning = (await screen.findByText(text)).closest('[role="alert"]') as HTMLElement
    if (problem === 'no_questions') {
      expect(within(warning).getByRole('link', { name: 'Open Settings' })).toHaveAttribute(
        'href',
        '/processing?tab=settings#stage-score_forecast',
      )
    } else if (problem === 'converting') {
      expect(within(warning).getByRole('link', { name: 'View job' })).toHaveAttribute('href', '/processing?tab=jobs')
    } else {
      expect(within(warning).getByRole('link', { name: 'Open Providers' })).toHaveAttribute(
        'href',
        '/processing?tab=providers#task-score_forecast',
      )
    }
    expect(within(warning).getByRole('button', { name: 'Turn Score forecast off' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: HEADING })).toBeInTheDocument()
  })

  it('"Turn Score forecast off" saves the switch and the warning goes', async () => {
    const save = vi.spyOn(CullingProfilesAPI, 'saveScoreForecast').mockResolvedValue({ version: 2, redecide_job_id: null })
    usableSpy.mockResolvedValueOnce(usable({ score_forecast: broken('no_model') }))
    usableSpy.mockResolvedValueOnce(usable({ score_forecast: { ...ok('forecast-model'), on: false } }))
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Turn Score forecast off' }))
    await waitFor(() => expect(screen.queryByText('Score forecast is on but has no model.')).not.toBeInTheDocument())
    expect(save).toHaveBeenCalledWith({ enabled: false })
  })

  it('sending by hand asks first while a stage that is on cannot run', async () => {
    const send = vi.spyOn(CullAPI, 'sendPhotos').mockResolvedValue({ sent_by_hand: ['filtered-one'], job_id: 'j', skipped_complete: 0 })
    const save = vi.spyOn(CullingProfilesAPI, 'saveScoreForecast').mockResolvedValue({ version: 2, redecide_job_id: null })
    usableSpy.mockResolvedValue(usable({ score_forecast: broken('no_model') }))
    renderTab()
    fireEvent.click(await screen.findByLabelText('Select DSCF4401.RAF'))
    fireEvent.click(screen.getByRole('button', { name: /^Send 1/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Score forecast has no model' })
    expect(
      within(dialog).getByText(
        "Sending starts a job that runs the Score forecast first. Fix it, or turn the Score forecast off and send without it. Without it, the culling profile's rule decides what goes to the big model.",
      ),
    ).toBeInTheDocument()
    expect(send).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off and send' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith(['filtered-one']))
    expect(save).toHaveBeenCalledWith({ enabled: false })
  })
})
