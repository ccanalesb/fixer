import { invalidate, invalidateAll } from './invalidate'

export function prefixOf<T extends readonly unknown[]>(key: T, length: number): readonly unknown[] {
  return key.slice(0, length)
}

export const keys = {
  cull: {
    summary: () => ['cull.summary'] as const,
    photosAll: () => ['cull.photos'] as const,
    photos: (tab: string, page: number) => ['cull.photos', tab, page] as const,
    detail: (imageKey: string) => ['cull.detail', imageKey] as const,
  },
  images: {
    catalogMonths: () => ['images.catalog', 'months'] as const,
    catalogList: (params: unknown) => ['images.catalog', 'list', params] as const,
    detail: (imageType: 'catalog', imageKey: string, perspectiveSlug?: string) =>
      ['images.detail', imageType, imageKey, perspectiveSlug ?? ''] as const,
    /** Every perspective's detail of one catalog photo. */
    detailOfImage: (imageKey: string) => ['images.detail', 'catalog', imageKey] as const,
    stackMembers: (stackId: number) => ['images.stack-members', stackId] as const,
  },
  stacks: {
    suggestions: () => ['stacks.suggestions'] as const,
  },
  cullingProfiles: {
    list: () => ['culling-profiles.list'] as const,
    detail: (slug: string) => ['culling-profiles.detail', slug] as const,
    pipeline: () => ['culling-profiles.pipeline'] as const,
  },
  scoreForecastQuestions: () => ['score-forecast-questions'] as const,
  cullingModels: () => ['culling-models'] as const,
  frameSubstance: (imageKey: string) => ['frameSubstance', imageKey] as const,
  dashboard: () => ['dashboard'] as const,
  identity: {
    mirror: () => ['identity', 'mirror'] as const,
    postNextAll: () => ['identity', 'post-next'] as const,
    postNext: (sortParam: string | null) => ['identity', 'post-next', sortParam] as const,
  },
  lrWriteback: {
    photo: (imageKey: string) => ['lr-writeback.photo', imageKey] as const,
  },
  jobs: {
    listAll: () => ['jobs.list'] as const,
    list: (params?: { status?: string; limit?: number; offset?: number }) =>
      ['jobs.list', params ?? {}] as const,
    active: () => ['jobs.active'] as const,
    health: (pollTick?: number) =>
      pollTick === undefined ? (['jobs.health'] as const) : (['jobs.health', pollTick] as const),
    detail: (id: string) => ['jobs.detail', id] as const,
  },
  providers: {
    listAll: () => ['providers.list'] as const,
    hookBundle: () => ['providers.list', 'hook'] as const,
    tabBundle: () => ['providers.list', 'tab'] as const,
    defaults: () => ['providers.defaults'] as const,
    modelsAll: () => ['providers.models'] as const,
    models: (providerId: string | null) => ['providers.models', providerId] as const,
  },
  perspectives: {
    list: () => ['perspectives', 'list'] as const,
    active: () => ['perspectives', 'list', 'active'] as const,
    detail: (slug: string) => ['perspectives', 'detail', slug] as const,
  },
  catalog: {
    cache: {
      stats: () => ['catalog.cache.stats'] as const,
      pipelineStatus: () => ['catalog.cache.pipeline-status'] as const,
    },
    similarity: {
      groupsAll: () => ['catalog.similarity.groups'] as const,
      groups: (params: { limit: number; offset: number }) =>
        ['catalog.similarity.groups', params] as const,
    },
  },
  descriptions: (imageKey: string) => ['descriptions', imageKey] as const,
  scores: {
    current: (imageKey: string, imageType: string, reloadToken = 0) =>
      ['scores', 'current', imageKey, imageType, reloadToken] as const,
  },
  system: {
    clipModel: () => ['system', 'clip-model'] as const,
  },
  firstRun: {
    signals: () => ['firstRun', 'signals'] as const,
  },
} as const

const PROVIDERS_CHANGED_PREFIXES: readonly (readonly unknown[])[] = [
  keys.providers.listAll(),
  keys.providers.modelsAll(),
  keys.providers.defaults(),
]

/** Invalidate every provider query: the tab and hook bundles, each provider's models, and the defaults. */
export function providersChanged(): void {
  for (const prefix of PROVIDERS_CHANGED_PREFIXES) {
    invalidateAll(prefix)
  }
}

const PERSPECTIVES_PREFIX = prefixOf(keys.perspectives.list(), 1)

