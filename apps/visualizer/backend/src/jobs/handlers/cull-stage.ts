/**
 * In-job cull step before describe/score/analyze send photos to kimi (#339).
 */
import { performance } from 'node:perf_hooks';
import type { Db } from '../../db/connection.js';
import { listSentByHandKeys } from '../../db/library/cull-user-actions.js';
import type { JobRunner } from '../runner.js';
import {
  dropFilteredPhotosFromDescribeAndScoringSelection,
  filterVoidSubstanceFromScoringSelection,
  type PassContext,
} from './common.js';
import { runCullPass, type BatchCullResult } from './cull-pass.js';
import { runFrameSubstanceDetection, type FrameSubstanceRunResult } from './frame-substance.js';

export type JobResultCullSummary = Omit<
  BatchCullResult,
  'total' | 'durations_s' | 'laya_seconds' | 'stage_versions'
>;

export const CULL_STEP_LABEL = 'Culling';

export interface CullHeldBackCounts {
  void: number;
  filtered_by_culling_profile: number;
  filtered_by_score_forecast: number;
  pending: number;
  no_verdict: number;
  sent_by_hand_passed: number;
}

export interface CullStageDurations {
  frame_substance: number;
  cull: number;
}

export interface CullStageOutcome {
  keep: Set<string>;
  keptPairs: readonly (readonly [string, string])[];
  heldBack: CullHeldBackCounts;
  cullStep: BatchCullResult;
  durations: CullStageDurations;
}

const seconds = (from: number): number => Math.round((performance.now() - from) / 10) / 100;

/**
 * Frame substance → void filter → cull → frame-substance recheck → filtered/void filters.
 * Returns `null` when the job was cancelled during the step.
 */
