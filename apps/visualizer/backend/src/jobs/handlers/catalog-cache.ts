/**
 * The catalog cache: the `catalog_cache_build` job, and the same stages run as the
 * first step of every job that works on photos.
 *
 * Sync, embed, detect stacks, group near-duplicates — in the only order that works,
 * since each stage reads what the one before it wrote. Running them as one unit is
 * also what makes the ordering enforceable: four separately queued jobs can be
 * started out of order, and stack detection over a half-filled embedding table
 * quietly produces less. The embed stage is also what writes each photo's preview
 * into the vision cache, which every later model reads instead of the original.
 *
 * The stages are the same passes the standalone jobs run: each is given a band of
 * the progress bar and hands its summary back instead of completing the job.
 *
 * Stage 0 is the exception to "each stage reads what the one before wrote": the
 * three after it read `library.db`, which is there whether or not today's
 * additions arrived. So a sync that cannot open the catalog is logged and stepped
 * over rather than failing the chain.
 */
import type { Db } from '../../db/connection.js';
import {
  catalogCacheBuilt,
  markCatalogCacheBuilt,
  markFirstCatalogImportCompleted,
} from '../../db/library/bootstrap.js';
import { libraryWrite } from '../../db/library/write.js';
import { listCatalogKeysNeedingClipEmbedding } from '../../db/library/embeddings.js';
import { fingerprintCatalogCacheBuild } from '../checkpoint.js';
import type { JobRunner } from '../runner.js';
import { runCatalogSyncPass, type CatalogSyncStageResult } from './catalog.js';
import {
  asMetadata,
  failureSeverityFromError,
  readIntOrNull,
  resolveDateWindow,
  resolveLibraryDbOrFail,
  withLibraryDb,
  chainStage,
  type PassContext,
} from './common.js';
import { runEmbedPass, type BatchEmbedImageResult } from './embed.js';
import {
  runSimilarityPass,
  runStackDetectPass,
  type BatchCatalogSimilarityResult,
  type BatchStackDetectResult,
} from './stacks.js';

interface CacheStages {
  sync: PassContext;
  embed: PassContext;
  stack: PassContext;
  similarity: PassContext;
}

/**
 * A quarter of the bar each, over the 5–100 the passes report into.
 *
 * Equal quarters despite embed being far and away the longest stage: the split
 * is a promise about ordering, not a time estimate, and weighting it by a cost
 * that varies with how much of the catalog is already embedded would make the
 * bar's meaning depend on the previous run.
 */
const BUILD_STAGES: CacheStages = {
  sync: chainStage([5, 29], '[sync] '),
  embed: chainStage([29, 52], '[embed] '),
  stack: chainStage([52, 76], '[stack] '),
  similarity: chainStage([76, 100], '[similarity] '),
};

/** Where the cache check ends on the bar of the job it runs in; the job's own work takes the rest. */
export const CACHE_CHECK_PROGRESS_END = 20;

const CHECK_STAGES: CacheStages = {
  sync: chainStage([0, 5], '[cache] [sync] '),
  embed: chainStage([5, 15], '[cache] [embed] '),
  stack: chainStage([15, 18], '[cache] [stack] '),
  similarity: chainStage([18, CACHE_CHECK_PROGRESS_END], '[cache] [similarity] '),
};

export interface CatalogCacheBuildResult {
  catalog_cache_build: true;
  fingerprint: string;
  sync: CatalogSyncStageResult;
  embed: BatchEmbedImageResult;
  stack: BatchStackDetectResult;
  similarity: BatchCatalogSimilarityResult;
}

interface CacheStagesResult {
  sync: CatalogSyncStageResult;
  embed: BatchEmbedImageResult;
  /** Null when nothing changed since the last full run, so ranking was not redone. */
  ranking: { stack: BatchStackDetectResult; similarity: BatchCatalogSimilarityResult } | null;
}

type Banner = (text: string, level?: 'info' | 'warning') => void;

