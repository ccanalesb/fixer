import { describe, expect, it } from 'vitest'
import type { Job } from '../../types/job'
import {
  catalogCacheBuildActiveStage,
  catalogCacheBuildProgressPercent,
  catalogCacheBuildStageState,
  catalogCacheBuildSyncComplete,
  parseEmbedProgressDetail,
} from '../catalogCacheBuildProgress'

function job(over: Partial<Job>): Job {
  return {
    id: 'j1',
    type: 'catalog_cache_build',
    status: 'running',
    progress: 10,
    logs: [],
    logs_total: 0,
    warning_count: 0,
    error_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    metadata: {},
    ...over,
  }
}

describe('catalogCacheBuildProgress', () => {
  it('maps progress bands to stages', () => {
    expect(catalogCacheBuildActiveStage(job({ progress: 10 }))).toBe('sync')
    expect(catalogCacheBuildActiveStage(job({ progress: 35 }))).toBe('embed')
    expect(catalogCacheBuildActiveStage(job({ progress: 60 }))).toBe('stack')
    expect(catalogCacheBuildActiveStage(job({ progress: 90 }))).toBe('similarity')
    expect(catalogCacheBuildActiveStage(job({ status: 'completed', progress: 100 }))).toBe('done')
  })

  it('treats sync as complete from the embed band onward', () => {
    expect(catalogCacheBuildSyncComplete(job({ progress: 10 }))).toBe(false)
    expect(catalogCacheBuildSyncComplete(job({ progress: 29 }))).toBe(true)
    expect(catalogCacheBuildSyncComplete(job({ status: 'completed', progress: 100 }))).toBe(true)
  })

  it('parses embed counts from the current step', () => {
    expect(parseEmbedProgressDetail('[embed] Embedded 12/400')).toBe('12 / 400')
    expect(parseEmbedProgressDetail('other')).toBeNull()
  })

  it('marks checklist rows done, current, or pending', () => {
    const running = job({ progress: 35 })
    expect(catalogCacheBuildStageState('sync', running)).toBe('done')
    expect(catalogCacheBuildStageState('embed', running)).toBe('current')
    expect(catalogCacheBuildStageState('stack', running)).toBe('pending')
  })

  it('normalizes fractional progress', () => {
    expect(catalogCacheBuildProgressPercent(job({ progress: 0.42 }))).toBe(42)
  })
})
