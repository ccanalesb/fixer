import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { invalidateAll } from '../../data';
import type { Job } from '../../types/job';
import { useJobSocket } from '../useJobSocket';

const mockSocket = {
  on: vi.fn(),
  off: vi.fn(),
};

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();

vi.mock('../../stores/socketStore', () => ({
  useSocketStore: vi.fn((selector) => {
    const state = {
      socket: mockSocket,
      connected: true,
      connect: mockConnect,
      disconnect: mockDisconnect,
    };
    return selector(state);
  }),
}));

vi.mock('../../data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../data')>()
  return {
    ...actual,
    invalidate: vi.fn(),
    invalidateAll: vi.fn(),
    patchMatching: vi.fn(),
  }
})

describe('useJobSocket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should connect on mount and keep the shared socket alive on unmount', () => {
    const { unmount } = renderHook(() => useJobSocket({}));
    expect(mockConnect).toHaveBeenCalledOnce();
    unmount();
    expect(mockDisconnect).not.toHaveBeenCalled();
  });

  it('should register job_created and job_updated listeners for cache invalidation', () => {
    const onCreated = vi.fn();
    const onUpdated = vi.fn();
    renderHook(() => useJobSocket({ onJobCreated: onCreated, onJobUpdated: onUpdated }));

    const onCalls = mockSocket.on.mock.calls;
    const eventNames = onCalls.map(([name]: [string]) => name);
    expect(eventNames).toContain('job_created');
    expect(eventNames).toContain('job_updated');
  });

  it('should unregister both listeners on unmount', () => {
    const { unmount } = renderHook(() => useJobSocket({ onJobCreated: vi.fn() }));
    unmount();
    const offCalls = mockSocket.off.mock.calls;
    const eventNames = offCalls.map(([name]: [string]) => name);
    expect(eventNames).toContain('job_created');
    expect(eventNames).toContain('job_updated');
  });

  it('should clean up both listeners on unmount when both handlers are provided', () => {
    const { unmount } = renderHook(() =>
      useJobSocket({ onJobCreated: vi.fn(), onJobUpdated: vi.fn() }),
    );
    unmount();
    const offCalls = mockSocket.off.mock.calls;
    const eventNames = offCalls.map(([name]: [string]) => name);
    expect(eventNames).toContain('job_created');
    expect(eventNames).toContain('job_updated');
  });

  it('should return connected state', () => {
    const { result } = renderHook(() => useJobSocket({}));
    expect(result.current.connected).toBe(true);
  });

  it('should expose refreshJobList and revision counters', () => {
    const { result } = renderHook(() => useJobSocket({}));
    expect(typeof result.current.refreshJobList).toBe('function');
    expect(result.current.jobListRevision).toBe(0);
  });

  it('should invalidate jobs.list and bump revision on job_created', () => {
    const { result } = renderHook(() => useJobSocket({}));

    const createdHandler = mockSocket.on.mock.calls.find(
      ([name]: [string]) => name === 'job_created',
    )?.[1] as (job: Job) => void;
    expect(createdHandler).toBeDefined();

    const job = { id: 'job-new', status: 'pending', type: 'batch_describe' } as Job;
    act(() => {
      createdHandler(job);
    });

    expect(invalidateAll).toHaveBeenCalledWith(['jobs.list']);
    expect(result.current.jobListRevision).toBe(1);
  });
});
