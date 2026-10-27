/**
 * System and cache health API response models.
 *
 * Every model uses `.strict()` (`additionalProperties: false`). Field names stay
 * snake_case — they are the wire contract.
 */
import { z } from '@hono/zod-openapi';

export const SystemStatusResponse = z
  .object({ status: z.string() })
  .strict()
  .openapi('SystemStatusResponse');

export const Stats = z
  .object({
    catalog_images: z.int(),
    posted_to_instagram: z.int(),
    db_path: z.string(),
  })
  .strict()
  .openapi('Stats');

export const PerspectiveCoverageRow = z
  .object({
    slug: z.string(),
    display_name: z.string(),
    active: z.boolean(),
    scored_images: z.int(),
  })
  .strict()
  .openapi('PerspectiveCoverageRow');

export const FrameSubstanceRunSummary = z
  .object({
    detector_version: z.string(),
    finished_at: z.string(),
    breached: z.boolean(),
    breach_reason: z.string(),
  })
  .strict()
  .openapi('FrameSubstanceRunSummary');

export const InsightsSummary = z
  .object({
    first_catalog_import_completed: z.boolean(),
    catalog_images: z.int(),
    scoring_9_plus: z.int(),
    burst_stacks: z.int(),
    pending_stack_suggestions: z.int(),
    unscored_on_active_perspectives: z.int(),
    no_current_score: z.int(),
    perspective_coverage: z.array(PerspectiveCoverageRow),
    frame_substance_flagged: z.int(),
    frame_substance_unknown: z.record(z.string(), z.int()),
    frame_substance_run: FrameSubstanceRunSummary.nullable(),
  })
  .strict()
  .openapi('InsightsSummary');

export const VisionModelEntry = z
  .object({
    name: z.string(),
    provider_id: z.string().nullish(),
    default: z.boolean(),
  })
  .strict()
  .openapi('VisionModelEntry');

export const VisionModelsResponse = z
  .object({
    models: z.array(VisionModelEntry),
    fallback: z.boolean(),
  })
  .strict()
  .openapi('VisionModelsResponse');

export const CatalogCacheReadyResponse = z
  .object({ cached: z.boolean() })
  .strict()
  .openapi('CatalogCacheReadyResponse');

export const CacheStatus = z
  .object({
    total_images: z.int(),
    cached_images: z.int(),
    missing: z.int(),
    cache_size_mb: z.number(),
    cache_dir: z.string(),
  })
  .strict()
  .openapi('CacheStatus');

export const CachePipelineRun = z
  .object({
    job_id: z.string(),
    type: z.string(),
    status: z.string(),
    created_at: z.string(),
    started_at: z.string().nullish(),
    completed_at: z.string().nullish(),
    error: z.string().nullish(),
  })
  .strict()
  .openapi('CachePipelineRun');

export const CachePipelineStatus = z
  .object({
    catalog_sync: CachePipelineRun.nullish(),
    embed_catalog: CachePipelineRun.nullish(),
    stack_detect: CachePipelineRun.nullish(),
    catalog_similarity: CachePipelineRun.nullish(),
    catalog_cache_build: CachePipelineRun.nullish(),
  })
  .strict()
  .openapi('CachePipelineStatus');

export type SystemStatusResponse = z.infer<typeof SystemStatusResponse>;
export type Stats = z.infer<typeof Stats>;
export type InsightsSummary = z.infer<typeof InsightsSummary>;
export type VisionModelsResponse = z.infer<typeof VisionModelsResponse>;
export type CachePipelineStatus = z.infer<typeof CachePipelineStatus>;
export type CachePipelineRun = z.infer<typeof CachePipelineRun>;