export async function runCullStageBeforeDescribeAndScore(
  runner: JobRunner,
  jobId: string,
  metadata: Record<string, unknown>,
  db: Db,
  workKeys: readonly string[],
  selection: readonly (readonly [string, string])[],
  ctx: PassContext,
  opts: { forceCull?: boolean } = {},
): Promise<CullStageOutcome | null> {
  const prefix = ctx.logPrefix;
  let frameSubstanceS = 0;

  runner.setCurrentStep(jobId, 'Frame substance');
  const tFs = performance.now();
  if (workKeys.length > 0) {
    let fs: FrameSubstanceRunResult | null;
    try {
      fs = await runFrameSubstanceDetection(db, {
        imageKeys: workKeys,
        staleOnly: true,
        progress: (pct, message) =>
          runner.updateProgress(
            jobId,
            Math.trunc(ctx.progressRange[0] + ((ctx.progressRange[1] - ctx.progressRange[0]) * pct) / 200),
            `${prefix}${message}`,
          ),
        isCancelled: () => runner.isCancelled(jobId),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      runner.log(jobId, 'warning', `${prefix}[frame_substance] status=failed ${message}`);
      fs = null;
    }
    if (fs === null && runner.isCancelled(jobId)) {
      runner.finalizeCancelled(jobId);
      return null;
    }
    if (fs !== null && fs.total > 0) {
      runner.log(
        jobId,
        'info',
        `${prefix}[frame_substance] status=complete void=${fs.count_void} ` +
          `illegible=${fs.count_illegible} ok=${fs.count_ok} unknown=${fs.count_unknown}`,
      );
    }
  }
  frameSubstanceS = seconds(tFs);

  const workKeySetForPairs = new Set(workKeys);
  const workPairs = selection.filter(([k]) => workKeySetForPairs.has(k));
  const workKeySet = new Set(workPairs.map(([k]) => k));
  let candidates = filterVoidSubstanceFromScoringSelection(db, workPairs);
  const voidBeforeCull = workKeySet.size - new Set(candidates.map(([k]) => k)).size;
  const candidateKeys = [...new Set(candidates.map(([k]) => k))];

  runner.setCurrentStep(jobId, CULL_STEP_LABEL);
  const sentByHand = listSentByHandKeys(db);
  const cullStep =
    (await runCullPass(runner, jobId, metadata, db, ctx, {
      // Forced, the whole window is culled again, not only the photos this job will describe or score.
      imageKeys: opts.forceCull ? undefined : candidateKeys,
      skipLayaFor: sentByHand,
      force: opts.forceCull,
    })) ?? null;
  if (cullStep === null) return null;

  const tRecheck = performance.now();
  if (candidateKeys.length > 0) {
    try {
      const recheck = await runFrameSubstanceDetection(db, {
        imageKeys: candidateKeys,
        staleOnly: true,
        isCancelled: () => runner.isCancelled(jobId),
      });
      if (recheck === null && runner.isCancelled(jobId)) {
        runner.finalizeCancelled(jobId);
        return null;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      runner.log(jobId, 'warning', `${prefix}[frame_substance] recheck status=failed ${message}`);
    }
  }
  frameSubstanceS += seconds(tRecheck);

  const afterVoidFinal = filterVoidSubstanceFromScoringSelection(db, candidates);
  const voidHeldFinal =
    voidBeforeCull +
    (new Set(candidates.map(([k]) => k)).size - new Set(afterVoidFinal.map(([k]) => k)).size);
  const culled = dropFilteredPhotosFromDescribeAndScoringSelection(db, afterVoidFinal);
  const keep = new Set(culled.kept.map(([k]) => k));

  const heldBack: CullHeldBackCounts = {
    void: voidHeldFinal,
    filtered_by_culling_profile: culled.heldBack.filtered_by_culling_profile,
    filtered_by_score_forecast: culled.heldBack.filtered_by_score_forecast,
    pending: culled.heldBack.pending,
    no_verdict: culled.heldBack.no_verdict,
    sent_by_hand_passed: culled.sentByHandKept.length,
  };

  runner.log(
    jobId,
    'info',
    `${prefix}[cull] status=complete held_back void=${heldBack.void} filtered_profile=${heldBack.filtered_by_culling_profile} ` +
      `filtered_score_forecast=${heldBack.filtered_by_score_forecast} pending=${heldBack.pending} ` +
      `sent_by_hand_passed=${heldBack.sent_by_hand_passed} durations frame_substance=${frameSubstanceS} cull=${cullStep.durations_s.cull}`,
  );

  return {
    keep,
    keptPairs: [...culled.kept],
    heldBack,
    cullStep,
    durations: { frame_substance: frameSubstanceS, cull: cullStep.durations_s.cull },
  };
}

/** `cull`, `held_back`, and `durations_s` for describe/score/analyze job results. */
export function cullStageJobResultFields(
  stage: CullStageOutcome,
  passSeconds: { describe: number; score: number },
  tJobStart: number,
): {
  cull: JobResultCullSummary;
  held_back: CullHeldBackCounts;
  durations_s: { frame_substance: number; cull: number; describe: number; score: number; total: number };
} {
  const step = stage.cullStep;
  return {
    cull: {
      culled: step.culled,
      redecided: step.redecided,
      failed: step.failed,
      filtered_by_culling_profile: step.filtered_by_culling_profile,
      filtered_by_score_forecast: step.filtered_by_score_forecast,
      pending: step.pending,
      passed: step.passed,
      sent_by_hand_passed: step.sent_by_hand_passed,
      score_forecast: step.score_forecast,
      pipeline_setting_version: step.pipeline_setting_version,
      seconds_per_photo: step.seconds_per_photo,
      laya_started: step.laya_started,
    },
    held_back: stage.heldBack,
    durations_s: {
      frame_substance: stage.durations.frame_substance,
      cull: stage.durations.cull,
      describe: passSeconds.describe,
      score: passSeconds.score,
      total: Math.round((performance.now() - tJobStart) / 10) / 100,
    },
  };
}
