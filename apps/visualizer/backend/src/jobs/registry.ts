/**
 * Explicit job-type registry.
 *
 * `JOB_TYPES` is the single source of truth for dispatch, catalog requirements and
 * checkpoint co-location. Mirrors ADR-0006's explicit CLI `COMMANDS` list —
 * greppable, no decorators, no auto-discovery, so adding a job type is a visible
 * edit rather than a side effect of importing a module.
 */
import type { JobRunner } from './runner.js';
import { handleBatchAnalyze } from './handlers/analyze.js';
import { handleCatalogSync } from './handlers/catalog.js';
import { handleCatalogCacheBuild } from './handlers/catalog-cache.js';
import {
  BATCH_CULL_CHECKPOINT_MISMATCH,
  BATCH_CULL_JOB_TYPE,
  handleBatchCullPhotosBeforeScoring,
} from './handlers/cull.js';
import {
  BATCH_DESCRIBE_CHECKPOINT_MISMATCH,
  handleBatchDescribe,
  handleSingleDescribe,
} from './handlers/describe.js';
import { BATCH_EMBED_IMAGE_CHECKPOINT_MISMATCH, handleBatchEmbedImage } from './handlers/embed.js';
import { handleBatchFrameSubstance } from './handlers/frame-substance.js';
import { handleAppModelInstall } from './handlers/app-model-install.js';
import { LR_WRITEBACK_JOB_TYPE, handleLrWriteback } from './handlers/lr-writeback.js';
import { APP_MODEL_INSTALL_JOB_TYPE } from '../app-models/install.js';
import {
  BATCH_REDECIDE_JOB_TYPE,
  handleBatchRedecideCullVerdicts,
} from './handlers/redecide.js';
import {
  BATCH_SCORE_CHECKPOINT_MISMATCH,
  handleBatchScore,
  handleSingleScore,
} from './handlers/score.js';
import {
  BATCH_STACK_DETECT_CHECKPOINT_MISMATCH,
  handleBatchCatalogSimilarity,
  handleBatchStackDetect,
} from './handlers/stacks.js';

/**
 * A handler owns the job's outcome: it calls `completeJob` or `failJob` itself.
 * The processor only steps in for a handler that throws and leaves it running.
 */
export type JobHandler = (
  runner: JobRunner,
  jobId: string,
  metadata: unknown,
) => Promise<void>;

export interface JobType {
  name: string;
  handler: JobHandler;
  /**
   * Whether the handler opens the Lightroom catalog mirror.
   *
   * Gates enqueueing: `POST /api/jobs/` refuses a catalog-requiring type with a 422
   * when `library.db` is missing, rather than accepting a job that cannot run.
   */
  requiresCatalog: boolean;
  /**
   * Whether the job works on photos, so the processor brings the catalog cache up
   * to date first, inside the same job. False for the cache's own stages and for
   * jobs that read no photo.
   */
  needsCatalogCache: boolean;
  /** Message logged when a resumed checkpoint no longer matches the inputs. */
  checkpointMismatchMessage: string | null;
}

export const JOB_TYPES: readonly JobType[] = [
  {
    name: 'batch_describe',
    handler: handleBatchDescribe,
    requiresCatalog: true,
    needsCatalogCache: true,
    checkpointMismatchMessage: BATCH_DESCRIBE_CHECKPOINT_MISMATCH,
  },
  {
    name: 'single_describe',
    handler: handleSingleDescribe,
    requiresCatalog: true,
    needsCatalogCache: true,
    checkpointMismatchMessage: null,
  },
  {
    name: 'single_score',
    handler: handleSingleScore,
    requiresCatalog: true,
    needsCatalogCache: true,
    checkpointMismatchMessage: null,
  },
  {
    name: 'batch_score',
    handler: handleBatchScore,
    requiresCatalog: true,
    needsCatalogCache: true,
    checkpointMismatchMessage: BATCH_SCORE_CHECKPOINT_MISMATCH,
  },
  {
    name: 'batch_analyze',
    handler: handleBatchAnalyze,
    requiresCatalog: true,
    // Null because the composite has two checkpoints, not one: each stage logs its
    // own mismatch message, which this single field cannot hold.
    needsCatalogCache: true,
    checkpointMismatchMessage: null,
  },
  {
    name: 'batch_stack_detect',
    handler: handleBatchStackDetect,
    requiresCatalog: true,
    needsCatalogCache: false,
    checkpointMismatchMessage: BATCH_STACK_DETECT_CHECKPOINT_MISMATCH,
  },
  {
    name: 'batch_catalog_similarity',
    handler: handleBatchCatalogSimilarity,
    requiresCatalog: true,
    needsCatalogCache: false,
    checkpointMismatchMessage: null,
  },
  {
    name: 'batch_embed_image',
    handler: handleBatchEmbedImage,
    requiresCatalog: true,
    needsCatalogCache: false,
    checkpointMismatchMessage: BATCH_EMBED_IMAGE_CHECKPOINT_MISMATCH,
  },
  {
    name: 'batch_frame_substance',
    handler: handleBatchFrameSubstance,
    // Reads only the vision cache, but the cache check before it needs the catalog.
    requiresCatalog: true,
    needsCatalogCache: true,
    checkpointMismatchMessage: null,
  },
  {
    name: BATCH_CULL_JOB_TYPE,
    handler: handleBatchCullPhotosBeforeScoring,
    requiresCatalog: true,
    needsCatalogCache: true,
    checkpointMismatchMessage: BATCH_CULL_CHECKPOINT_MISMATCH,
  },
  {
    name: BATCH_REDECIDE_JOB_TYPE,
    handler: handleBatchRedecideCullVerdicts,
    requiresCatalog: true,
    needsCatalogCache: false,
    checkpointMismatchMessage: null,
  },
  {
    name: LR_WRITEBACK_JOB_TYPE,
    handler: handleLrWriteback,
    requiresCatalog: true,
    needsCatalogCache: false,
    checkpointMismatchMessage: null,
  },
  {
    name: 'catalog_sync',
    handler: handleCatalogSync,
    requiresCatalog: true,
    needsCatalogCache: false,
    checkpointMismatchMessage: null,
  },
  {
    name: 'catalog_cache_build',
    handler: handleCatalogCacheBuild,
    requiresCatalog: true,
    needsCatalogCache: false,
    checkpointMismatchMessage: null,
  },
  {
    name: APP_MODEL_INSTALL_JOB_TYPE,
    handler: handleAppModelInstall,
    // Converts into `app_models_dir`; reads neither library.db nor the catalog.
    requiresCatalog: false,
    needsCatalogCache: false,
    checkpointMismatchMessage: null,
  },
];

export const JOB_TYPES_BY_NAME: ReadonlyMap<string, JobType> = new Map(
  JOB_TYPES.map((jt) => [jt.name, jt]),
);

/** Job types whose handlers open the Lightroom catalog SQLite mirror. */
export function catalogRequiringJobTypes(): Set<string> {
  return new Set(JOB_TYPES.filter((jt) => jt.requiresCatalog).map((jt) => jt.name));
}
