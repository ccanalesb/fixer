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

beforeEach(() => {
  deleteMatching(() => true)
  delete handlers.job_updated
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
})
