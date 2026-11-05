import { Suspense } from 'react'
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteMatching } from '../../data/cache'
import { ProvidersAPI } from '../../services/api'
import { useProviderModels } from '../useProviders'

const fetchMock = vi.fn()
globalThis.fetch = fetchMock

function okJson(body: unknown) {
  return { ok: true, json: async () => body }
}

function ModelNames({ providerId }: { providerId: string }) {
  const { models } = useProviderModels(providerId)
  return <p>{models.map((m) => m.id).join(',') || 'none'}</p>
}

function modelListCalls(providerId: string): number {
  return fetchMock.mock.calls.filter(
    ([url, init]) =>
      String(url).endsWith(`/providers/${providerId}/models`) && (init?.method ?? 'GET') === 'GET',
  ).length
}

const MUTATIONS: [string, () => Promise<unknown>][] = [
  ['addModel', () => ProvidersAPI.addModel('p1', { id: 'm2', name: 'M2', vision: true })],
  ['removeModel', () => ProvidersAPI.removeModel('p1', 'm1')],
  ['reorderModels', () => ProvidersAPI.reorderModels('p1', ['m2', 'm1'])],
  ['updateModelName', () => ProvidersAPI.updateModelName('p1', 'm1', 'Renamed')],
]

describe('an open model picker after a model change', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    fetchMock.mockReset()
  })

  it.each(MUTATIONS)('refetches the provider models after %s', async (_name, mutate) => {
    fetchMock.mockResolvedValueOnce(okJson([{ id: 'm1', name: 'M1', vision: true }]))
    await act(async () => {
      render(
        <Suspense fallback={<p>loading</p>}>
          <ModelNames providerId="p1" />
        </Suspense>,
      )
    })
    expect(screen.getByText('m1')).toBeInTheDocument()
    expect(modelListCalls('p1')).toBe(1)

    fetchMock.mockResolvedValueOnce(okJson({}))
    fetchMock.mockResolvedValue(okJson([{ id: 'm2', name: 'M2', vision: true }]))
    await act(async () => {
      await mutate()
    })

    expect(modelListCalls('p1')).toBe(2)
    expect(await screen.findByText('m2')).toBeInTheDocument()
  })
})
