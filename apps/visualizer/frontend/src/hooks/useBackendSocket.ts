import { useEffect } from 'react'
import {
  catalogCacheBuildSignalsChanged,
  clipModelChanged,
  cullingChanged,
  cullingModelsChanged,
  invalidate,
  keys,
  lightroomWritten,
  retryImageDetail,
} from '../data'
import { useSocketStore } from '../stores/socketStore'
import type { Job } from '../types/job'
import { CULLING_JOB_TYPE } from '../services/api'
import { catalogCacheBuildSyncComplete } from '../utils/catalogCacheBuildProgress'

/** Jobs that change verdicts or Lightroom stars, and so what the photo and culling lists show. */
const VERDICT_JOB_TYPES = new Set([
  CULLING_JOB_TYPE,
  'batch_redecide_cull_verdicts_from_stored_answers',
  'lr_writeback',
])
const CULLING_JOB_TYPES = new Set([
  CULLING_JOB_TYPE,
  'batch_redecide_cull_verdicts_from_stored_answers',
])
const FINISHED: ReadonlySet<Job['status']> = new Set(['completed', 'failed', 'cancelled'])

function imageKeyOf(job: Job): string | null {
  const key = job.metadata?.image_key
  return typeof key === 'string' ? key : null
}

function onVerdictJobFinished(job: Job): void {
  if (CULLING_JOB_TYPES.has(job.type)) cullingChanged()
  else lightroomWritten()
}

/** A catalog import refreshes the photo counts once its sync is done and when it ends, not on every progress update. */
function onCatalogCacheBuildUpdated(job: Job): void {
  if (FINISHED.has(job.status) || catalogCacheBuildSyncComplete(job)) catalogCacheBuildSignalsChanged()
  if (job.status === 'completed') clipModelChanged()
}

function onSingleImageJobCompleted(job: Job): void {
  const imageKey = imageKeyOf(job)
  if (!imageKey) return
  if (job.type === 'single_describe') invalidate(keys.descriptions(imageKey))
  retryImageDetail('catalog', imageKey)
}

/**
 * Ensure the shared Socket.IO client is connected for the lifetime of the shell, and refresh what a
 * finished job changed: the photo and culling lists, the catalog's counts, and a photo's detail.
 */
export function useBackendSocket() {
  const connect = useSocketStore((s) => s.connect)
  const socket = useSocketStore((s) => s.socket)

  useEffect(() => {
    connect()
  }, [connect])

  useEffect(() => {
    if (!socket) return
    const onJobCreated = (job: Job) => {
      if (job.type === 'catalog_cache_build') catalogCacheBuildSignalsChanged()
    }
    const onJobUpdated = (job: Job) => {
      if (job.type === 'catalog_cache_build') {
        onCatalogCacheBuildUpdated(job)
        return
      }
      if (!FINISHED.has(job.status)) return
      if (job.type === 'app_model_install') cullingModelsChanged()
      if (VERDICT_JOB_TYPES.has(job.type)) onVerdictJobFinished(job)
      else if (job.status === 'completed' && (job.type === 'single_describe' || job.type === 'single_score')) {
        onSingleImageJobCompleted(job)
      }
    }
    socket.on('job_created', onJobCreated)
    socket.on('job_updated', onJobUpdated)
    return () => {
      socket.off('job_created', onJobCreated)
      socket.off('job_updated', onJobUpdated)
    }
  }, [socket])
}
