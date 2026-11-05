import { describe, it, expect, vi, beforeEach } from 'vitest'
import { deleteMatching } from '../../data/cache'
import { keys } from '../../data/keys'
import { query } from '../../data/query'
import {
  AppModelsAPI,
  ConfigAPI,
  CullingModelsAPI,
  ImagesAPI,
  JobsAPI,
  PerspectivesAPI,
  ProvidersAPI,
} from '../api'

const fetchMock = vi.fn()
globalThis.fetch = fetchMock

function okJson(body: unknown) {
  return { ok: true, json: async () => body }
}

function catchThrown(fn: () => void): unknown {
  try {
    fn()
    return undefined
  } catch (e) {
    return e
  }
}

describe('mutation cache updates', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    vi.clearAllMocks()
  })

  it('PerspectivesAPI.create refetches the perspectives list query', async () => {
    fetchMock.mockResolvedValueOnce(okJson([]))
    const listKey = keys.perspectives.list()
    const p1 = catchThrown(() => query(listKey, () => PerspectivesAPI.list())) as Promise<unknown>
    await p1
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockResolvedValueOnce(okJson({ slug: 'street', display_name: 'Street', prompt_markdown: '# x' }))
    await PerspectivesAPI.create({
      slug: 'street',
      display_name: 'Street',
      prompt_markdown: '# x',
    })

    fetchMock.mockResolvedValueOnce(okJson([{ slug: 'street', display_name: 'Street', active: true }]))
    const p2 = catchThrown(() => query(listKey, () => PerspectivesAPI.list())) as Promise<unknown>
    await p2
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('ProvidersAPI.create refetches the providers hook bundle query', async () => {
    fetchMock
      .mockResolvedValueOnce(okJson([]))
      .mockResolvedValueOnce(okJson({ order: [] }))
    const bundleKey = keys.providers.hookBundle()
    const p1 = catchThrown(() =>
      query(bundleKey, async () => {
        const [providers, fallback] = await Promise.all([
          ProvidersAPI.list(),
          ProvidersAPI.getFallbackOrder(),
        ])
        return { providers, fallbackOrder: fallback.order }
      }),
    ) as Promise<unknown>
    await p1
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fetchMock.mockResolvedValueOnce(
      okJson({ id: 'p1', name: 'Local', base_url: 'http://x', protocol: 'openai', enabled: true }),
    )
    await ProvidersAPI.create({
      name: 'Local',
      base_url: 'http://x',
      auth: { mode: 'none' },
    })

    fetchMock
      .mockResolvedValueOnce(okJson([{ id: 'p1', name: 'Local' }]))
      .mockResolvedValueOnce(okJson({ order: [] }))
    const p2 = catchThrown(() =>
      query(bundleKey, async () => {
        const [providers, fallback] = await Promise.all([
          ProvidersAPI.list(),
          ProvidersAPI.getFallbackOrder(),
        ])
        return { providers, fallbackOrder: fallback.order }
      }),
    ) as Promise<unknown>
    await p2
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('JobsAPI.create refetches the jobs list query', async () => {
    const listKey = keys.jobs.list({ limit: 10, offset: 0 })
    fetchMock.mockResolvedValueOnce(
      okJson({
        total: 0,
        data: [],
        pagination: { offset: 0, limit: 10, current_page: 1, total_pages: 0, has_more: false },
      }),
    )
    const p1 = catchThrown(() => query(listKey, () => JobsAPI.list({ limit: 10, offset: 0 }))) as Promise<
      unknown
    >
    await p1
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockResolvedValueOnce(okJson({ id: 'j1', type: 'analyze', status: 'pending' }))
    await JobsAPI.create('analyze', {})

    fetchMock.mockResolvedValueOnce(
      okJson({
        total: 1,
        data: [{ id: 'j1', type: 'analyze', status: 'pending' }],
        pagination: { offset: 0, limit: 10, current_page: 1, total_pages: 1, has_more: false },
      }),
    )
    const p2 = catchThrown(() => query(listKey, () => JobsAPI.list({ limit: 10, offset: 0 }))) as Promise<
      unknown
    >
    await p2
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('ConfigAPI.putCatalog refetches catalog months query', async () => {
    const monthsKey = keys.images.catalogMonths()
    fetchMock.mockResolvedValueOnce(okJson({ months: ['2024-01'] }))
    const p1 = catchThrown(() => query(monthsKey, () => ImagesAPI.getCatalogMonths())) as Promise<unknown>
    await p1
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockResolvedValueOnce(okJson({ catalog_path: '/x.lrcat', exists: true }))
    await ConfigAPI.putCatalog('/x.lrcat', 'switch')

    fetchMock.mockResolvedValueOnce(okJson({ months: ['2024-01', '2024-02'] }))
    const p2 = catchThrown(() => query(monthsKey, () => ImagesAPI.getCatalogMonths())) as Promise<unknown>
    await p2
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('AppModelsAPI.add refetches the providers hook bundle query', async () => {
    fetchMock
      .mockResolvedValueOnce(okJson([]))
      .mockResolvedValueOnce(okJson({ order: [] }))
    const bundleKey = keys.providers.hookBundle()
    const p1 = catchThrown(() =>
      query(bundleKey, async () => {
        const [providers, fallback] = await Promise.all([
          ProvidersAPI.list(),
          ProvidersAPI.getFallbackOrder(),
        ])
        return { providers, fallbackOrder: fallback.order }
      }),
    ) as Promise<unknown>
    await p1

    fetchMock.mockResolvedValueOnce(okJson({ job_id: 'm1' }))
    await AppModelsAPI.add('/models/foo')

    fetchMock
      .mockResolvedValueOnce(okJson([]))
      .mockResolvedValueOnce(okJson({ order: [] }))
    const p2 = catchThrown(() =>
      query(bundleKey, async () => {
        const [providers, fallback] = await Promise.all([
          ProvidersAPI.list(),
          ProvidersAPI.getFallbackOrder(),
        ])
        return { providers, fallbackOrder: fallback.order }
      }),
    ) as Promise<unknown>
    await p2
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('CullingModelsAPI.save refetches the providers tab bundle query', async () => {
    fetchMock
      .mockResolvedValueOnce(okJson([]))
      .mockResolvedValueOnce(okJson({ order: [] }))
      .mockResolvedValueOnce(okJson({ description: null, scoring: null }))
      .mockResolvedValueOnce(okJson(null))
    const tabKey = keys.providers.tabBundle()
    const p1 = catchThrown(() =>
      query(tabKey, async () => {
        const [providerList, fallback, defaults] = await Promise.all([
          ProvidersAPI.list(),
          ProvidersAPI.getFallbackOrder(),
          ProvidersAPI.getDefaults(),
        ])
        return { providers: providerList, fallbackOrder: fallback.order, defaults }
      }),
    ) as Promise<unknown>
    await p1

    fetchMock.mockResolvedValueOnce(okJson({ endpoint: 'this_app', model: 'm' }))
    await CullingModelsAPI.save('culling_profile', { endpoint: 'this_app', model: 'm' })

    fetchMock
      .mockResolvedValueOnce(okJson([]))
      .mockResolvedValueOnce(okJson({ order: [] }))
      .mockResolvedValueOnce(okJson({ description: null, scoring: null }))
    const p2 = catchThrown(() =>
      query(tabKey, async () => {
        const [providerList, fallback, defaults] = await Promise.all([
          ProvidersAPI.list(),
          ProvidersAPI.getFallbackOrder(),
          ProvidersAPI.getDefaults(),
        ])
        return { providers: providerList, fallbackOrder: fallback.order, defaults }
      }),
    ) as Promise<unknown>
    await p2
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(7)
  })
})
