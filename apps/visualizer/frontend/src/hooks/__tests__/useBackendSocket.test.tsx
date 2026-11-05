import { Suspense } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteMatching } from '../../data/cache'
import { useQuery } from '../../data'
import { keys } from '../../data/keys'
import { useSocketStore } from '../../stores/socketStore'
import { useBackendSocket } from '../useBackendSocket'

const handlers: Record<string, (payload: unknown) => void> = {}
const socket = {
  on: (event: string, fn: (payload: unknown) => void) => {
    handlers[event] = fn
  },
  off: vi.fn(),
}

function BackendSocketShell({ children }: { children: React.ReactNode }) {
  useBackendSocket()
  return children
}

function SummaryProbe({ fetchSummary }: { fetchSummary: () => Promise<unknown> }) {
  const value = useQuery(keys.cull.summary(), fetchSummary, { initialValue: { ok: true } })
  return <div>{String(value)}</div>
}

function LrPhotoProbe({ fetchPhoto }: { fetchPhoto: () => Promise<unknown> }) {
  const value = useQuery(keys.lrWriteback.photo('k'), fetchPhoto, { initialValue: { rating: { live: 3 } } })
  return <div data-testid="lr-photo">{String((value as { rating?: { live?: number } }).rating?.live)}</div>
}

function KeyProbe({ queryKey, fetch }: { queryKey: readonly unknown[]; fetch: () => Promise<unknown> }) {
  const value = useQuery(queryKey, fetch, { initialValue: null })
  return <div>{String(value)}</div>
}

function renderProbe(queryKey: readonly unknown[], fetch: () => Promise<unknown>) {
  render(
    <BackendSocketShell>
      <Suspense fallback={null}>
        <KeyProbe queryKey={queryKey} fetch={fetch} />
      </Suspense>
    </BackendSocketShell>,
  )
}

beforeEach(() => {
  deleteMatching(() => true)
  delete handlers.job_updated
  delete handlers.job_created
  useSocketStore.setState({ socket: socket as never, connected: true, connect: () => {} })
})

describe('useBackendSocket', () => {
  it('refetches cull.summary when a culling job finishes', async () => {
    let n = 0
    const fetchSummary = vi.fn().mockImplementation(() => Promise.resolve({ pass: ++n }))

    render(
      <BackendSocketShell>
        <Suspense fallback={null}>
          <SummaryProbe fetchSummary={fetchSummary} />
        </Suspense>
      </BackendSocketShell>,
    )
    await waitFor(() => expect(fetchSummary).toHaveBeenCalledTimes(1))

    await act(async () => {
      handlers.job_updated!({ id: 'j', type: 'batch_cull_photos_before_scoring', status: 'completed' })
    })
    await waitFor(() => expect(fetchSummary).toHaveBeenCalledTimes(2))
  })

  it('refetches after a re-decide, even one that failed', async () => {
    let n = 0
    const fetchSummary = vi.fn().mockImplementation(() => Promise.resolve({ pass: ++n }))

    render(
      <BackendSocketShell>
        <Suspense fallback={null}>
          <SummaryProbe fetchSummary={fetchSummary} />
        </Suspense>
      </BackendSocketShell>,
    )
    await waitFor(() => expect(fetchSummary).toHaveBeenCalledTimes(1))

    await act(async () => {
      handlers.job_updated!({
        id: 'j',
        type: 'batch_redecide_cull_verdicts_from_stored_answers',
        status: 'failed',
      })
    })
    await waitFor(() => expect(fetchSummary).toHaveBeenCalledTimes(2))
  })

  it('leaves the lists alone while a job runs, and for jobs that do not change verdicts', async () => {
    const fetchSummary = vi.fn().mockResolvedValue({ ok: true })

    render(
      <BackendSocketShell>
        <Suspense fallback={null}>
          <SummaryProbe fetchSummary={fetchSummary} />
        </Suspense>
      </BackendSocketShell>,
    )
    await waitFor(() => expect(fetchSummary).toHaveBeenCalledTimes(1))

    await act(async () => {
      handlers.job_updated!({ id: 'j', type: 'batch_cull_photos_before_scoring', status: 'running' })
      handlers.job_updated!({ id: 'k', type: 'batch_describe', status: 'completed' })
    })
    expect(fetchSummary).toHaveBeenCalledTimes(1)
  })

  it.each(['completed', 'failed'] as const)(
    'refetches lr write-back photo detail when an lr_writeback job finishes (%s)',
    async (status) => {
      let n = 0
      const fetchPhoto = vi.fn().mockImplementation(() => Promise.resolve({ rating: { live: ++n } }))

      render(
        <BackendSocketShell>
          <Suspense fallback={null}>
            <LrPhotoProbe fetchPhoto={fetchPhoto} />
          </Suspense>
        </BackendSocketShell>,
      )
      await waitFor(() => expect(fetchPhoto).toHaveBeenCalledTimes(1))

      await act(async () => {
        handlers.job_updated!({ id: 'j', type: 'lr_writeback', status })
      })
      await waitFor(() => expect(fetchPhoto).toHaveBeenCalledTimes(2))
    },
  )

  it('refreshes the first-run signals when a catalog import is queued, once its sync is done, and when it ends, not while it syncs', async () => {
    let n = 0
    const fetchSignals = vi.fn().mockImplementation(() => Promise.resolve(++n))
    renderProbe(keys.firstRun.signals(), fetchSignals)
    await waitFor(() => expect(fetchSignals).toHaveBeenCalledTimes(1))

    await act(async () => {
      handlers.job_updated!({ id: 'j', type: 'catalog_cache_build', status: 'running', progress: 10 })
      handlers.job_updated!({ id: 'j', type: 'catalog_cache_build', status: 'running', progress: 20 })
    })
    expect(fetchSignals).toHaveBeenCalledTimes(1)

    await act(async () => {
      handlers.job_updated!({ id: 'j', type: 'catalog_cache_build', status: 'running', progress: 30 })
    })
    await waitFor(() => expect(fetchSignals).toHaveBeenCalledTimes(2))

    await act(async () => {
      handlers.job_updated!({ id: 'j', type: 'catalog_cache_build', status: 'completed', progress: 100 })
    })
    await waitFor(() => expect(fetchSignals).toHaveBeenCalledTimes(3))

    await act(async () => {
      handlers.job_created!({ id: 'k', type: 'catalog_cache_build', status: 'pending', progress: 0 })
    })
    await waitFor(() => expect(fetchSignals).toHaveBeenCalledTimes(4))
  })

  it('refreshes a photo\'s description when its describe job completes', async () => {
    let n = 0
    const fetchDescription = vi.fn().mockImplementation(() => Promise.resolve(++n))
    renderProbe(keys.descriptions('k'), fetchDescription)
    await waitFor(() => expect(fetchDescription).toHaveBeenCalledTimes(1))

    await act(async () => {
      handlers.job_updated!({ id: 'j', type: 'single_describe', status: 'running', metadata: { image_key: 'k' } })
      handlers.job_updated!({ id: 'j2', type: 'single_describe', status: 'completed', metadata: { image_key: 'other' } })
    })
    expect(fetchDescription).toHaveBeenCalledTimes(1)

    await act(async () => {
      handlers.job_updated!({ id: 'j', type: 'single_describe', status: 'completed', metadata: { image_key: 'k' } })
    })
    await waitFor(() => expect(fetchDescription).toHaveBeenCalledTimes(2))
  })
})
