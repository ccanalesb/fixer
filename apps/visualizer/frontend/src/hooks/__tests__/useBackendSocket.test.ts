import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invalidateAll } from '../../data'
import { useSocketStore } from '../../stores/socketStore'
import { useBackendSocket } from '../useBackendSocket'

vi.mock('../../data', () => ({ invalidateAll: vi.fn() }))

const handlers: Record<string, (payload: unknown) => void> = {}
const socket = {
  on: (event: string, fn: (payload: unknown) => void) => {
    handlers[event] = fn
  },
  off: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  useSocketStore.setState({ socket: socket as never, connected: true, connect: () => {} })
})

describe('useBackendSocket', () => {
  it('refreshes the photo and culling lists when a culling job finishes', () => {
    renderHook(() => useBackendSocket())
    handlers.job_updated!({ id: 'j', type: 'batch_cull_photos_before_scoring', status: 'completed' })
    expect(vi.mocked(invalidateAll).mock.calls.map((c) => c[0])).toEqual([
      ['images.catalog'],
      ['cull.summary'],
      ['cull.photos'],
      ['cull.detail'],
    ])
  })

  it('refreshes after a re-decide, even one that failed', () => {
    renderHook(() => useBackendSocket())
    handlers.job_updated!({ id: 'j', type: 'batch_redecide_cull_verdicts_from_stored_answers', status: 'failed' })
    expect(invalidateAll).toHaveBeenCalledWith(['images.catalog'])
  })

  it('leaves the lists alone while a job runs, and for jobs that do not change verdicts', () => {
    renderHook(() => useBackendSocket())
    handlers.job_updated!({ id: 'j', type: 'batch_cull_photos_before_scoring', status: 'running' })
    handlers.job_updated!({ id: 'k', type: 'batch_describe', status: 'completed' })
    expect(invalidateAll).not.toHaveBeenCalled()
  })
})
