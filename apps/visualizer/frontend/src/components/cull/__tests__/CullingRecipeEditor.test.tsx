import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { CullingRecipeEditor } from '../CullingRecipeEditor'
import { ApiRequestError } from '../../../services/api'
import { CULL_SAVE_ONLY, CULL_RECIPE_TEXT_SAVE_IMPACT } from '../../../constants/strings'

const saveDefinition = vi.fn()
const saveRule = vi.fn()
const patch = vi.fn()

vi.mock('../../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/api')>()
  return {
    ...actual,
    CullingRecipesAPI: {
      ...actual.CullingRecipesAPI,
      saveDefinition: (...args: unknown[]) => saveDefinition(...args),
      saveRule: (...args: unknown[]) => saveRule(...args),
      patch: (...args: unknown[]) => patch(...args),
    },
  }
})

const baseRecipe = {
  slug: 'recipe-7h47',
  name: 'Recipe 7H47',
  model: 'laya-base',
  active: true,
  measured: true,
  version: 1,
  in_pipeline: true,
  pipeline_order: 0,
  definition: {
    dimensions: [{ slug: 'dimension-1', name: 'Dimension 1', question: '' }],
    level_sets: [{ id: '5', levels: { 'dimension-1': ['a', 'b', 'c', 'd', 'e'] } }],
  },
  rule: {
    level_sets: { '5': { fails_at_most: 2, strong_at_least: 4 } },
    combine: 'any' as const,
    cut_rule: { type: 'all_fail' as const, dimensions: ['dimension-1'] },
  },
}

describe('CullingRecipeEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    patch.mockResolvedValue(baseRecipe)
    saveRule.mockResolvedValue({ recipe: baseRecipe })
  })

  it('shows hours impact after save_only returns JSON impact', async () => {
    saveDefinition.mockResolvedValue({
      recipe: baseRecipe,
      version: 2,
      created: true,
      impact: { photos: 40, hours_estimate: 0.02 },
      cull_job_id: null,
    })
    render(<CullingRecipeEditor recipe={baseRecipe} onRefresh={() => {}} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: CULL_SAVE_ONLY }))
    })
    await waitFor(() => {
      expect(screen.getByText(CULL_RECIPE_TEXT_SAVE_IMPACT(40, 0.02))).toBeInTheDocument()
    })
  })

  it('surfaces validation_errors on fields', async () => {
    saveDefinition.mockRejectedValue(
      new ApiRequestError('bad', [{ field: '5|dimension-1', message: 'Too short' }]),
    )
    render(<CullingRecipeEditor recipe={baseRecipe} onRefresh={() => {}} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: CULL_SAVE_ONLY }))
    })
    await waitFor(() => {
      expect(screen.getByText('Too short')).toBeInTheDocument()
    })
  })
})
