import { useEffect } from 'react'
import { cullingChanged, lightroomWritten } from '../data/keys'
import { useSocketStore } from '../stores/socketStore'
import type { Job } from '../types/job'

/** Jobs that change verdicts or Lightroom stars, and so what the photo and culling lists show. */
const VERDICT_JOB_TYPES = new Set([
  'batch_cull_photos_before_scoring',
  'batch_redecide_cull_verdicts_from_stored_answers',
  'lr_writeback',
])
const CULLING_JOB_TYPES = new Set([
  'batch_cull_photos_before_scoring',
  'batch_redecide_cull_verdicts_from_stored_answers',
])
const FINISHED: ReadonlySet<Job['status']> = new Set(['completed', 'failed', 'cancelled'])

/**
 * Ensure the shared Socket.IO client is connected for the lifetime of the shell, and refresh the
 * photo and culling lists when a job that changes verdicts finishes.
 */
export function useBackendSocket() {
  const connect = useSocketStore((s) => s.connect)
  const socket = useSocketStore((s) => s.socket)

  useEffect(() => {
    connect()
  }, [connect])

  useEffect(() => {
    if (!socket) return
    const onJobUpdated = (job: Job) => {
      if (!VERDICT_JOB_TYPES.has(job.type) || !FINISHED.has(job.status)) return
      if (CULLING_JOB_TYPES.has(job.type)) {
        cullingChanged()
        return
      }
      lightroomWritten()
    }
    socket.on('job_updated', onJobUpdated)
    return () => {
      socket.off('job_updated', onJobUpdated)
    }
  }, [socket])
}