/** Invalidate every perspectives list, active-only list, and detail query. */
export function perspectivesChanged(): void {
  invalidateAll(PERSPECTIVES_PREFIX)
}

/** Invalidate catalog cache stats and pipeline status queries. */
export function catalogCacheChanged(): void {
  invalidateAll(keys.catalog.cache.stats())
  invalidateAll(prefixOf(keys.catalog.cache.pipelineStatus(), 1))
}

/** Invalidate first-run signals and related dashboard / catalog summaries after import jobs move. */
export function catalogCacheBuildSignalsChanged(): void {
  invalidateAll(keys.firstRun.signals())
  invalidateAll(keys.dashboard())
  invalidateAll(keys.catalog.cache.stats())
  invalidateAll(prefixOf(keys.images.catalogMonths(), 1))
}

export function clipModelChanged(): void {
  invalidateAll(prefixOf(keys.system.clipModel(), 1))
}

export function retryJobsList(): void {
  invalidateAll(keys.jobs.listAll())
}

export function retryCatalogImagesTab(): void {
  invalidateAll(prefixOf(keys.images.catalogMonths(), 1))
  perspectivesChanged()
}

export function retryCullCatalogTab(): void {
  invalidateAll(prefixOf(keys.images.catalogMonths(), 1))
}

export function retryIdentityMirror(): void {
  invalidate(keys.identity.mirror())
}

export function retryIdentityAdvisor(): void {
  invalidateAll(keys.identity.postNextAll())
}

/** Invalidate one photo's detail under every perspective. */
export function imageDetailChanged(imageKey: string): void {
  invalidateAll(keys.images.detailOfImage(imageKey))
}

const CULLING_CHANGED_PREFIXES: readonly (readonly unknown[])[] = [
  keys.cull.summary(),
  keys.cull.photosAll(),
  prefixOf(keys.cull.detail(''), 1),
  prefixOf(keys.images.catalogMonths(), 1),
  prefixOf(keys.images.detail('catalog', '', ''), 1),
  prefixOf(keys.frameSubstance(''), 1),
  keys.dashboard(),
  prefixOf(keys.identity.mirror(), 1),
]

/** Invalidate every query whose data changes when culling verdicts or frame substance do. */
export function cullingChanged(): void {
  for (const prefix of CULLING_CHANGED_PREFIXES) {
    invalidateAll(prefix)
  }
}

const STACKS_CHANGED_PREFIXES: readonly (readonly unknown[])[] = [
  prefixOf(keys.images.catalogMonths(), 1),
  prefixOf(keys.images.detail('catalog', '', ''), 1),
  keys.stacks.suggestions(),
  keys.dashboard(),
  prefixOf(keys.identity.mirror(), 1),
  prefixOf(keys.images.stackMembers(0), 1),
]

/** Invalidate every query whose data changes when stack membership or suggestions do. */
export function stacksChanged(): void {
  for (const prefix of STACKS_CHANGED_PREFIXES) {
    invalidateAll(prefix)
  }
}

const CULLING_PROFILES_CHANGED_PREFIXES: readonly (readonly unknown[])[] = [
  keys.cullingProfiles.list(),
  prefixOf(keys.cullingProfiles.detail(''), 1),
  keys.cullingProfiles.pipeline(),
  keys.scoreForecastQuestions(),
  keys.cullingModels(),
]

/** Invalidate cached culling stage models (endpoint, model, and usable problems). */
export function cullingModelsChanged(): void {
  invalidateAll(keys.cullingModels())
}

/** Invalidate every query whose data changes when culling profiles, pipeline settings, or score-forecast questions do. */
export function cullingProfilesChanged(): void {
  for (const prefix of CULLING_PROFILES_CHANGED_PREFIXES) {
    invalidateAll(prefix)
  }
}

const LIGHTROOM_WRITTEN_PREFIXES: readonly (readonly unknown[])[] = [
  prefixOf(keys.lrWriteback.photo(''), 1),
  prefixOf(keys.images.catalogMonths(), 1),
  prefixOf(keys.images.detail('catalog', '', ''), 1),
  keys.cull.summary(),
  keys.cull.photosAll(),
  prefixOf(keys.cull.detail(''), 1),
]

/** Invalidate every query whose data changes when Lightroom write-back runs or is undone. */
export function lightroomWritten(): void {
  for (const prefix of LIGHTROOM_WRITTEN_PREFIXES) {
    invalidateAll(prefix)
  }
}
