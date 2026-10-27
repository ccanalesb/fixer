/**
 * The `catalog_cache_build` composite.
 *
 * Sync, embed, detect stacks, group near-duplicates — the four jobs a user would
 * otherwise start by hand, in the only order that works, since each stage reads
 * what the one before it wrote. Running them as one job is also what makes the
 * ordering enforceable: four separately queued jobs can be started out of order,
 * and stack detection over a half-filled embedding table quietly produces less.
 *
 * The stages are the same passes the standalone jobs run: each is given a quarter
 * of the progress bar and hands its summary back instead of completing the job.
 *
 * Stage 0 is the exception to "each stage reads what the one before wrote": the
 * three after it read `library.db`, which is there whether or not today's
 * additions arrived. So a sync that cannot open the catalog is logged and stepped
 * over rather than failing the chain.
 */
import type { Db } from '../../db/connection.js';
import { markFirstCatalogImportCompleted } from '../../db/library/bootstrap.js';
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
} from './common.js';
import { runEmbedPass, type BatchEmbedImageResult } from './embed.js';
import {
  runSimilarityPass,
  runStackDetectPass,
  type BatchCatalogSimilarityResult,
  type BatchStackDetectResult,
} from './stacks.js';

/**
 * A quarter of the bar each, over the 5–100 the passes report into.
 *
 * Equal quarters despite embed being far and away the longest stage: the split
 * is a promise about ordering, not a time estimate, and weighting it by a cost
 * that varies with how much of the catalog is already embedded would make the
 * bar's meaning depend on the previous run.
 */
const SYNC_STAGE = chainStage([5, 29], '[sync] ');
const EMBED_STAGE = chainStage([29, 52], '[embed] ');
const STACK_STAGE = chainStage([52, 76], '[stack] ');
const SIMILARITY_STAGE = chainStage([76, 100], '[similarity] ');

export interface CatalogCacheBuildResult {
  catalog_cache_build: true;
  fingerprint: string;
  sync: CatalogSyncStageResult;
  embed: BatchEmbedImageResult;
  stack: BatchStackDetectResult;
  similarity: BatchCatalogSimilarityResult;
}

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
    await withLibraryDb(dbPath, (db) => runChain(runner, jobId, metadata, db));
  } catch (e) {
    runner.failJob(jobId, e instanceof Error ? e.message : String(e), failureSeverityFromError(e));
  }
}

async function runChain(
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

  const banner = (text: string, level: 'info' | 'warning' = 'info'): void =>
    runner.log(jobId, level, `[catalog-cache-build] ${text}`);

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
  const sync = await runCatalogSyncPass(runner, jobId, metadata, db, SYNC_STAGE);
  if (sync === null) return;
  const syncFell = Boolean(sync.failed ?? sync.skipped);
  banner(
    `stage=sync status=complete added=${sync.added} stale=${sync.stale} ` +
      `locking_mode=${sync.locking_mode ?? 'unknown'}` +
      (sync.error === undefined ? '' : ` error=${sync.error}`),
    syncFell ? 'warning' : 'info',
  );
  if (cancelled()) return;

  // Each stage reads `force` under its own name, because a chain re-run usually
  // means "re-embed" or "re-stack", not both.
  runner.setCurrentStep(jobId, 'Embedding');
  banner('stage=embed status=start');
  const embedMetadata = { ...metadata, image_type: 'catalog', force: metadata['force_embed'] };
  const embed = await runEmbedPass(runner, jobId, embedMetadata, db, EMBED_STAGE);
  if (embed === null) return;
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
  if (cancelled()) return;

  runner.setCurrentStep(jobId, 'Stack detection');
  banner('stage=stack status=start');
  const stackMetadata = { ...metadata, force: metadata['force_stack'] };
  const stack = await runStackDetectPass(runner, jobId, stackMetadata, db, STACK_STAGE);
  if (stack === null) return;
  banner(
    `stage=stack status=complete stacks_created=${stack.stacks_created} ` +
      `images_skipped_no_date=${stack.images_skipped_no_date} ` +
      `images_skipped_already_stacked=${stack.images_skipped_already_stacked}`,
  );
  if (cancelled()) return;

  runner.setCurrentStep(jobId, 'Catalog similarity');
  banner('stage=similarity status=start');
  const similarity = await runSimilarityPass(runner, jobId, metadata, db, SIMILARITY_STAGE);
  if (similarity === null) return;
  banner(
    `stage=similarity status=complete groups_created=${similarity.groups_created} ` +
      `candidates_created=${similarity.candidates_created} ` +
      `skipped_non_primary=${similarity.skipped_non_primary} ` +
      `skipped_no_embedding=${similarity.skipped_no_embedding}`,
  );

  libraryWrite(db, () => markFirstCatalogImportCompleted(db));

  const result: CatalogCacheBuildResult = {
    catalog_cache_build: true,
    fingerprint,
    sync,
    embed,
    stack,
    similarity,
  };
  runner.completeJob(jobId, result);
}
