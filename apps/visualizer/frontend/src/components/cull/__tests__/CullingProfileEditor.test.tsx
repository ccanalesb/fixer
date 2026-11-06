import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { CullingProfileEditor } from '../CullingProfileEditor'
import { ApiRequestError, ConfigAPI } from '../../../services/api'
import { deleteMatching } from '../../../data/cache'
import type { CullingModelsUsable, CullingStageUsability } from '../../../services/api'
import {
  CULL_PROFILE_ADD_LEVEL,
  CULL_PROFILE_ADD_LEVEL_SET_BUTTON,
  CULL_PROFILE_ADD_LEVEL_TOP,
  CULL_PROFILE_ACTIVATE,
  CULL_PROFILE_CREATE,
  CULL_PROFILE_DEACTIVATE,
  CULL_PROFILE_DEACTIVATE_CONFIRM,
  CULL_PROFILE_DEACTIVATE_CONFIRM_TITLE,
  CULL_PROFILE_QUESTION,
  CULL_PROFILE_REMOVE,
  CULL_PROFILE_REMOVE_SET,
  CULL_PROFILE_TAB_LEVELS,
  CULL_PROFILE_TAB_RULE,
  CULL_PROFILE_TEXT_SAVE_IMPACT,
  CULL_SAVE,
  CULL_RULE_SAVE_CONFIRM,
  CULL_RULE_SAVE_CONFIRM_TITLE,
  CULL_SAVE_AND_QUEUE,
  CULL_SAVE_ONLY,
  CULL_RULE_COMBINE_ARIA,
  CULL_RULE_LEVEL_ARIA,
  CULL_RULE_SUBJECT_ARIA,
  CULL_RULE_UNLESS_HIGH,
  CULLING_CANCEL,
  CULLING_MODELS_SAVED,
  CULLING_MODELS_SAVED_JOB_WAITING,
  CULLING_MODELS_VIEW_QUEUE,
  LR_WRITEBACK_STARS_STRONG_FROM_HELP_FOLDER,
} from '../../../constants/strings'

const saveDefinition = vi.fn()
const saveRule = vi.fn()
const patch = vi.fn()
const mockUsable = vi.fn()

vi.mock('../../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/api')>()
  return {
    ...actual,
    ConfigAPI: {
      ...actual.ConfigAPI,
      getCatalog: vi.fn().mockResolvedValue({
        catalog_path: '/tmp/test.lrcat',
        resolved_path: '/tmp/test.lrcat',
        exists: true,
        catalog_kind: 'lightroom',
        photo_count: 0,
        folder_count: null,
        unreadable_directories: [],
        picker_available: false,
      }),
    },
    CullingModelsAPI: { ...actual.CullingModelsAPI, usable: () => mockUsable() },
    CullingProfilesAPI: {
      ...actual.CullingProfilesAPI,
      saveDefinition: (...args: unknown[]) => saveDefinition(...args),
      saveRule: (...args: unknown[]) => saveRule(...args),
      patch: (...args: unknown[]) => patch(...args),
      saveCullingProfileSwitches: vi.fn().mockResolvedValue({ version: 2, redecide_job_id: null }),
      saveScoreForecast: vi.fn().mockResolvedValue({ version: 2, redecide_job_id: null }),
    },
  }
})

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

const baseProfile = {
  slug: 'default',
  name: 'Default culling profile',
  model: 'culling-model',
  active: true,
  measured: true,
  version: 1,
  in_pipeline: true,
  pipeline_order: 0,
  definition: {
    dimensions: [
      { slug: 'impact', name: 'Impact', question: 'q1' },
      { slug: 'tension', name: 'Tension', question: 'q2' },
    ],
    level_sets: [
      {
        id: '5',
        levels: { impact: ['i1', 'i2', 'i3', 'i4', 'i5'], tension: ['t1', 't2', 't3', 't4', 't5'] },
      },
    ],
  },
  rule: {
    level_sets: { '5': { fails_at_most: 2, strong_at_least: 4 } },
    combine: 'any' as const,
    filter_rule: { type: 'all_fail' as const, dimensions: ['impact'] },
  },
}

