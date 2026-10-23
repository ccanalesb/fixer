import { invalidate, invalidateAll, patchMatching } from '../data'
import type {
  CatalogImage,
  CatalogImageInput,
  CatalogSimilarityGroup,
  CatalogSimilarityGroupsResponse,
  IdentityPerPerspectiveScore,
  ImageDetailResponse,
  ImageView,
  InstagramPostedResponse,
} from '../types/catalog'
import type {
  ConfigCatalogGetResponse,
  ConfigCatalogPickResponse,
  ConfigCatalogPutResponse,
  ConfigStackDetectionGetResponse,
  ConfigStackDetectionPutResponse,
} from '../types/config'
import type {
  DescriptionGenerateResponse,
  DescriptionGetResponse,
  DescriptionItem,
  DescriptionsListResponse,
  ImageDescription,
  ImageDescriptionComposition,
  ImageDescriptionPerspectives,
  ImageDescriptionTechnical,
} from '../types/descriptions'
import type {
  CullKeywordMutationResponse,
  FrameSubstanceOverrideResponse,
  FrameSubstanceResponse,
} from '../types/frameSubstance'
export type {
  CullKeywordMutationResponse,
  FrameSubstanceInstrument,
  FrameSubstanceOverrideResponse,
  FrameSubstanceResponse,
} from '../types/frameSubstance'
import type { Job, JobsGetOptions, JobsHealth, JobsListResponse } from '../types/job'
import type {
  PerspectiveDetail,
  PerspectiveScore,
  PerspectiveSummary,
} from '../types/perspectives'
import type {
  DescriptionModel,
  DescriptionModelsResponse,
  Provider,
  ProviderDefaults,
  ProviderModel,
} from '../types/providers'
import type {
  ImageScoreRow,
  ScoresCurrentResponse,
  ScoresHistoryResponse,
} from '../types/scores'
import type {
  StackMergeResponse,
  StackRepresentativeResponse,
  StackSplitMemberResponse,
  StackSuggestion,
  StackSuggestionAcceptResponse,
  StackSuggestionsResponse,
} from '../types/stacks'
import type { components } from '../types/api.gen'
import type {
  IdentityBestPhotoItem,
  IdentityBestPhotosMeta,
  IdentityBestPhotosResponse,
  MirrorExemplar,
  MirrorLensExemplarsResponse,
  MirrorMeta,
  MirrorOtherLens,
  MirrorResponse,
  MirrorTechniqueSection,
  PostNextCandidate,
  PostNextSuggestionsMeta,
  PostNextSuggestionsResponse,
} from '../types/identity'
import type {
  CachePipelineRun,
  CachePipelineStatus,
  CacheStatus,
  InsightsSummary,
  PerspectiveCoverageRow,
  Stats,
  SystemStatusResponse,
  VisionModelsResponse,
} from '../types/system'
import { API_DEFAULT_URL } from '../constants/strings'
import { fetchWithTimeout } from './fetchWithTimeout'

export type {
  IdentityBestPhotoItem,
  IdentityBestPhotosMeta,
  IdentityBestPhotosResponse,
  MirrorExemplar,
  MirrorLensExemplarsResponse,
  MirrorMeta,
  MirrorOtherLens,
  MirrorResponse,
  MirrorTechniqueSection,
  PostNextCandidate,
  PostNextSuggestionsMeta,
  PostNextSuggestionsResponse,
}
export type {
  CachePipelineRun,
  CachePipelineStatus,
  CacheStatus,
  InsightsSummary,
  PerspectiveCoverageRow,
  Stats,
  SystemStatusResponse,
  VisionModelsResponse,
}
export type {
  DescriptionGenerateResponse,
  DescriptionGetResponse,
  DescriptionItem,
  DescriptionsListResponse,
  ImageDescription,
  ImageDescriptionComposition,
  ImageDescriptionPerspectives,
  ImageDescriptionTechnical,
  ImageScoreRow,
  ScoresCurrentResponse,
  ScoresHistoryResponse,
}
export type {
  CatalogImage,
  CatalogImageInput,
  CatalogSimilarityGroup,
  CatalogSimilarityGroupsResponse,
  IdentityPerPerspectiveScore,
  ImageDetailResponse,
  ImageView,
  Job,
  JobsGetOptions,
  JobsHealth,
  JobsListResponse,
  StackMergeResponse,
  StackRepresentativeResponse,
  StackSplitMemberResponse,
  StackSuggestion,
  StackSuggestionAcceptResponse,
  StackSuggestionsResponse,
}
export type {
  DescriptionModel,
  DescriptionModelsResponse,
  PerspectiveDetail,
  PerspectiveScore,
  PerspectiveSummary,
  Provider,
  ProviderDefaults,
  ProviderModel,
}