/** Build everything the catalog grid reads, in one job. */
export async function handleCatalogCacheBuild(
  runner: JobRunner,
  jobId: string,
  rawMetadata: unknown,
): Promise<void> {
  const metadata = asMetadata(rawMetadata);
  try {
    const dbPath = resolveLibraryDbOrFail(runner, jobId);
    if (dbPath === null) return;
    await withLibraryDb(dbPath, (db) => runBuild(runner, jobId, metadata, db));
  } catch (e) {
    runner.failJob(jobId, e instanceof Error ? e.message : String(e), failureSeverityFromError(e));
  }
}

/**
 * Bring the catalog cache up to date before a job's own work.
 *
 * Covers the whole catalog, whatever the job's own filters: a sync with Lightroom,
 * previews and embeddings for every photo missing one, then stacks and similarity
 * unless nothing changed since they last ran. Returns false when a stage settled
 * the job (failed or cancelled), in which case the job's own work must not run.
 */
export async function ensureCatalogCache(
  runner: JobRunner,
  jobId: string,
  jobType: string,
): Promise<boolean> {
  try {
    const dbPath = resolveLibraryDbOrFail(runner, jobId);
    if (dbPath === null) return false;
    const banner: Banner = (text, level = 'info') => runner.log(jobId, level, `[cache] ${text}`);
    const done = await withLibraryDb(dbPath, async (db) => {
      banner(`checking the catalog cache before ${jobType}`);
      const result = await runCacheStages(runner, jobId, {}, db, CHECK_STAGES, banner, {
        skipRankingWhenCurrent: true,
      });
      if (result === null) return false;
      const { sync, embed, ranking } = result;
      if (ranking === null) {
        banner('cache up to date');
      } else {
        banner(
          `cache built: added=${sync.added} stale=${sync.stale} embedded=${embed.embedded} ` +
            `skipped=${embed.skipped} failed=${embed.failed}`,
        );
      }
      return true;
    });
    if (done) runner.setProgressFloor(jobId, CACHE_CHECK_PROGRESS_END);
    return done;
  } catch (e) {
    runner.failJob(jobId, e instanceof Error ? e.message : String(e), failureSeverityFromError(e));
    return false;
  }
}

async function runBuild(
  runner: JobRunner,
  jobId: string,
  metadata: Record<string, unknown>,
  db: Db,
): Promise<void> {
  const { months, year } = resolveDateWindow(metadata);
  const fingerprint = await fingerprintCatalogCacheBuild(metadata, {
    resolvedMonths: months,
    resolvedYear: year,
  });

  const banner: Banner = (text, level = 'info') =>
    runner.log(jobId, level, `[catalog-cache-build] ${text}`);

  const result = await runCacheStages(runner, jobId, metadata, db, BUILD_STAGES, banner, {
    skipRankingWhenCurrent: false,
  });
  if (result === null || result.ranking === null) return;

  // A catalog with no photos yet builds nothing; first run stays open so the
  // setup screen asks again once Lightroom has photos.
  if (countLibraryImages(db) === 0) {
    banner('warning=empty_catalog The Lightroom catalog has no photos yet', 'warning');
  } else {
    libraryWrite(db, () => markFirstCatalogImportCompleted(db));
  }

  const built: CatalogCacheBuildResult = {
    catalog_cache_build: true,
    fingerprint,
    sync: result.sync,
    embed: result.embed,
    stack: result.ranking.stack,
    similarity: result.ranking.similarity,
  };
  runner.completeJob(jobId, built);
}

function countLibraryImages(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM images').get() as { c: number };
  return Math.trunc(row.c);
}

