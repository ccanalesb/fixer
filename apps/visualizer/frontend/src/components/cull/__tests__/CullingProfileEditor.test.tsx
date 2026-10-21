import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { CullingProfileEditor } from '../CullingProfileEditor'
import { ApiRequestError } from '../../../services/api'
import {
  CULL_PROFILE_ADD_LEVEL,
  CULL_PROFILE_ADD_LEVEL_SET_BUTTON,
  CULL_PROFILE_ADD_LEVEL_TOP,
  CULL_PROFILE_CREATE,
  CULL_PROFILE_QUESTION,
  CULL_PROFILE_REMOVE,
  CULL_PROFILE_REMOVE_SET,
  CULL_PROFILE_TAB_LEVELS,
  CULL_PROFILE_TEXT_SAVE_IMPACT,
  CULL_SAVE,
  CULL_SAVE_ONLY,
} from '../../../constants/strings'

const saveDefinition = vi.fn()
const saveRule = vi.fn()
const patch = vi.fn()

vi.mock('../../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/api')>()
  return {
    ...actual,
    CullingProfilesAPI: {
      ...actual.CullingProfilesAPI,
      saveDefinition: (...args: unknown[]) => saveDefinition(...args),
      saveRule: (...args: unknown[]) => saveRule(...args),
      patch: (...args: unknown[]) => patch(...args),
      getPipeline: () => Promise.resolve({ version: 1, config: { score_forecast: { threshold: 0.1 } } }),
    },
  }
})

const baseProfile = {
  slug: 'recipe-culling',
  name: 'Recipe culling',
  model: 'laya-base',
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

describe('CullingProfileEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    patch.mockResolvedValue(baseProfile)
    saveRule.mockResolvedValue({ profile: baseProfile })
    saveDefinition.mockResolvedValue({
      profile: baseProfile,
      version: 2,
      created: true,
      impact: { photos: 40, hours_estimate: 0.02 },
      cull_job_id: null,
    })
  })

  it('enables Save only once the text changes and shows the hours impact', async () => {
    render(<CullingProfileEditor profile={baseProfile} onRefresh={() => {}} />)
    expect(screen.getByRole('button', { name: CULL_SAVE_ONLY })).toBeDisabled()
    editQuestion()
    expect(screen.getByRole('button', { name: CULL_SAVE })).toBeDisabled()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: CULL_SAVE_ONLY }))
    })
    await waitFor(() => {
      expect(screen.getByText(CULL_PROFILE_TEXT_SAVE_IMPACT(40, 0.02))).toBeInTheDocument()
    })
    expect(saveDefinition.mock.calls[0]![1]).not.toHaveProperty('rule')
  })

  it('surfaces validation_errors on fields', async () => {
    saveDefinition.mockRejectedValue(new ApiRequestError('bad', [{ field: '5|impact', message: 'Too short' }]))
    render(<CullingProfileEditor profile={baseProfile} onRefresh={() => {}} />)
    editQuestion()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: CULL_SAVE_ONLY }))
    })
    await waitFor(() => {
      expect(screen.getAllByText('Too short').length).toBeGreaterThan(0)
    })
  })

  it('adds a level only when every dimension has text, then saves it for all dimensions', async () => {
    render(<CullingProfileEditor profile={baseProfile} onRefresh={() => {}} />)
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
    render(<CullingProfileEditor profile={baseProfile} onRefresh={() => {}} />)
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
    render(<CullingProfileEditor profile={baseProfile} onRefresh={() => {}} />)
    openLevels()
    fireEvent.click(screen.getByRole('button', { name: CULL_PROFILE_ADD_LEVEL_SET_BUTTON }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Levels' }), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: CULL_PROFILE_CREATE }))
    expect(screen.getByText('4 empty level texts — fill them to save.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: CULL_SAVE_ONLY })).toBeDisabled()
  })

  it('asks before removing a level set and keeps the last one', () => {
    render(<CullingProfileEditor profile={baseProfile} onRefresh={() => {}} />)
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
})
