import { useCallback, useEffect, useState } from 'react'
import {
  catalogCacheBuildSignalsChanged,
  clipModelChanged,
  invalidate,
  invalidateAll,
  keys,
  patchMatching,
  prefixOf,
  retryImageDetail,
} from '../data'
import { useSocketStore } from '../stores/socketStore'
import type { Job } from '../types/job'

interface UseJobSocketOptions {
  onJobCreated?: (job: Job) => void
  onJobUpdated?: (job: Job) => void
  onJobsRecovered?: (payload: { job_ids: string[] }) => void
}

function imageKeyFromJob(job: Job): string | undefined {
  const key = job.metadata?.image_key
  return typeof key === 'string' ? key : undefined
}

function refreshAfterCatalogCacheBuildJob(job: Job) {
  if (job.type !== 'catalog_cache_build') return
  catalogCacheBuildSignalsChanged()
  if (job.status === 'completed') {
    clipModelChanged()
  }
}

function refreshAfterSingleImageJob(job: Job) {
  if (job.status !== 'completed') return
  const imageKey = imageKeyFromJob(job)
  if (!imageKey) return
  if (job.type === 'single_describe') {
    invalidate(keys.descriptions(imageKey))
    retryImageDetail('catalog', imageKey)
  } else if (job.type === 'single_score') {
    retryImageDetail('catalog', imageKey)
  }
}

export function useJobSocket({
  onJobCreated,
  onJobUpdated,
  onJobsRecovered,
}: UseJobSocketOptions = {}) {
  const socket = useSocketStore((s) => s.socket)
  const connected = useSocketStore((s) => s.connected)
  const connect = useSocketStore((s) => s.connect)
  const [jobListRevision, setJobListRevision] = useState(0)

  const refreshJobList = useCallback(() => {
    invalidateAll(prefixOf(keys.jobs.list(), 1))
    setJobListRevision((n) => n + 1)
  }, [])

  useEffect(() => {
    connect()
  }, [connect])

  useEffect(() => {
    if (!socket || !connected) return

    const jobsListPrefix = JSON.stringify(prefixOf(keys.jobs.list(), 1)).slice(0, -1)

    const handleJobCreated = (job: Job) => {
      invalidateAll(prefixOf(keys.jobs.list(), 1))
      setJobListRevision((n) => n + 1)
      refreshAfterCatalogCacheBuildJob(job)
      onJobCreated?.(job)
    }

    const handleJobUpdated = (job: Job) => {
      // Always patch in-place — status changes (including terminal ones) only
      // update an existing row; no rows are added or removed. This avoids
      // deleting the cache entry and triggering a Suspense flash in the job
      // list. A full refresh happens only on job_created / jobs_recovered.
      patchMatching(
        (k) => k.startsWith(jobsListPrefix),
        (value) => {
          const resp = value as { data?: Job[] }
          if (!resp?.data) return value
          return { ...resp, data: resp.data.map((j) => (j.id === job.id ? job : j)) }
        },
      )
      setJobListRevision((n) => n + 1)
      refreshAfterCatalogCacheBuildJob(job)
      refreshAfterSingleImageJob(job)
      onJobUpdated?.(job)
    }

    const handleJobsRecovered = (payload: { job_ids: string[] }) => {
      invalidateAll(prefixOf(keys.jobs.list(), 1))
      setJobListRevision((n) => n + 1)
      onJobsRecovered?.(payload)
    }

    socket.on('job_created', handleJobCreated)
    socket.on('job_updated', handleJobUpdated)
    if (onJobsRecovered) socket.on('jobs_recovered', handleJobsRecovered)

    return () => {
      socket.off('job_created', handleJobCreated)
      socket.off('job_updated', handleJobUpdated)
      if (onJobsRecovered) socket.off('jobs_recovered', handleJobsRecovered)
    }
  }, [socket, connected, onJobCreated, onJobUpdated, onJobsRecovered])

  return { connected, socket, jobListRevision, refreshJobList }
}
