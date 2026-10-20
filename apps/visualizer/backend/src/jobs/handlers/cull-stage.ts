/**
 * In-job cull step before describe/score/analyze send photos to kimi (#339).
 */
import { performance } from 'node:perf_hooks';
import type { Db } from '../../db/connection.js';
import { listSentByHandKeys } from '../../db/library/cull-user-actions.js';
import type { JobRunner } from '../runner.js';
import {
  filterCutPhotosFromDescribeAndScoringSelection,
  filterVoidSubstanceFromScoringSelection,
  type PassContext,
} from './common.js';
import { runCullPass, type BatchCullResult } from './cull-pass.js';
import { runFrameSubstanceDetection, type FrameSubstanceRunResult } from './frame-substance.js';

export const CULL_STEP_LABEL = 'Culling';

export interface CullHeldBackCounts {
  void: number;
  cut_by_culling_recipe: number;
  cut_by_score_forecast: number;
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
 * Frame substance → void filter → cull → frame-substance recheck → cut/void filters.
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

  const workPairs = selection.filter(([k]) => workKeys.includes(k));
  const workKeySet = new Set(workPairs.map(([k]) => k));
  let candidates = filterVoidSubstanceFromScoringSelection(db, workPairs);
  const voidBeforeCull = workKeySet.size - new Set(candidates.map(([k]) => k)).size;
  const candidateKeys = [...new Set(candidates.map(([k]) => k))];

  runner.setCurrentStep(jobId, CULL_STEP_LABEL);
  const sentByHand = listSentByHandKeys(db);
  const cullStep =
    (await runCullPass(runner, jobId, metadata, db, ctx, {
      imageKeys: candidateKeys,
      skipLayaFor: sentByHand,
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

  const unknownKeys = candidateKeys.filter((k) => {
    const row = db
      .prepare('SELECT verdict FROM image_frame_substance WHERE image_key = ?')
      .get(k) as { verdict: string } | undefined;
    return row === undefined || row.verdict === 'unknown';
  });
  if (unknownKeys.length > 0) {
    try {
      await runFrameSubstanceDetection(db, {
        imageKeys: unknownKeys,
        staleOnly: false,
        isCancelled: () => runner.isCancelled(jobId),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      runner.log(jobId, 'warning', `${prefix}[frame_substance] unknown recheck status=failed ${message}`);
    }
  }
  const afterVoidFinal = filterVoidSubstanceFromScoringSelection(db, candidates);
  const voidHeldFinal =
    voidBeforeCull +
    (new Set(candidates.map(([k]) => k)).size - new Set(afterVoidFinal.map(([k]) => k)).size);
  const cut = filterCutPhotosFromDescribeAndScoringSelection(db, afterVoidFinal);
  const keep = new Set(cut.kept.map(([k]) => k));

  const heldBack: CullHeldBackCounts = {
    void: voidHeldFinal,
    cut_by_culling_recipe: cut.heldBack.cut_by_culling_recipe,
    cut_by_score_forecast: cut.heldBack.cut_by_score_forecast,
    pending: cut.heldBack.pending,
    no_verdict: cut.heldBack.no_verdict,
    sent_by_hand_passed: cut.sentByHandKept.length,
  };

  runner.log(
    jobId,
    'info',
    `${prefix}[cull] status=complete held_back void=${heldBack.void} cut_recipe=${heldBack.cut_by_culling_recipe} ` +
      `cut_score_forecast=${heldBack.cut_by_score_forecast} pending=${heldBack.pending} ` +
      `sent_by_hand_passed=${heldBack.sent_by_hand_passed} durations frame_substance=${frameSubstanceS} cull=${cullStep.durations_s.cull}`,
  );

  return {
    keep,
    keptPairs: [...cut.kept],
    heldBack,
    cullStep,
    durations: { frame_substance: frameSubstanceS, cull: cullStep.durations_s.cull },
  };
}
