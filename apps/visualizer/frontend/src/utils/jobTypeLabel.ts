import type { Job } from '../types/job'
import {
  CATALOG_CACHE_BUILD_CTA,
  CATALOG_CACHE_EMBED_CATALOG_LABEL,
  CATALOG_CACHE_SIMILARITY_LABEL,
  CATALOG_CACHE_STACK_DETECT_LABEL,
  CATALOG_CACHE_SYNC_LABEL,
} from '../constants/strings'

const JOB_TYPE_LABELS: Record<string, string> = {
  batch_analyze: 'Analyze',
  batch_describe: 'Describe',
  batch_score: 'Score',
  batch_cull_photos_before_scoring: 'Cull photos',
  batch_redecide_cull_verdicts: 'Re-decide culling',
  batch_embed_image: CATALOG_CACHE_EMBED_CATALOG_LABEL,
  batch_stack_detect: CATALOG_CACHE_STACK_DETECT_LABEL,
  batch_catalog_similarity: CATALOG_CACHE_SIMILARITY_LABEL,
  batch_frame_substance: 'Frame substance',
  catalog_sync: CATALOG_CACHE_SYNC_LABEL,
  catalog_cache_build: CATALOG_CACHE_BUILD_CTA,
  lr_writeback: 'Lightroom write-back',
  app_model_install: 'Install app model',
  single_describe: 'Describe one photo',
  single_score: 'Score one photo',
}

/** User-facing job type label for lists such as Job Queue and catalog switch modals. */
export function jobTypeLabel(type: Job['type'] | string): string {
  return JOB_TYPE_LABELS[type] ?? type
}
