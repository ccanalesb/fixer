import { Suspense, act } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { CullingRecipesSection } from '../CullingRecipesSection'
import { CULL_ADD_RECIPE, CULL_RECIPES_SECTION } from '../../../constants/strings'
import { deleteMatching } from '../../../data/cache'

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  getPipeline: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
}))

vi.mock('../../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/api')>()
  return {
    ...actual,
    CullingRecipesAPI: {
      ...actual.CullingRecipesAPI,
      list: (...args: unknown[]) => apiMocks.list(...args),
      getPipeline: (...args: unknown[]) => apiMocks.getPipeline(...args),
      get: (...args: unknown[]) => apiMocks.get(...args),
      create: (...args: unknown[]) => apiMocks.create(...args),
    },
  }
})

describe('CullingRecipesSection', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    vi.clearAllMocks()
    apiMocks.list.mockResolvedValue({
      recipes: [
        {
          slug: 'recipe-7h47',
          name: 'Recipe 7H47',
          model: 'laya-base',
          active: true,
          measured: true,
          version: 1,
          in_pipeline: true,
          pipeline_order: 0,
        },
      ],
    })
    apiMocks.getPipeline.mockResolvedValue({
      version: 1,
      config: { score_forecast: { threshold: 0.111, enabled: true, high_from_level: 8, excused_at: 1, run_after_cut: true }, culling_recipes: [] },
    })
    apiMocks.get.mockResolvedValue({
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
        combine: 'any',
        cut_rule: { type: 'all_fail', dimensions: ['dimension-1'] },
      },
    })
  })

  it('add recipe creates minimal F19 recipe and selects it', async () => {
    apiMocks.create.mockResolvedValue({
      slug: 'recipe-new',
      name: 'New recipe',
      model: 'laya-base',
      active: false,
      measured: false,
      version: 1,
      in_pipeline: false,
      pipeline_order: null,
      definition: {
        dimensions: [{ slug: 'dimension-1', name: 'Dimension 1', question: '' }],
        level_sets: [{ id: '5', levels: { 'dimension-1': ['', '', '', '', ''] } }],
      },
      rule: {
        level_sets: { '5': { fails_at_most: 2, strong_at_least: 4 } },
        combine: 'any',
        cut_rule: { type: 'all_fail', dimensions: ['dimension-1'] },
      },
    })
    apiMocks.list.mockResolvedValue({
      recipes: [
        {
          slug: 'recipe-7h47',
          name: 'Recipe 7H47',
          model: 'laya-base',
          active: true,
          measured: true,
          version: 1,
          in_pipeline: true,
          pipeline_order: 0,
        },
        {
          slug: 'recipe-new',
          name: 'New recipe',
          model: 'laya-base',
          active: false,
          measured: false,
          version: 1,
          in_pipeline: false,
          pipeline_order: null,
        },
      ],
    })
    apiMocks.get.mockImplementation((slug: string) =>
      slug === 'recipe-new'
        ? Promise.resolve(apiMocks.create.mock.results[0]?.value)
        : Promise.resolve({
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
              combine: 'any',
              cut_rule: { type: 'all_fail', dimensions: ['dimension-1'] },
            },
          }),
    )

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <CullingRecipesSection />
        </Suspense>,
      )
    })
    await waitFor(() => expect(screen.getByText('Recipe 7H47')).toBeInTheDocument())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: CULL_ADD_RECIPE }))
    })
    await waitFor(() => {
      expect(apiMocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: expect.stringMatching(/^recipe-\d+$/),
          definition: expect.objectContaining({
            level_sets: [expect.objectContaining({ id: '5' })],
          }),
        }),
      )
      expect(screen.getByText('New recipe')).toBeInTheDocument()
    })
  })

  it('renders the recipe list when pipeline loads', async () => {
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <CullingRecipesSection />
        </Suspense>,
      )
    })
    await waitFor(() => {
      expect(screen.getByText(CULL_RECIPES_SECTION)).toBeInTheDocument()
      expect(screen.getByText('Recipe 7H47')).toBeInTheDocument()
    })
  })
})
