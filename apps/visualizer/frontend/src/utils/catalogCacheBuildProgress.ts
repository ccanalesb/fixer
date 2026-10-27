import type { Job } from '../types/job'
import {
  FIRST_RUN_STAGE_BURST_STACKS,
  FIRST_RUN_STAGE_EMBEDDINGS,
  FIRST_RUN_STAGE_NEAR_DUPLICATES,
  FIRST_RUN_STAGE_READ_CATALOG,
} from '../constants/strings'

/** Progress band lower bounds — must match `catalog-cache.ts` chain stages. */
const SYNC_LO = 5
const EMBED_LO = 29
const STACK_LO = 52
const SIMILARITY_LO = 76

export type CatalogCacheBuildStageKey = 'sync' | 'embed' | 'stack' | 'similarity'

export const CATALOG_CACHE_BUILD_STAGE_LABELS: Record<CatalogCacheBuildStageKey, string> = {
  sync: FIRST_RUN_STAGE_READ_CATALOG,
  embed: FIRST_RUN_STAGE_EMBEDDINGS,
  stack: FIRST_RUN_STAGE_BURST_STACKS,
  similarity: FIRST_RUN_STAGE_NEAR_DUPLICATES,
}

export const CATALOG_CACHE_BUILD_STAGE_ORDER: CatalogCacheBuildStageKey[] = [
  'sync',
  'embed',
  'stack',
  'similarity',
]

export function catalogCacheBuildProgressPercent(job: Job | null | undefined): number {
  if (!job) return 0
  const p = job.progress ?? 0
  return p <= 1 ? Math.round(p * 100) : Math.round(p)
}

export function catalogCacheBuildActiveStage(
  job: Job | null | undefined,
): CatalogCacheBuildStageKey | 'done' {
  if (!job) return 'sync'
  if (job.status === 'completed') return 'done'
  const p = catalogCacheBuildProgressPercent(job)
  if (p < EMBED_LO) return 'sync'
  if (p < STACK_LO) return 'embed'
  if (p < SIMILARITY_LO) return 'stack'
  if (p < 100) return 'similarity'
  return 'done'
}

/** Sync stage finished — photos may appear in the library. */
export function catalogCacheBuildSyncComplete(job: Job | null | undefined): boolean {
  if (!job) return false
  if (job.status === 'completed') return true
  if (job.status !== 'running' && job.status !== 'pending') return false
  return catalogCacheBuildProgressPercent(job) >= EMBED_LO
}

export function parseEmbedProgressDetail(currentStep: string | null | undefined): string | null {
  if (!currentStep) return null
  const m = currentStep.match(/Embedded\s+(\d+)\/(\d+)/i)
  if (!m) return null
  return `${Number(m[1]).toLocaleString('en-US')} / ${Number(m[2]).toLocaleString('en-US')}`
}

export function catalogCacheBuildStageState(
  stage: CatalogCacheBuildStageKey,
  job: Job | null | undefined,
): 'pending' | 'current' | 'done' {
  const active = catalogCacheBuildActiveStage(job)
  if (active === 'done') return 'done'
  const idx = CATALOG_CACHE_BUILD_STAGE_ORDER.indexOf(stage)
  const activeIdx = CATALOG_CACHE_BUILD_STAGE_ORDER.indexOf(active as CatalogCacheBuildStageKey)
  if (idx < activeIdx) return 'done'
  if (idx === activeIdx) return 'current'
  return 'pending'
}

/** Overall bar width for the setup screen (matches prototype weighting). */
export function catalogCacheBuildOverallPercent(job: Job | null | undefined): number {
  return catalogCacheBuildProgressPercent(job)
}

export { SYNC_LO, EMBED_LO, STACK_LO, SIMILARITY_LO }
