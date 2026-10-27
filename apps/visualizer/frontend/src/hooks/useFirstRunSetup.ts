import { useCallback, useEffect, useMemo, useState } from 'react'
import { invalidateAll, useQuery } from '../data'
import { ConfigAPI, JobsAPI, SystemAPI } from '../services/api'
import type { Job } from '../types/job'
import { useCatalogPicker } from './useCatalogPicker'
import { useJobSocket } from './useJobSocket'
import {
  catalogCacheBuildSyncComplete,
  catalogCacheBuildProgressPercent,
} from '../utils/catalogCacheBuildProgress'

const EMPTY_PIPELINE = {
  catalog_sync: null,
  embed_catalog: null,
  stack_detect: null,
  catalog_similarity: null,
  catalog_cache_build: null,
}

async function fetchFirstRunSignals() {
  const [pipeline, insights] = await Promise.all([
    SystemAPI.cachePipelineStatus(),
    SystemAPI.insightsSummary(),
  ])
  return {
    pipeline,
    catalogPhotoCount: insights.catalog_images ?? 0,
    firstCatalogImportCompleted: insights.first_catalog_import_completed ?? false,
  }
}

function isActiveImportJob(job: Job | null | undefined): boolean {
  return job?.status === 'running' || job?.status === 'pending'
}

export function useFirstRunSetup() {
  const catalog = useCatalogPicker()
  const [importJob, setImportJob] = useState<Job | null>(null)
  const [importStarting, setImportStarting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

  const signals = useQuery(['firstRun', 'signals'] as const, fetchFirstRunSignals, {
    initialValue: {
      pipeline: EMPTY_PIPELINE,
      catalogPhotoCount: 0,
      firstCatalogImportCompleted: false,
    },
  })

  const buildRun = signals.pipeline?.catalog_cache_build ?? null
  const firstCatalogImportCompleted = signals.firstCatalogImportCompleted ?? false
  const catalogPhotoCount = signals.catalogPhotoCount ?? 0

  const refreshSignals = useCallback(() => {
    invalidateAll(['firstRun', 'signals'])
    invalidateAll(['dashboard'])
    invalidateAll(['catalog.cache.stats'])
    invalidateAll(['images.catalog'])
  }, [])

  const syncImportJobFromApi = useCallback(async () => {
    const run = buildRun
    if (!run || (run.status !== 'running' && run.status !== 'pending')) {
      setImportJob(null)
      return
    }
    try {
      const job = await JobsAPI.get(run.job_id)
      setImportJob(job)
    } catch {
      setImportJob(null)
    }
  }, [buildRun])

  useEffect(() => {
    void syncImportJobFromApi()
  }, [syncImportJobFromApi])

  useJobSocket({
    onJobCreated: (job) => {
      if (job.type !== 'catalog_cache_build') return
      setImportJob(job)
      refreshSignals()
    },
    onJobUpdated: (job) => {
      if (job.type !== 'catalog_cache_build') return
      setImportJob((prev) => (prev && prev.id !== job.id ? prev : job))
      if (
        job.status === 'completed' ||
        job.status === 'failed' ||
        job.status === 'cancelled' ||
        catalogCacheBuildSyncComplete(job)
      ) {
        refreshSignals()
      }
    },
  })

  const pipelineImportActive =
    buildRun?.status === 'running' || buildRun?.status === 'pending'
  const importRunning =
    isActiveImportJob(importJob) || importStarting || pipelineImportActive

  const catalogConfigured = Boolean(catalog.status?.path?.trim())
  const catalogSavedAndValid =
    catalogConfigured && Boolean(catalog.status?.exists) && !catalog.changesCatalog

  const showInsightsSetup = !firstCatalogImportCompleted

  const showIdentityEmpty = catalogPhotoCount === 0

  const showImagesEmpty = catalogPhotoCount === 0 && !importRunning
  const showImagesReadingCatalog =
    importRunning && catalogPhotoCount === 0 && !catalogCacheBuildSyncComplete(importJob)
  const showImagesImportBanner =
    importRunning && catalogPhotoCount > 0 && !firstCatalogImportCompleted

  const pickAndSaveCatalog = useCallback(async () => {
    setImportError(null)
    try {
      const { catalog_path: chosen } = await ConfigAPI.pickCatalog()
      if (!chosen) return
      await ConfigAPI.putCatalog(chosen)
      await catalog.refresh()
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e))
    }
  }, [catalog])

  const startImport = useCallback(async () => {
    if (!catalogSavedAndValid || importRunning) return
    setImportStarting(true)
    setImportError(null)
    try {
      const job = await JobsAPI.create('catalog_cache_build', {})
      setImportJob(job)
      refreshSignals()
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e))
    } finally {
      setImportStarting(false)
    }
  }, [catalogSavedAndValid, importRunning, refreshSignals])

  const loading = catalog.loading

  const importProgressPercent = useMemo(
    () => catalogCacheBuildProgressPercent(importJob),
    [importJob],
  )

  return {
    loading,
    catalog,
    catalogConfigured,
    catalogSavedAndValid,
    firstCatalogImportCompleted,
    importRunning,
    importJob,
    importStarting,
    importError,
    importProgressPercent,
    catalogPhotoCount,
    showInsightsSetup,
    showIdentityEmpty,
    showImagesEmpty,
    showImagesReadingCatalog,
    showImagesImportBanner,
    pickAndSaveCatalog,
    startImport,
    refreshSignals,
  }
}
