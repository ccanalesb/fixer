/**
 * The unified analyze job: cull, describe, then score over one selection (#339).
 */
import { performance } from 'node:perf_hooks';
import type { Db } from '../../db/connection.js';
import { fingerprintBatchDescribe, readAnalyzeCheckpoint } from '../checkpoint.js';
import type { JobRunner } from '../runner.js';
import {
  asMetadata,
  analyzeStage,
  failureSeverityFromError,
  resolveLibraryDbOrFail,
  withLibraryDb,
} from './common.js';
import { runCullStageBeforeDescribeAndScore, type CullHeldBackCounts } from './cull-stage.js';
import type { BatchCullResult } from './cull-pass.js';
import { runDescribePass, selectDescribeCandidates } from './describe.js';
import { mergeSkipReasonCounts } from './path-diagnostics.js';
import { runScorePass } from './score.js';
import { selectKeysWithDescribeWork, selectKeysWithScoreWork } from './work-keys.js';

const CULL_STAGE = analyzeStage([2, 30], '[cull] ', 'cull');
const DESCRIBE_STAGE = analyzeStage([31, 65], '[describe] ', 'describe');
const SCORE_STAGE = analyzeStage([65, 100], '[score] ', 'score');

interface StageOutcome {
  total: number;
  succeeded: number;
  failed: number;
  skipReasonCounts: unknown;
}

export interface BatchAnalyzeResult {
  describe_total: number;
  describe_succeeded: number;
  describe_failed: number;
  score_total: number;
  score_succeeded: number;
  score_failed: number;
  skip_reason_counts: Record<string, number>;
  cull?: Omit<BatchCullResult, 'total' | 'durations_s' | 'laya_seconds' | 'stage_versions'>;
  held_back?: CullHeldBackCounts;
  durations_s?: { frame_substance: number; cull: number; describe: number; score: number; total: number };
}

/** Cull, describe, then score every catalog image in the window, as one job. */
export async function handleBatchAnalyze(
  runner: JobRunner,
  jobId: string,
  rawMetadata: unknown,
): Promise<void> {
  const metadata = asMetadata(rawMetadata);
  try {
    const dbPath = resolveLibraryDbOrFail(runner, jobId);
    if (dbPath === null) return;

    await withLibraryDb(dbPath, async (db) => {
      const imageType = String(metadata['image_type'] ?? 'catalog');
      if (imageType !== 'catalog') {
        runner.failJob(jobId, 'image_type must be catalog');
        return;
      }

      const tJob = performance.now();
      const describeMetadata = { ...metadata, force: Boolean(metadata['force_describe']) };
      const scoreMetadata = { ...metadata, force: Boolean(metadata['force_score']) };

      const selection = selectDescribeCandidates(
        runner,
        jobId,
        db,
        metadata,
        Boolean(metadata['force_describe']),
      );

      const workKeys = [
        ...new Set([
          ...selectKeysWithDescribeWork(db, describeMetadata, selection),
          ...selectKeysWithScoreWork(db, scoreMetadata, selection),
        ]),
      ];

      runner.updateProgress(jobId, 0, 'Frame substance');
      const stage = await runCullStageBeforeDescribeAndScore(
        runner,
        jobId,
        metadata,
        db,
        workKeys,
        selection,
        CULL_STAGE,
      );
      if (stage === null) return;

      const tDescribe = performance.now();
      const describe = await runDescribeStage(runner, jobId, describeMetadata, db, stage.keptPairs);
      if (describe === null) return;
      const describeS = Math.round((performance.now() - tDescribe) / 10) / 100;

      runner.setCurrentStep(jobId, 'Scoring');
      const tScore = performance.now();
      const scoreSummary = await runScorePass(runner, jobId, scoreMetadata, db, stage.keptPairs, SCORE_STAGE);
      if (scoreSummary === null) return;
      const scoreS = Math.round((performance.now() - tScore) / 10) / 100;

      const result: BatchAnalyzeResult = {
        describe_total: describe.total,
        describe_succeeded: describe.succeeded,
        describe_failed: describe.failed,
        score_total: scoreSummary.total,
        score_succeeded: scoreSummary.scored,
        score_failed: scoreSummary.failed,
        skip_reason_counts: mergeSkipReasonCounts(
          describe.skipReasonCounts,
          scoreSummary.skip_reason_counts,
        ),
        cull: {
          culled: stage.cullStep.culled,
          redecided: stage.cullStep.redecided,
          failed: stage.cullStep.failed,
          cut_by_culling_recipe: stage.cullStep.cut_by_culling_recipe,
          cut_by_score_forecast: stage.cullStep.cut_by_score_forecast,
          pending: stage.cullStep.pending,
          sent: stage.cullStep.sent,
          sent_by_hand_passed: stage.cullStep.sent_by_hand_passed,
          score_forecast: stage.cullStep.score_forecast,
          pipeline_setting_version: stage.cullStep.pipeline_setting_version,
          seconds_per_photo: stage.cullStep.seconds_per_photo,
          laya_started: stage.cullStep.laya_started,
        },
        held_back: stage.heldBack,
        durations_s: {
          frame_substance: stage.durations.frame_substance,
          cull: stage.durations.cull,
          describe: describeS,
          score: scoreS,
          total: Math.round((performance.now() - tJob) / 10) / 100,
        },
      };
      runner.clearCheckpoint(jobId);
      runner.completeJob(jobId, result);
    });
  } catch (e) {
    runner.failJob(jobId, e instanceof Error ? e.message : String(e), failureSeverityFromError(e));
  }
}

async function runDescribeStage(
  runner: JobRunner,
  jobId: string,
  describeMetadata: Record<string, unknown>,
  db: Db,
  selection: readonly (readonly [string, string])[],
): Promise<StageOutcome | null> {
  const fingerprint = await fingerprintBatchDescribe(describeMetadata, selection);
  const checkpoint = readAnalyzeCheckpoint(runner.readMetadata(jobId));

  if (checkpoint.stage === 'score' && checkpoint.describe['fingerprint'] === fingerprint) {
    const total = Number(checkpoint.describe['total_at_start'] ?? 0);
    return {
      total: Number.isFinite(total) ? Math.trunc(total) : 0,
      succeeded: 0,
      failed: 0,
      skipReasonCounts: null,
    };
  }

  runner.setCurrentStep(jobId, 'Describing');
  const summary = await runDescribePass(runner, jobId, describeMetadata, db, selection, DESCRIBE_STAGE);
  if (summary === null) return null;
  return {
    total: summary.total,
    succeeded: summary.described,
    failed: summary.failed,
    skipReasonCounts: summary.skip_reason_counts,
  };
}
