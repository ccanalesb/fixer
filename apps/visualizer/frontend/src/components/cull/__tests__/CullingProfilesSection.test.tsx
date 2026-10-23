import { Suspense, act } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { CullingProfilesSection } from '../CullingProfilesSection'
import { CULL_ADD_PROFILE, CULL_PROFILES_SECTION } from '../../../constants/strings'

const expand = () => fireEvent.click(screen.getByRole('button', { name: new RegExp(CULL_PROFILES_SECTION) }))
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
    CullingProfilesAPI: {
      ...actual.CullingProfilesAPI,
      list: (...args: unknown[]) => apiMocks.list(...args),
      getPipeline: (...args: unknown[]) => apiMocks.getPipeline(...args),
      get: (...args: unknown[]) => apiMocks.get(...args),
      create: (...args: unknown[]) => apiMocks.create(...args),
    },
  }
})

describe('CullingProfilesSection', () => {
  beforeEach(() => {
    localStorage.clear()
    deleteMatching(() => true)
    vi.clearAllMocks()
    apiMocks.list.mockResolvedValue({
      profiles: [
        {
          slug: 'default',
          name: 'Default culling profile',
          model: 'culling-model',
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
      config: {
        culling_profiles_enabled: true,
        culling_profiles_filter_enabled: true,
        score_forecast: { threshold: 0.111, enabled: true, high_from_level: 8, excused_at: 1 },
        culling_profiles: [],
      },
    })
    apiMocks.get.mockResolvedValue({
      slug: 'default',
      name: 'Default culling profile',
      model: 'culling-model',
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
        filter_rule: { type: 'all_fail', dimensions: ['dimension-1'] },
      },
    })
  })

  it('add profile creates minimal F19 profile and selects it', async () => {
    apiMocks.create.mockResolvedValue({
      slug: 'profile-new',
      name: 'New profile',
      model: 'culling-model',
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
        filter_rule: { type: 'all_fail', dimensions: ['dimension-1'] },
      },
    })
    apiMocks.list.mockResolvedValue({
      profiles: [
        {
          slug: 'default',
          name: 'Default culling profile',
          model: 'culling-model',
          active: true,
          measured: true,
          version: 1,
          in_pipeline: true,
          pipeline_order: 0,
        },
        {
          slug: 'profile-new',
          name: 'New profile',
          model: 'culling-model',
          active: false,
          measured: false,
          version: 1,
          in_pipeline: false,
          pipeline_order: null,
        },
      ],
    })
    apiMocks.get.mockImplementation((slug: string) =>
      slug === 'profile-new'
        ? Promise.resolve(apiMocks.create.mock.results[0]?.value)
        : Promise.resolve({
            slug: 'default',
            name: 'Default culling profile',
            model: 'culling-model',
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
              filter_rule: { type: 'all_fail', dimensions: ['dimension-1'] },
            },
          }),
    )

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <CullingProfilesSection />
        </Suspense>,
      )
    })
    await waitFor(() => expect(screen.getByText(/Default culling profile active/)).toBeInTheDocument())
    expand()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: CULL_ADD_PROFILE }))
    })
    await waitFor(() => {
      expect(apiMocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: expect.stringMatching(/^profile-\d+$/),
          definition: expect.objectContaining({
            level_sets: [expect.objectContaining({ id: '5' })],
          }),
        }),
      )
      expect(screen.getByText('New profile')).toBeInTheDocument()
    })
  })

  it('starts folded to its summary and remembers being opened', async () => {
    const mount = async () => {
      let view: ReturnType<typeof render> | undefined
      await act(async () => {
        view = render(
          <Suspense fallback={null}>
            <CullingProfilesSection />
          </Suspense>,
        )
      })
      return view!
    }
    const first = await mount()
    await waitFor(() => expect(screen.getByText(/1 profile · Default culling profile active/)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: CULL_ADD_PROFILE })).not.toBeInTheDocument()
    expand()
    expect(screen.getByRole('button', { name: CULL_ADD_PROFILE })).toBeInTheDocument()
    first.unmount()

    await mount()
    await waitFor(() => expect(screen.getByRole('button', { name: CULL_ADD_PROFILE })).toBeInTheDocument())
  })
})