const API_URL = import.meta.env.VITE_API_URL || API_DEFAULT_URL

/** Outlasts the backend's own dialog timeout, so the server's error is what surfaces. */
const CATALOG_PICK_TIMEOUT_MS = 6 * 60 * 1000

export class ApiRequestError extends Error {
  readonly validationErrors: readonly { field: string; message: string }[]

  constructor(message: string, validationErrors: readonly { field: string; message: string }[] = []) {
    super(message)
    this.name = 'ApiRequestError'
    this.validationErrors = validationErrors
  }
}

async function readJsonBody(response: Response): Promise<unknown> {
  if (typeof response.json === 'function') {
    try {
      return await response.json()
    } catch {
      /* fall through — some environments expose json() but need text() */
    }
  }
  if (typeof response.text === 'function') {
    const text = await response.text()
    if (!text.trim()) {
      throw new Error('Unexpected end of JSON input')
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error('Unexpected end of JSON input')
    }
  }
  throw new Error('Unexpected end of JSON input')
}

async function request<T>(path: string, options?: RequestInit, timeoutMs?: number): Promise<T> {
  const response = await fetchWithTimeout(
    `${API_URL}${path}`,
    {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    },
    timeoutMs,
  )

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`
    let parsed: unknown
    if (typeof response.text === 'function') {
      const text = await response.text()
      if (text.trim()) {
        try {
          parsed = JSON.parse(text) as unknown
        } catch {
          parsed = undefined
        }
      }
    } else if (typeof response.json === 'function') {
      try {
        parsed = await response.json()
      } catch {
        parsed = undefined
      }
    }
    if (parsed && typeof parsed === 'object') {
      const body = parsed as { error?: unknown; validation_errors?: { field: string; message: string }[] }
      if (typeof body.error === 'string') detail = body.error
      const validationErrors = Array.isArray(body.validation_errors) ? body.validation_errors : []
      if (typeof body.error === 'string' || validationErrors.length > 0) {
        throw new ApiRequestError(detail, validationErrors)
      }
    }
    throw new Error(detail)
  }

  return (await readJsonBody(response)) as T
}

async function requestVoid(path: string, options?: RequestInit): Promise<void> {
  const response = await fetchWithTimeout(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`
    try {
      const body = await response.json()
      if (body && typeof (body as { error?: unknown }).error === 'string') {
        detail = (body as { error: string }).error
      }
    } catch {
      /* ignore non-JSON error bodies */
    }
    throw new Error(detail)
  }
}

