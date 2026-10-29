/**
 * Jobs API and socket payload models.
 *
 * `Job` is shared by the REST endpoints and the `job_created` / `job_updated`
 * socket emits, which is the point: the frontend applies a socket payload straight
 * into the same state a REST response populated, so the two must be the same shape.
 */
import { z } from '@hono/zod-openapi';
import { PaginationMeta } from './pagination.js';

export const JobStatus = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']);
export const JobLogLevel = z.enum(['debug', 'info', 'warning', 'error']);
export const ErrorSeverity = z.enum(['warning', 'error', 'critical']);
export const LibraryDbSource = z.enum(['env', 'config', 'default', 'none']);

/** Not `.strict()` — unknown keys on a log entry are allowed. */
export const JobLog = z
  .object({
    timestamp: z.string(),
    level: JobLogLevel,
    message: z.string(),
  })
  .openapi('JobLog');

export const Job = z
  .object({
    id: z.string(),
    type: z.string(),
    status: JobStatus,
    progress: z.int(),
    current_step: z.string().nullish(),
    clip_model_download_loaded_bytes: z.int().nullish(),
    clip_model_download_total_bytes: z.int().nullish(),
    logs: z.array(JobLog).default([]),
    logs_total: z.int().default(0),
    warning_count: z.int().default(0),
    error_count: z.int().default(0),
    last_log_at: z.string().nullish(),
    result: z.unknown().nullish(),
    error: z.string().nullish(),
    error_severity: ErrorSeverity.nullish(),
    created_at: z.string(),
    started_at: z.string().nullish(),
    completed_at: z.string().nullish(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    /** Present only on a cancel that changed nothing. */
    cancel_noop: z.boolean().nullish(),
    cancel_noop_reason: z.string().nullish(),
  })
  .strict()
  .openapi('Job');

export const JobCreateRequest = z
  .object({
    type: z.string(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .openapi('JobCreateRequest');

export const JobsListResponse = z
  .object({
    total: z.int(),
    data: z.array(Job),
    pagination: PaginationMeta,
  })
  .openapi('JobsListResponse');

/** `GET /api/jobs/active` returns a bare array. */
export const JobListResponse = z.array(Job).openapi('JobListResponse');

export const LibraryDbInfo = z
  .object({
    path: z.string().nullable(),
    source: LibraryDbSource,
    exists: z.boolean(),
    reason: z.string().nullish(),
  })
  .openapi('LibraryDbInfo');

export const JobsHealth = z
  .object({
    library_db: LibraryDbInfo,
    jobs_requiring_catalog: z.array(z.string()),
    catalog_available: z.boolean(),
  })
  .openapi('JobsHealth');

export const JobsProcessorHealth = z
  .object({
    running: z.boolean(),
    started_at: z.number().nullish(),
    last_iteration_at: z.number().nullish(),
    last_iteration_age_seconds: z.number().nullish(),
    iterations_total: z.int().default(0),
    current_job_id: z.string().nullish(),
    current_job_started_at: z.number().nullish(),
    pending_count: z.int().default(0),
    running_count: z.int().default(0),
    stale: z.boolean().default(false),
    stale_threshold_seconds: z.number(),
    last_error: z.string().nullish(),
  })
  .openapi('JobsProcessorHealth');

export const JobsRecoveredPayload = z
  .object({ job_ids: z.array(z.string()) })
  .openapi('JobsRecoveredPayload');

/**
 * `ErrorBody` subclasses spelled out rather than built with `.extend()`.
 *
 * Inheritance would emit `allOf: [$ref ErrorBody, { code }]` instead of a flat
 * object. The `error` field is repeated for that reason.
 */
export const CatalogUnavailableError = z
  .object({
    error: z.string(),
    code: z.literal('catalog_unavailable'),
    library_db: LibraryDbInfo,
  })
  .openapi('CatalogUnavailableError');

export const DbBusyError = z
  .object({
    error: z.string(),
    code: z.literal('db_busy'),
  })
  .openapi('DbBusyError');

export type Job = z.infer<typeof Job>;

/**
 * Keys whose checkpoint lists are replaced by a `*_count` tally on the wire.
 *
 * A resumed batch checkpoint holds every processed key, which for a 43,000-image
 * embed job is a multi-megabyte array. The UI only ever shows how many.
 */
const CLIP_DOWNLOAD_META_KEYS = [
  'clip_model_download_loaded_bytes',
  'clip_model_download_total_bytes',
] as const;

const CHECKPOINT_LIST_KEYS = [
  'processed_pairs',
  'processed_media_keys',
  'processed_image_keys',
  'processed_triplets',
] as const;

export function compactCheckpointLists(
  checkpoint: Record<string, unknown>,
): Record<string, unknown> {
  const compact = { ...checkpoint };
  for (const key of CHECKPOINT_LIST_KEYS) {
    const value = compact[key];
    if (Array.isArray(value)) {
      compact[`${key}_count`] = value.length;
      delete compact[key];
    }
  }
  return compact;
}

function liftClipDownloadFields<T extends Record<string, unknown>>(job: T): T {
  const metadata = job.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return job;
  const meta = metadata as Record<string, unknown>;
  const lifted: Record<string, unknown> = { ...job };
  for (const key of CLIP_DOWNLOAD_META_KEYS) {
    const value = meta[key];
    if (typeof value === 'number' && Number.isFinite(value)) lifted[key] = Math.trunc(value);
  }
  return lifted as T;
}

/** Replace bulky checkpoint lists with tallies, for a wire payload. */
export function compactJobPayload<T extends Record<string, unknown>>(job: T): T {
  const withClip = liftClipDownloadFields(job);
  const metadata = withClip.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return withClip;
  const checkpoint = (metadata as Record<string, unknown>).checkpoint;
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return withClip;
  return {
    ...withClip,
    metadata: {
      ...(metadata as Record<string, unknown>),
      checkpoint: compactCheckpointLists(checkpoint as Record<string, unknown>),
    },
  };
}