/** Run the cache stages in order. Null when a stage settled the job. */
async function runCacheStages(
  runner: JobRunner,
  jobId: string,
  metadata: Record<string, unknown>,
  db: Db,
  stages: CacheStages,
  banner: Banner,
  opts: { skipRankingWhenCurrent: boolean },
): Promise<CacheStagesResult | null> {
  const { months, year } = resolveDateWindow(metadata);

  /**
   * Whether the user cancelled since the last stage.
   *
   * A pass settles a cancel it notices mid-stage itself; this catches one that
   * arrives in the gap between two, where nothing is polling.
   */
  const cancelled = (): boolean => {
    if (!runner.isCancelled(jobId)) return false;
    runner.finalizeCancelled(jobId);
    return true;
  };

  banner('chain_start sync→embed→stack_detect→catalog_similarity');

  runner.setCurrentStep(jobId, 'Catalog sync');
  banner('stage=sync status=start');
  const sync = await runCatalogSyncPass(runner, jobId, metadata, db, stages.sync);
  if (sync === null) return null;
  const syncFell = Boolean(sync.failed ?? sync.skipped);
  banner(
    `stage=sync status=complete added=${sync.added} stale=${sync.stale} ` +
      `locking_mode=${sync.locking_mode ?? 'unknown'}` +
      (sync.error === undefined ? '' : ` error=${sync.error}`),
    syncFell ? 'warning' : 'info',
  );
  if (cancelled()) return null;

  // Each stage reads `force` under its own name, because a chain re-run usually
  // means "re-embed" or "re-stack", not both.
  runner.setCurrentStep(jobId, 'Embedding');
  banner('stage=embed status=start');
  const embedMetadata = { ...metadata, image_type: 'catalog', force: metadata['force_embed'] };
  const embed = await runEmbedPass(runner, jobId, embedMetadata, db, stages.embed);
  if (embed === null) return null;
  banner(
    `stage=embed status=complete embedded=${embed.embedded} skipped=${embed.skipped} ` +
      `failed=${embed.failed}`,
  );

  // Stack detection and similarity both rank over the vectors, and both degrade
  // quietly when some are missing — an unreadable file skipped by embed becomes an
  // image that simply never matches anything. Said out loud so a thin result has a
  // recorded reason.
  const unembedded = listCatalogKeysNeedingClipEmbedding(db, {
    months,
    year,
    minRating: readIntOrNull(metadata['min_rating']),
  }).length;
  if (unembedded > 0) {
    banner(`stage=embed warning=incomplete_embeddings count=${unembedded} proceeding`, 'warning');
  }
  if (cancelled()) return null;

  // Similarity is recomputed from scratch each time, so a check that found nothing
  // new leaves the last full run's ranking in place.
  const unchanged = sync.added === 0 && sync.stale === 0 && embed.embedded === 0;
  if (opts.skipRankingWhenCurrent && unchanged && catalogCacheBuilt(db)) {
    return { sync, embed, ranking: null };
  }

  runner.setCurrentStep(jobId, 'Stack detection');
  banner('stage=stack status=start');
  const stackMetadata = { ...metadata, force: metadata['force_stack'] };
  const stack = await runStackDetectPass(runner, jobId, stackMetadata, db, stages.stack);
  if (stack === null) return null;
  banner(
    `stage=stack status=complete stacks_created=${stack.stacks_created} ` +
      `images_skipped_no_date=${stack.images_skipped_no_date} ` +
      `images_skipped_already_stacked=${stack.images_skipped_already_stacked}`,
  );
  if (cancelled()) return null;

  runner.setCurrentStep(jobId, 'Catalog similarity');
  banner('stage=similarity status=start');
  const similarity = await runSimilarityPass(runner, jobId, metadata, db, stages.similarity);
  if (similarity === null) return null;
  banner(
    `stage=similarity status=complete groups_created=${similarity.groups_created} ` +
      `candidates_created=${similarity.candidates_created} ` +
      `skipped_non_primary=${similarity.skipped_non_primary} ` +
      `skipped_no_embedding=${similarity.skipped_no_embedding}`,
  );

  libraryWrite(db, () => markCatalogCacheBuilt(db));
  return { sync, embed, ranking: { stack, similarity } };
}