const editQuestion = () =>
  fireEvent.change(screen.getAllByLabelText(CULL_PROFILE_QUESTION)[0]!, { target: { value: 'changed' } })
const openLevels = () => fireEvent.click(screen.getByRole('tab', { name: CULL_PROFILE_TAB_LEVELS }))
const openRule = () => fireEvent.click(screen.getByRole('tab', { name: CULL_PROFILE_TAB_RULE }))

describe('CullingProfileEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUsable.mockResolvedValue(usable())
    patch.mockResolvedValue({ profile: baseProfile, pipeline_setting_version: 3, redecide_job_id: 'job-1' })
    saveRule.mockResolvedValue({ profile: baseProfile, pipeline_setting_version: 3, redecide_job_id: 'job-1' })
    saveDefinition.mockResolvedValue({
      profile: baseProfile,
      version: 2,
      created: true,
      impact: { photos: 40, hours_estimate: 0.02 },
      cull_job_id: null,
    })
  })

  it('enables Save only once the text changes and shows the hours impact', async () => {
    render(<CullingProfileEditor profile={baseProfile} />)
    expect(screen.getByRole('button', { name: CULL_SAVE_ONLY })).toBeDisabled()
    editQuestion()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: CULL_SAVE_ONLY }))
    })
    await waitFor(() => {
      expect(screen.getByText(CULL_PROFILE_TEXT_SAVE_IMPACT(40, 0.02))).toBeInTheDocument()
    })
    expect(saveDefinition.mock.calls[0]![1]).not.toHaveProperty('rule')
  })

  it('the Rule tab has no Score forecast threshold: it lives in Settings → Culling models', () => {
    render(<CullingProfileEditor profile={baseProfile} />)
    openRule()
    expect(screen.getByRole('combobox', { name: CULL_RULE_SUBJECT_ARIA })).toBeInTheDocument()
    expect(screen.queryByText(/score forecast/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /advanced/i })).not.toBeInTheDocument()
  })

  it('says the stars go into the photo files on a folder catalog', async () => {
    deleteMatching(() => true)
    vi.mocked(ConfigAPI.getCatalog).mockResolvedValueOnce({
      catalog_path: '/tmp/photos',
      resolved_path: '/tmp/photos',
      exists: true,
      catalog_kind: 'folder',
      photo_count: 0,
      folder_count: 0,
      unreadable_directories: [],
      picker_available: false,
    })
    render(<CullingProfileEditor profile={baseProfile} />)
    openRule()
    expect(await screen.findByText(LR_WRITEBACK_STARS_STRONG_FROM_HELP_FOLDER)).toBeInTheDocument()
    deleteMatching(() => true)
  })

  it('surfaces validation_errors on fields', async () => {
    saveDefinition.mockRejectedValue(new ApiRequestError('bad', [{ field: '5|impact', message: 'Too short' }]))
    render(<CullingProfileEditor profile={baseProfile} />)
    editQuestion()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: CULL_SAVE_ONLY }))
    })
    await waitFor(() => {
      expect(screen.getAllByText('Too short').length).toBeGreaterThan(0)
    })
  })

  it('adds a level only when every dimension has text, then saves it for all dimensions', async () => {
    render(<CullingProfileEditor profile={baseProfile} />)
    openLevels()
    fireEvent.click(screen.getByRole('button', { name: CULL_PROFILE_ADD_LEVEL_TOP }))
    const add = screen.getByRole('button', { name: CULL_PROFILE_ADD_LEVEL })
    expect(add).toBeDisabled()
    const fields = screen.getAllByPlaceholderText('What level 6 looks like')
    fireEvent.change(fields[0]!, { target: { value: 'i6' } })
    expect(add).toBeDisabled()
    fireEvent.change(fields[1]!, { target: { value: 't6' } })
    fireEvent.click(add)
    expect(screen.getByRole('status')).toHaveTextContent('Added level 6 to all 2 dimensions.')
    expect(screen.getByText('6 levels')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: CULL_SAVE_ONLY }))
    })
    const body = saveDefinition.mock.calls[0]![1] as typeof baseProfile
    expect(body.definition.level_sets[0]!.levels).toEqual({
      impact: ['i1', 'i2', 'i3', 'i4', 'i5', 'i6'],
      tension: ['t1', 't2', 't3', 't4', 't5', 't6'],
    })
  })

  it('creates a level set named by its count and saves its bands with the definition', async () => {
    render(<CullingProfileEditor profile={baseProfile} />)
    openLevels()
    fireEvent.click(screen.getByRole('button', { name: CULL_PROFILE_ADD_LEVEL_SET_BUTTON }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Levels' }), { target: { value: '5' } })
    expect(screen.getByText('There is already a level set 5.')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Levels' }), { target: { value: '3' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Start from' }), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: CULL_PROFILE_CREATE }))

    expect(screen.getByRole('status')).toHaveTextContent('Created level set 3 with 3 levels copied from set 5.')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: CULL_SAVE_ONLY }))
    })
    const body = saveDefinition.mock.calls[0]![1] as {
      definition: typeof baseProfile.definition
      rule: { level_sets: Record<string, unknown> }
    }
    expect(body.definition.level_sets.map((s) => s.id)).toEqual(['5', '3'])
    expect(body.rule.level_sets['3']).toEqual({ fails_at_most: 1, strong_at_least: 2 })
  })

  it('blocks saving while a new set has empty levels', () => {
    render(<CullingProfileEditor profile={baseProfile} />)
    openLevels()
    fireEvent.click(screen.getByRole('button', { name: CULL_PROFILE_ADD_LEVEL_SET_BUTTON }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Levels' }), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: CULL_PROFILE_CREATE }))
    expect(screen.getByText('4 empty level texts — fill them to save.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: CULL_SAVE_ONLY })).toBeDisabled()
  })

  it('asks before removing a level set and keeps the last one', () => {
    render(<CullingProfileEditor profile={baseProfile} />)
    openLevels()
    expect(screen.getByRole('button', { name: CULL_PROFILE_REMOVE_SET('5') })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: CULL_PROFILE_ADD_LEVEL_SET_BUTTON }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Levels' }), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: CULL_PROFILE_CREATE }))
    fireEvent.click(screen.getByRole('button', { name: CULL_PROFILE_REMOVE_SET('2') }))
    const dialog = screen.getByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: CULL_PROFILE_REMOVE }))
    expect(screen.getByRole('status')).toHaveTextContent('Removed level set 2.')
    expect(screen.getByRole('button', { name: CULL_PROFILE_REMOVE_SET('5') })).toBeDisabled()
  })

  const renderInRouter = () =>
    render(
      <MemoryRouter>
        <CullingProfileEditor profile={baseProfile} />
      </MemoryRouter>,
    )
  const dialog = () => screen.getByRole('dialog')

  it('asks before saving the rule; Cancel saves nothing', () => {
    renderInRouter()
    openRule()
    fireEvent.click(screen.getByRole('button', { name: CULL_SAVE }))
    expect(within(dialog()).getByText(CULL_RULE_SAVE_CONFIRM_TITLE)).toBeInTheDocument()
    fireEvent.click(within(dialog()).getByRole('button', { name: CULLING_CANCEL }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(saveRule).not.toHaveBeenCalled()
  })

  it('saves the rule on confirm and says the re-decide job is queued', async () => {
    renderInRouter()
    openRule()
    fireEvent.click(screen.getByRole('button', { name: CULL_SAVE }))
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole('button', { name: CULL_RULE_SAVE_CONFIRM }))
    })
    expect(saveRule).toHaveBeenCalledWith('default', baseProfile.rule)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText(CULLING_MODELS_SAVED)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: CULLING_MODELS_VIEW_QUEUE })).toBeInTheDocument()
  })

  it('asks before deactivating; a job already queued applies it', async () => {
    patch.mockResolvedValue({ profile: { ...baseProfile, active: false }, pipeline_setting_version: 3, redecide_job_id: null })
    renderInRouter()
    fireEvent.click(screen.getByRole('button', { name: CULL_PROFILE_DEACTIVATE }))
    expect(patch).not.toHaveBeenCalled()
    expect(within(dialog()).getByText(CULL_PROFILE_DEACTIVATE_CONFIRM_TITLE)).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole('button', { name: CULL_PROFILE_DEACTIVATE_CONFIRM }))
    })
    expect(patch).toHaveBeenCalledWith('default', { active: false })
    expect(screen.getByText(CULLING_MODELS_SAVED_JOB_WAITING)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: CULL_PROFILE_ACTIVATE })).toBeInTheDocument()
  })

  it('offers Save and apply on the Rule tab only, and the text saves on the others', () => {
    render(<CullingProfileEditor profile={baseProfile} />)
    expect(screen.queryByRole('button', { name: CULL_SAVE })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: CULL_SAVE_AND_QUEUE })).toBeInTheDocument()
    openRule()
    expect(screen.getByRole('button', { name: CULL_SAVE })).toBeEnabled()
    expect(screen.queryByRole('button', { name: CULL_SAVE_ONLY })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: CULL_SAVE_AND_QUEUE })).not.toBeInTheDocument()
  })

  it('writes the rule as a sentence and saves the choice', async () => {
    renderInRouter()
    openRule()
    expect(screen.queryByText(new RegExp(CULL_RULE_UNLESS_HIGH))).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: CULL_RULE_COMBINE_ARIA })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: CULL_RULE_SUBJECT_ARIA }), { target: { value: 'n2' } })
    expect(screen.getByText(new RegExp(CULL_RULE_UNLESS_HIGH))).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: CULL_SAVE }))
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole('button', { name: CULL_RULE_SAVE_CONFIRM }))
    })
    expect(saveRule.mock.calls[0]![1]).toMatchObject({ filter_rule: { type: 'n_fail_unless_strong', n: 2 } })
  })

  it('moves where low ends by clicking a level on the scale', async () => {
    renderInRouter()
    openRule()
    fireEvent.click(screen.getByRole('button', { name: CULL_RULE_LEVEL_ARIA(3, 5, null) }))
    expect(screen.getByRole('button', { name: CULL_RULE_LEVEL_ARIA(3, 5, 'low') })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: CULL_SAVE }))
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole('button', { name: CULL_RULE_SAVE_CONFIRM }))
    })
    expect(saveRule.mock.calls[0]![1]).toMatchObject({ level_sets: { '5': { fails_at_most: 3, strong_at_least: 4 } } })
  })

  it('shows and moves where high starts even when the rule does not use it', () => {
    render(<CullingProfileEditor profile={baseProfile} />)
    openRule()
    expect(screen.getByRole('button', { name: CULL_RULE_LEVEL_ARIA(4, 5, 'high') })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: CULL_RULE_LEVEL_ARIA(5, 5, 'high') }))
    expect(screen.getByRole('button', { name: CULL_RULE_LEVEL_ARIA(4, 5, null) })).toBeInTheDocument()
  })

  it('keeps low and high out of the Levels tab', () => {
    render(<CullingProfileEditor profile={baseProfile} />)
    openLevels()
    expect(screen.queryByRole('spinbutton', { name: /fails|strong/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: CULL_RULE_LEVEL_ARIA(1, 5, 'low') })).not.toBeInTheDocument()
  })

  it('Save and queue culling runs the gate; cancel sends no save', async () => {
    mockUsable.mockResolvedValue(usable({ culling_profile: broken('no_model', { model: null }) }))
    renderInRouter()
    editQuestion()
    fireEvent.click(screen.getByRole('button', { name: CULL_SAVE_AND_QUEUE }))
    const stageDialog = await screen.findByRole('dialog', { name: 'Culling profile has no model' })
    fireEvent.click(within(stageDialog).getByRole('button', { name: CULLING_CANCEL }))
    expect(saveDefinition).not.toHaveBeenCalled()
  })

  it('Save and queue culling saves when every stage that is on can run', async () => {
    renderInRouter()
    editQuestion()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: CULL_SAVE_AND_QUEUE }))
    })
    await waitFor(() => expect(saveDefinition).toHaveBeenCalledTimes(1))
    expect(saveDefinition.mock.calls[0]![1]).toMatchObject({ mode: 'save_and_queue_cull' })
  })
})
