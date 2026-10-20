/**
 * The cull job, `batch_cull_photos_before_scoring`: Laya answers every stage of the pipeline setting
 * for photos with no current verdict, and each photo's summary row is decided from the answers.
 *
 * `runCullPass` lives in `cull-pass.ts` so the in-job cull step can import it without a cycle through
 * describe/score handlers.
 */
import {
  asMetadata,
  failureSeverityFromError,
  OWN_JOB,
  readIntOrNull,
  resolveDateWindow,
  resolveLibraryDbOrFail,
  selectCatalogKeys,
  withLibraryDb,
} from './common.js';
import { selectDescribeCandidates } from './describe.js';
import { BATCH_CULL_CHECKPOINT_MISMATCH, runCullPass, type BatchCullResult } from './cull-pass.js';
import { selectKeysWithDescribeWork, selectKeysWithScoreWork } from './work-keys.js';
import type { JobRunner } from '../runner.js';

export const BATCH_CULL_JOB_TYPE = 'batch_cull_photos_before_scoring';

export { BATCH_CULL_CHECKPOINT_MISMATCH, runCullPass, type BatchCullResult };

function readImageKeys(raw: unknown): string[] | null {
  return Array.isArray(raw) && raw.length > 0 ? raw.map((k) => String(k)) : null;
}

/** Cull the catalog (or `metadata.image_keys`): every photo with no current verdict. */
export async function handleBatchCullPhotosBeforeScoring(
  runner: JobRunner,
  jobId: string,
  rawMetadata: unknown,
): Promise<void> {
  const metadata = asMetadata(rawMetadata);
  try {
    const dbPath = resolveLibraryDbOrFail(runner, jobId);
    if (dbPath === null) return;
    await withLibraryDb(dbPath, async (db) => {
      let imageKeys = readImageKeys(metadata['image_keys']);
      const scope = metadata['scope_job_type'];
      if (scope === 'batch_describe') {
        const selection = selectDescribeCandidates(runner, jobId, db, metadata, Boolean(metadata['force']));
        imageKeys = selectKeysWithDescribeWork(db, metadata, selection);
      } else if (scope === 'batch_score') {
        const { months, year } = resolveDateWindow(metadata);
        const minRating = readIntOrNull(metadata['min_rating']);
        const selection = selectCatalogKeys(db, {
          months,
          year,
          minRating,
          undescribedOnly: false,
          excludeVoidSubstance: true,
        });
        imageKeys = selectKeysWithScoreWork(db, metadata, selection);
      }
      await runCullPass(runner, jobId, metadata, db, OWN_JOB, imageKeys?.length ? { imageKeys } : {});
    });
  } catch (e) {
    runner.failJob(jobId, e instanceof Error ? e.message : String(e), failureSeverityFromError(e));
  }
}
