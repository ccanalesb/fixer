import { invalidateAll } from './invalidate'

export function prefixOf<T extends readonly unknown[]>(key: T, length: number): readonly unknown[] {
  return key.slice(0, length)
}

export const keys = {
  cull: {
    summary: () => ['cull.summary'] as const,
    photos: (tab: string, page: number) => ['cull.photos', tab, page] as const,
    detail: (imageKey: string) => ['cull.detail', imageKey] as const,
  },
  images: {
    catalogMonths: () => ['images.catalog', 'months'] as const,
    catalogList: (params: unknown) => ['images.catalog', 'list', params] as const,
    detail: (imageType: 'catalog', imageKey: string, perspectiveSlug?: string) =>
      ['images.detail', imageType, imageKey, perspectiveSlug ?? ''] as const,
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
  frameSubstance: (imageKey: string) => ['frameSubstance', imageKey] as const,
  dashboard: () => ['dashboard'] as const,
  identity: {
    mirror: () => ['identity', 'mirror'] as const,
    postNext: (sortParam: string | null) => ['identity', 'post-next', sortParam] as const,
  },
  lrWriteback: {
    photo: (imageKey: string) => ['lr-writeback.photo', imageKey] as const,
  },
} as const

const CULLING_CHANGED_PREFIXES: readonly (readonly unknown[])[] = [
  keys.cull.summary(),
  prefixOf(keys.cull.photos('', 0), 1),
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
]

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
  prefixOf(keys.cull.photos('', 0), 1),
  prefixOf(keys.cull.detail(''), 1),
]

/** Invalidate every query whose data changes when Lightroom write-back runs or is undone. */
export function lightroomWritten(): void {
  for (const prefix of LIGHTROOM_WRITTEN_PREFIXES) {
    invalidateAll(prefix)
  }
}