export const PerspectivesAPI = {
  list: (params?: { active_only?: boolean }) => {
    const sp = new URLSearchParams()
    if (params?.active_only) sp.set('active_only', 'true')
    const qs = sp.toString()
    return request<PerspectiveSummary[]>(`/perspectives/${qs ? `?${qs}` : ''}`)
  },

  get: (slug: string) =>
    request<PerspectiveDetail>(`/perspectives/${encodeURIComponent(slug)}`),

  create: async (body: {
    slug: string
    display_name: string
    prompt_markdown: string
    description?: string
    active?: boolean
  }) => {
    const result = await request<PerspectiveDetail>('/perspectives/', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    invalidateAll(['perspectives'])
    return result
  },

  update: async (slug: string, body: Record<string, unknown>) => {
    const result = await request<PerspectiveDetail>(`/perspectives/${encodeURIComponent(slug)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
    invalidateAll(['perspectives'])
    return result
  },

  remove: async (slug: string) => {
    await requestVoid(`/perspectives/${encodeURIComponent(slug)}`, { method: 'DELETE' })
    invalidateAll(['perspectives'])
  },

  resetDefault: async (slug: string) => {
    const result = await request<PerspectiveDetail>(
      `/perspectives/${encodeURIComponent(slug)}/reset-default`,
      { method: 'POST' },
    )
    invalidateAll(['perspectives'])
    return result
  },
}

export const JobsAPI = {
  list: (params?: { status?: string; limit?: number; offset?: number }) => {
    const sp = new URLSearchParams()
    if (params?.status) sp.set('status', params.status)
    if (params?.limit !== undefined) sp.set('limit', String(params.limit))
    if (params?.offset !== undefined) sp.set('offset', String(params.offset))
    const qs = sp.toString()
    return request<JobsListResponse>(`/jobs/${qs ? `?${qs}` : ''}`)
  },

  get: (id: string, options?: JobsGetOptions) => {
    const sp = new URLSearchParams()
    if (options?.logs_limit !== undefined) {
      sp.set('logs_limit', String(options.logs_limit))
    }
    const qs = sp.toString()
    return request<Job>(`/jobs/${id}${qs ? `?${qs}` : ''}`)
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  create: async (type: string, metadata?: Record<string, any>) => {
    const job = await request<Job>('/jobs/', {
      method: 'POST',
      body: JSON.stringify({ type, metadata }),
    })
    invalidateAll(['jobs.list'])
    invalidateAll(['jobs.health'])
    return job
  },

  getActive: () =>
    request<Job[]>('/jobs/active'),

  cancel: async (id: string) => {
    await requestVoid(`/jobs/${id}`, { method: 'DELETE' })
    // jobs.list is patched in-place via the job_updated socket event so we
    // don't invalidate here (that would wipe the cache and trigger Suspense).
    invalidateAll(['jobs.health'])
  },

  retry: async (id: string) => {
    const job = await request<Job>(`/jobs/${id}/retry`, { method: 'POST' })
    // jobs.list patched via socket; detail is updated via setLocalJob in the
    // modal — invalidating the detail cache would cause a Suspense flash there.
    invalidateAll(['jobs.health'])
    return job
  },

  health: () =>
    request<JobsHealth>('/jobs/health'),
}

export const ConfigAPI = {
  getCatalog: () =>
    request<ConfigCatalogGetResponse>('/config/catalog'),

  /**
   * Opens a file dialog on the machine running the backend and resolves once the
   * user answers it, so the deadline is a human's, not a server's.
   */
  pickCatalog: () =>
    request<ConfigCatalogPickResponse>(
      '/config/catalog/pick',
      { method: 'POST' },
      CATALOG_PICK_TIMEOUT_MS,
    ),

  putCatalog: async (catalogPath: string) => {
    const result = await request<ConfigCatalogPutResponse>('/config/catalog', {
      method: 'PUT',
      body: JSON.stringify({ catalog_path: catalogPath }),
    })
    invalidateAll(['images.catalog'])
    invalidateAll(['catalog.cache.stats'])
    invalidateAll(['jobs.health'])
    invalidateAll(['dashboard'])
    return result
  },

  getStackDetection: () =>
    request<ConfigStackDetectionGetResponse>('/config/stack-detection'),

  putStackDetection: async (stackBurstDeltaMs: number) => {
    const result = await request<ConfigStackDetectionPutResponse>(
      '/config/stack-detection',
      {
        method: 'PUT',
        body: JSON.stringify({ stack_burst_delta_ms: stackBurstDeltaMs }),
      },
    )
    invalidateAll(['jobs.health'])
    return result
  },
}

/** Query params shared by catalog list and CLIP similar (backend mirrors filters). */
export type CatalogListQueryParams = {
  posted?: boolean
  analyzed?: boolean | null
  month?: string
  keyword?: string
  min_rating?: number
  date_from?: string
  date_to?: string
  color_label?: string
  description_search?: string
  score_perspective?: string
  min_score?: number
  min_score_on_active?: number
  burst_stack?: boolean
  flagged?: boolean
  sort_by_score?: 'asc' | 'desc'
  sort_by_date?: 'newest' | 'oldest'
  limit?: number
  offset?: number
  cull_catalog?: boolean
}

function appendCatalogListSearchParams(
  searchParams: URLSearchParams,
  params: CatalogListQueryParams | undefined,
) {
  if (!params) return
  if (params.posted !== undefined) {
    searchParams.set('posted', params.posted ? 'true' : 'false')
  }
  if (params.analyzed === true) {
    searchParams.set('analyzed', 'true')
  } else if (params.analyzed === false) {
    searchParams.set('analyzed', 'false')
  }
  if (params.month) searchParams.set('month', params.month)
  if (params.keyword) searchParams.set('keyword', params.keyword)
  if (params.min_rating !== undefined) {
    searchParams.set('min_rating', String(params.min_rating))
  }
  if (params.date_from) searchParams.set('date_from', params.date_from)
  if (params.date_to) searchParams.set('date_to', params.date_to)
  if (params.color_label) searchParams.set('color_label', params.color_label)
  if (params.description_search) {
    searchParams.set('description_search', params.description_search)
  }
  if (params.score_perspective) searchParams.set('score_perspective', params.score_perspective)
  if (params.min_score !== undefined) searchParams.set('min_score', String(params.min_score))
  if (params.min_score_on_active !== undefined) {
    searchParams.set('min_score_on_active', String(params.min_score_on_active))
  }
  if (params.burst_stack === true) searchParams.set('burst_stack', 'true')
  else if (params.burst_stack === false) searchParams.set('burst_stack', 'false')
  if (params.flagged === true) searchParams.set('flagged', 'true')
  else if (params.flagged === false) searchParams.set('flagged', 'false')
  if (params.sort_by_score) searchParams.set('sort_by_score', params.sort_by_score)
  if (params.sort_by_date) searchParams.set('sort_by_date', params.sort_by_date)
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params.offset !== undefined) searchParams.set('offset', String(params.offset))
  if (params.cull_catalog === true) searchParams.set('cull_catalog', 'true')
}

export const SystemAPI = {
  status: () =>
    request<SystemStatusResponse>('/status'),

  stats: () =>
    request<Stats>('/stats'),

  insightsSummary: () =>
    request<InsightsSummary>('/insights-summary'),

  visionModels: () =>
    request<VisionModelsResponse>('/vision-models'),

  cacheStatus: () =>
    request<CacheStatus>('/cache/status'),

  cachePipelineStatus: () =>
    request<CachePipelineStatus>('/cache/pipeline-status'),
}

export const ImagesAPI = {
  getCatalogMonths: () =>
    request<{ months: string[] }>('/images/catalog/months'),

  /** Catalog browse; use listCatalog(params) with optional filters. */
  listCatalog: (params?: CatalogListQueryParams) => {
    const searchParams = new URLSearchParams()
    appendCatalogListSearchParams(searchParams, params)
    const qs = searchParams.toString()
    return request<{ total: number; images: CatalogImage[] }>(
      `/images/catalog${qs ? `?${qs}` : ''}`
    )
  },

  /**
   * Single-image detail for the consolidated image-view modal. Always fetched
   * on modal open so tiles can pass just `image_type` + `key` without worrying
   * about partial list-row data (see consolidate-image-metadata plan).
   */
  getImageDetail: (
    image_type: 'catalog',
    image_key: string,
    params?: { score_perspective?: string },
  ) => {
    const qs = params?.score_perspective
      ? `?score_perspective=${encodeURIComponent(params.score_perspective)}`
      : ''
    return request<ImageDetailResponse>(
      `/images/${image_type}/${encodeURIComponent(image_key)}${qs}`,
    )
  },

  listCatalogSimilarityGroups: (params?: { limit?: number; offset?: number }) => {
    const sp = new URLSearchParams()
    if (params?.limit !== undefined) sp.set('limit', String(params.limit))
    if (params?.offset !== undefined) sp.set('offset', String(params.offset))
    const qs = sp.toString()
    return request<CatalogSimilarityGroupsResponse>(
      `/images/catalog-similarity-groups${qs ? `?${qs}` : ''}`,
    )
  },

  listStackSuggestions: (params?: { limit?: number; offset?: number }) => {
    const sp = new URLSearchParams()
    if (params?.limit !== undefined) sp.set('limit', String(params.limit))
    if (params?.offset !== undefined) sp.set('offset', String(params.offset))
    const qs = sp.toString()
    return request<StackSuggestionsResponse>(
      `/images/stacks/suggestions${qs ? `?${qs}` : ''}`,
    )
  },

  acceptStackSuggestion: async (imageKeyA: string, imageKeyB: string) => {
    const result = await request<StackSuggestionAcceptResponse>(
      '/images/stacks/suggestions/accept',
      {
        method: 'POST',
        body: JSON.stringify({ image_key_a: imageKeyA, image_key_b: imageKeyB }),
      },
    )
    invalidateAll(['stacks.suggestions'])
    invalidateAll(['images.catalog'])
    invalidateAll(['images.detail'])
    invalidateAll(['dashboard'])
    invalidateAll(['identity'])
    return result
  },

  rejectStackSuggestion: async (imageKeyA: string, imageKeyB: string) => {
    const result = await request<{ image_key_a: string; image_key_b: string; rejected: boolean }>(
      '/images/stacks/suggestions/reject',
      {
        method: 'POST',
        body: JSON.stringify({ image_key_a: imageKeyA, image_key_b: imageKeyB }),
      },
    )
    invalidateAll(['stacks.suggestions'])
    invalidateAll(['dashboard'])
    return result
  },

  getStackMembers: (stackId: number) =>
    request<{ items: CatalogImage[] }>(`/images/stacks/${stackId}/members`),

  splitStackMember: async (stackId: number, imageKey: string) => {
    const result = await request<StackSplitMemberResponse>(
      `/images/stacks/${stackId}/split-member`,
      {
        method: 'POST',
        body: JSON.stringify({ image_key: imageKey }),
      },
    )
    invalidateAll(['images.catalog'])
    invalidateAll(['images.detail'])
    invalidateAll(['dashboard'])
    invalidateAll(['identity'])
    return result
  },

  mergeStacks: async (targetStackId: number, sourceStackId: number) => {
    const result = await request<StackMergeResponse>(`/images/stacks/${targetStackId}/merge`, {
      method: 'POST',
      body: JSON.stringify({ source_stack_id: sourceStackId }),
    })
    invalidateAll(['images.catalog'])
    invalidateAll(['images.detail'])
    invalidateAll(['dashboard'])
    invalidateAll(['identity'])
    return result
  },

  setStackRepresentative: async (stackId: number, imageKey: string) => {
    const result = await request<StackRepresentativeResponse>(
      `/images/stacks/${stackId}/representative`,
      {
        method: 'POST',
        body: JSON.stringify({ image_key: imageKey }),
      },
    )
    invalidateAll(['images.catalog'])
    invalidateAll(['images.detail'])
    invalidateAll(['dashboard'])
    invalidateAll(['identity'])
    return result
  },

  setInstagramPosted: async (imageKey: string, posted: boolean) => {
    const result = await request<InstagramPostedResponse>(
      `/images/catalog/${encodeURIComponent(imageKey)}/instagram-posted`,
      {
        method: 'PATCH',
        body: JSON.stringify({ posted }),
      },
    )
    const detailPrefix = JSON.stringify(['images.detail']).slice(0, -1)
    patchMatching(
      (k) => k.startsWith(detailPrefix) && k.includes(imageKey),
      (raw) => ({ ...(raw as ImageView), instagram_posted: posted }),
    )
    const catalogPrefix = JSON.stringify(['images.catalog']).slice(0, -1)
    patchMatching(
      (k) => k.startsWith(catalogPrefix),
      (raw) => {
        const resp = raw as { images?: CatalogImage[]; items?: CatalogImage[] }
        const patchList = (rows: CatalogImage[] | undefined) =>
          rows?.map((row) =>
            row.key === imageKey ? { ...row, instagram_posted: posted } : row,
          )
        if (resp.images) {
          return { ...resp, images: patchList(resp.images) }
        }
        if (resp.items) {
          return { ...resp, items: patchList(resp.items) }
        }
        return raw
      },
    )
    invalidateAll(['images.catalog'])
    invalidateAll(['images.detail'])
    invalidateAll(['dashboard'])
    invalidateAll(['identity'])
    return result
  },
}

export const FrameSubstanceAPI = {
  get: (imageKey: string) =>
    request<FrameSubstanceResponse>(
      `/images/catalog/${encodeURIComponent(imageKey)}/frame-substance`,
    ),

  createOverride: (imageKey: string) =>
    request<FrameSubstanceOverrideResponse>(
      `/images/catalog/${encodeURIComponent(imageKey)}/frame-substance/override`,
      { method: 'POST' },
    ),

  deleteOverride: (imageKey: string) =>
    request<FrameSubstanceOverrideResponse>(
      `/images/catalog/${encodeURIComponent(imageKey)}/frame-substance/override`,
      { method: 'DELETE' },
    ),

  addCullKeyword: (imageKey: string) =>
    request<CullKeywordMutationResponse>(
      `/images/catalog/${encodeURIComponent(imageKey)}/cull-keyword`,
      { method: 'POST' },
    ),

  removeCullKeyword: (imageKey: string) =>
    request<CullKeywordMutationResponse>(
      `/images/catalog/${encodeURIComponent(imageKey)}/cull-keyword`,
      { method: 'DELETE' },
    ),
}

export const DescriptionsAPI = {
  get: (imageKey: string) =>
    request<DescriptionGetResponse>(
      `/descriptions/${encodeURIComponent(imageKey)}`
    ),
  list: (params?: { image_type?: string; described_only?: boolean; limit?: number; offset?: number }) => {
    const sp = new URLSearchParams()
    if (params?.image_type) sp.set('image_type', params.image_type)
    if (params?.described_only) sp.set('described_only', 'true')
    if (params?.limit) sp.set('limit', String(params.limit))
    if (params?.offset) sp.set('offset', String(params.offset))
    return request<DescriptionsListResponse>(
      `/descriptions/?${sp.toString()}`
    )
  },
  generate: async (
    imageKey: string,
    imageType: string,
    force = false,
    model?: string,
    providerId?: string,
    providerModel?: string,
  ) => {
    const result = await request<DescriptionGenerateResponse>(
      `/descriptions/${encodeURIComponent(imageKey)}/generate`,
      {
        method: 'POST',
        body: JSON.stringify({
          image_type: imageType,
          force,
          ...(model && { model }),
          ...(providerId && { provider_id: providerId }),
          ...(providerModel && { provider_model: providerModel }),
        }),
      },
    )
    invalidate(['descriptions', imageKey])
    invalidateAll(['images.detail', imageType, imageKey])
    return result
  },
}

export type DescriptionListResult = Awaited<ReturnType<typeof DescriptionsAPI.list>>

export const ScoresAPI = {
  getCurrent: (imageKey: string, params?: { image_type?: 'catalog' | 'instagram' }) => {
    const sp = new URLSearchParams()
    if (params?.image_type) sp.set('image_type', params.image_type)
    const qs = sp.toString()
    return request<ScoresCurrentResponse>(
      `/scores/${encodeURIComponent(imageKey)}${qs ? `?${qs}` : ''}`,
    )
  },

  getHistory: (
    imageKey: string,
    params: { perspective_slug: string; image_type?: 'catalog' | 'instagram' },
  ) => {
    const sp = new URLSearchParams()
    sp.set('perspective_slug', params.perspective_slug)
    if (params.image_type) sp.set('image_type', params.image_type)
    return request<ScoresHistoryResponse>(
      `/scores/${encodeURIComponent(imageKey)}/history?${sp.toString()}`,
    )
  },
}

// --- Identity (Phase 8) — GET /api/identity/best-photos, /api/identity/mirror, /api/identity/suggestions

export const IdentityAPI = {
  getBestPhotos: (params?: {
    limit?: number
    offset?: number
    min_perspectives?: number
    sort_by_date?: 'newest' | 'oldest'
    posted?: boolean
  }) => {
    const sp = new URLSearchParams()
    if (params?.limit !== undefined) sp.set('limit', String(params.limit))
    if (params?.offset !== undefined) sp.set('offset', String(params.offset))
    if (params?.min_perspectives !== undefined) {
      sp.set('min_perspectives', String(params.min_perspectives))
    }
    if (params?.sort_by_date) sp.set('sort_by_date', params.sort_by_date)
    if (params?.posted !== undefined) sp.set('posted', params.posted ? 'true' : 'false')
    const qs = sp.toString()
    return request<IdentityBestPhotosResponse>(`/identity/best-photos${qs ? `?${qs}` : ''}`)
  },

  getMirror: () => request<MirrorResponse>('/identity/mirror'),

  getMirrorLensExemplars: (
    slug: string,
    params?: { limit?: number; offset?: number },
  ) => {
    const sp = new URLSearchParams()
    if (params?.limit !== undefined) sp.set('limit', String(params.limit))
    if (params?.offset !== undefined) sp.set('offset', String(params.offset))
    const qs = sp.toString()
    return request<MirrorLensExemplarsResponse>(
      `/identity/mirror/lens/${encodeURIComponent(slug)}/exemplars${qs ? `?${qs}` : ''}`,
    )
  },

  getSuggestions: (params?: {
    limit?: number
    offset?: number
    sort_by_date?: 'newest' | 'oldest'
  }) => {
    const sp = new URLSearchParams()
    if (params?.limit !== undefined) sp.set('limit', String(params.limit))
    if (params?.offset !== undefined) sp.set('offset', String(params.offset))
    if (params?.sort_by_date) sp.set('sort_by_date', params.sort_by_date)
    const qs = sp.toString()
    return request<PostNextSuggestionsResponse>(`/identity/suggestions${qs ? `?${qs}` : ''}`)
  },
}

export const ProvidersAPI = {
  list: () => request<Provider[]>('/providers/'),
  listDescriptionModels: () =>
    request<DescriptionModelsResponse>('/providers/models/description'),
  health: (providerId: string) =>
    request<{ reachable: boolean; error?: string }>(
      `/providers/${encodeURIComponent(providerId)}/health`,
    ),
  listModels: (providerId: string) =>
    request<ProviderModel[]>(`/providers/${providerId}/models`),
  getFallbackOrder: () =>
    request<{ order: string[] }>('/providers/fallback-order'),
  getDefaults: () =>
    request<ProviderDefaults>('/providers/defaults'),
  updateFallbackOrder: async (order: string[]) => {
    const result = await request<{ order: string[] }>('/providers/fallback-order', {
      method: 'PUT',
      body: JSON.stringify({ order }),
    })
    invalidateAll(['providers.list'])
    return result
  },
  updateDefaults: async (defaults: Partial<ProviderDefaults>) => {
    const result = await request<ProviderDefaults>('/providers/defaults', {
      method: 'PUT',
      body: JSON.stringify(defaults),
    })
    invalidateAll(['providers.list'])
    invalidate(['providers.defaults'])
    return result
  },
  addModel: async (
    providerId: string,
    model: { id: string; name: string; vision: boolean },
  ) => {
    const result = await request<ProviderModel>(`/providers/${providerId}/models`, {
      method: 'POST',
      body: JSON.stringify(model),
    })
    invalidateAll(['providers.list'])
    return result
  },
  removeModel: async (providerId: string, modelId: string) => {
    const result = await request<{ deleted: boolean }>(
      `/providers/${providerId}/models/${encodeURIComponent(modelId)}`,
      { method: 'DELETE' },
    )
    invalidateAll(['providers.list'])
    return result
  },
  reorderModels: async (providerId: string, order: string[]) => {
    const result = await request<{ success: boolean }>(`/providers/${providerId}/models/order`, {
      method: 'PUT',
      body: JSON.stringify({ order }),
    })
    invalidateAll(['providers.list'])
    return result
  },
}

export type CullReviewSummary = components['schemas']['CullReviewSummaryResponse']
export type CullReviewListResponse = components['schemas']['CullReviewListResponse']
export type CullReviewRow = components['schemas']['CullReviewRow']
export type CullReviewDetail = components['schemas']['CullReviewDetail']
export type CullProfileDetail = components['schemas']['CullProfileDetail']
export type CullProfileSummary = components['schemas']['CullProfileSummary']
export type PipelineSettingResponse = components['schemas']['PipelineSettingResponse']
/** A new pipeline-setting version, and the re-decide job that applies it to every photo. */
export type PipelineChangeResponse = { version: number; redecide_job_id: string | null }

export const CullAPI = {
  summary: () => request<CullReviewSummary>('/cull/summary'),
  listPhotos: (params?: { tab?: string; limit?: number; offset?: number }) => {
    const sp = new URLSearchParams()
    if (params?.tab) sp.set('tab', params.tab)
    if (params?.limit !== undefined) sp.set('limit', String(params.limit))
    if (params?.offset !== undefined) sp.set('offset', String(params.offset))
    const qs = sp.toString()
    return request<CullReviewListResponse>(`/cull/photos/${qs ? `?${qs}` : ''}`)
  },
  photoDetail: (imageKey: string) =>
    request<CullReviewDetail>(`/cull/photos/${encodeURIComponent(imageKey)}`),
  recordAction: (imageKey: string, action: 'sent_by_hand' | 'agrees_with_filter' | 'should_have_been_filtered') =>
    request<{ ok: boolean }>(`/cull/photos/${encodeURIComponent(imageKey)}/actions`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),
  withdrawShouldHaveBeenFiltered: (imageKey: string) =>
    request<{ ok: boolean; removed: number }>(
      `/cull/photos/${encodeURIComponent(imageKey)}/actions/should_have_been_filtered`,
      { method: 'DELETE' },
    ),
  sendPhotos: (imageKeys: string[]) =>
    request<{ sent_by_hand: string[]; job_id: string | null; skipped_complete: number }>(
      '/cull/photos/send',
      { method: 'POST', body: JSON.stringify({ image_keys: imageKeys }) },
    ),
}

export const CullingProfilesAPI = {
  list: () => request<{ profiles: CullProfileSummary[] }>('/culling-profiles/'),
  get: (slug: string) => request<CullProfileDetail>(`/culling-profiles/${encodeURIComponent(slug)}`),
  create: (body: unknown) =>
    request<CullProfileDetail>('/culling-profiles/', { method: 'POST', body: JSON.stringify(body) }),
  duplicate: (slug: string, body: { new_slug: string; new_name?: string }) =>
    request<CullProfileDetail>(`/culling-profiles/${encodeURIComponent(slug)}/duplicate`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  saveDefinition: (
    slug: string,
    body: { definition: unknown; rule?: unknown; mode: 'save_only' | 'save_and_queue_cull' },
  ) =>
    request<{
      profile: CullProfileDetail
      version: number
      created: boolean
      impact: { photos: number; hours_estimate: number }
      cull_job_id: string | null
    }>(
      `/culling-profiles/${encodeURIComponent(slug)}/definition`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  saveRule: (slug: string, rule: unknown) =>
    request<{ profile: CullProfileDetail; pipeline_setting_version: number | null; redecide_job_id: string | null }>(
      `/culling-profiles/${encodeURIComponent(slug)}/rule`,
      { method: 'PUT', body: JSON.stringify({ rule }) },
    ),
  patch: (slug: string, body: { name?: string; model?: string; active?: boolean }) =>
    request<CullProfileDetail>(`/culling-profiles/${encodeURIComponent(slug)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  getPipeline: () => request<PipelineSettingResponse>('/culling-profiles/pipeline'),
  saveCullingProfileSwitches: (body: { enabled?: boolean; filter_enabled?: boolean }) =>
    request<PipelineChangeResponse>('/culling-profiles/pipeline/culling-profiles', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  saveScoreForecast: (body: { enabled?: boolean; threshold?: number; high_from_level?: number }) =>
    request<PipelineChangeResponse>('/culling-profiles/pipeline/score-forecast', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
}

export type AppModel = components['schemas']['AppModel']
export type AppModelsListResponse = components['schemas']['AppModelsListResponse']
export type AppModelAddResponse = components['schemas']['AppModelAddResponse']
export type AppModelPickResponse = components['schemas']['AppModelPickResponse']

/** Models in this app: installed on its System One endpoint, or converting in a job. */
export const AppModelsAPI = {
  list: () => request<AppModelsListResponse>('/app-models'),
  /** Queues the conversion job. */
  add: (source: string) =>
    request<AppModelAddResponse>('/app-models', { method: 'POST', body: JSON.stringify({ source }) }),
  /** Opens a folder dialog on the machine running the backend, like `ConfigAPI.pickCatalog`. */
  pick: () => request<AppModelPickResponse>('/app-models/pick', { method: 'POST' }, CATALOG_PICK_TIMEOUT_MS),
}

export type CullingModelsResponse = components['schemas']['CullingModelsResponse']
export type CullingStageModel = components['schemas']['CullingStageModel']
export type CullingStageModelPutRequest = components['schemas']['CullingStageModelPutRequest']
export type CullingStageModelsList = components['schemas']['CullingStageModelsList']
export type CullingStageKind = 'culling_profile' | 'score_forecast'
export type CullingModelsUsable = components['schemas']['CullingModelsUsableResponse']
export type CullingStageUsability = components['schemas']['CullingStageUsability']
export type CullingStageProblem = NonNullable<CullingStageUsability['problem']>

/** Each culling stage's System One endpoint and model, in `config.yaml`. */
export const CullingModelsAPI = {
  get: () => request<CullingModelsResponse>('/culling-models'),
  save: (stage: CullingStageKind, body: CullingStageModelPutRequest) =>
    request<CullingStageModel>(`/culling-models/${stage}`, { method: 'PUT', body: JSON.stringify(body) }),
  /** What the stage's saved endpoint lists: Check. */
  models: (stage: CullingStageKind) => request<CullingStageModelsList>(`/culling-models/${stage}/models`),
  /** Whether each stage that is on can run; asks every endpoint, so it can take up to Check's timeout. */
  usable: () => request<CullingModelsUsable>('/culling-models/usable'),
}

export type LrWritebackSettingsResponse = components['schemas']['LrWritebackSettingsResponse']
export type LrWritebackPhotoDetailResponse = components['schemas']['LrWritebackPhotoDetailResponse']

export const LrWritebackAPI = {
  getSettings: () => request<LrWritebackSettingsResponse>('/cull/lightroom-writeback/settings'),
  patchSettings: (body: {
    write_stars?: boolean
    write_reject?: boolean
    stars_profile_slug?: string | null
  }) =>
    request<LrWritebackSettingsResponse>('/cull/lightroom-writeback/settings', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  write: () =>
    request<{ job_id: string }>('/cull/lightroom-writeback/write', {
      method: 'POST',
    }),
  getPhoto: (imageKey: string) =>
    request<LrWritebackPhotoDetailResponse>(
      `/cull/lightroom-writeback/photos/${encodeURIComponent(imageKey)}`,
    ),
  undo: (imageKey: string, kind: 'stars' | 'reject') =>
    request<{ ok: boolean; reason?: string }>(
      `/cull/lightroom-writeback/photos/${encodeURIComponent(imageKey)}/undo`,
      { method: 'POST', body: JSON.stringify({ kind }) },
    ),
}
