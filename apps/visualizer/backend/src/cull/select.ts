/**
 * Which photos a cull run takes: those missing an answer a required stage needs, and those whose
 * summary was decided under other stage or pipeline-setting versions (re-decided, no model call).
 */
import type { Db } from '../db/connection.js';
import { loadAnsweredStageKeys, loadCurrentStageAnswers } from '../db/library/cull-stages.js';
import { loadCullVerdictStamps } from '../db/library/cull-verdicts.js';
import { missingStages, runsAfterCut, WORKER_DIED_REASON } from './answer-photo.js';
import { stageVersionIds, type CullContext } from './persist.js';

const sameIds = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * `keys` in order, minus photos with nothing to do. Photos the Laya worker died on go last, so one
 * bad photo cannot stop every run before it does any work.
 */
export function selectPhotosToCull(db: Db, ctx: CullContext, keys: readonly string[]): string[] {
  const cfg = ctx.pipeline.config;
  const forecastOn = ctx.scoreForecastAvailable && cfg.score_forecast.enabled;
  const active = ctx.stages.filter((s) => s.kind !== 'score_forecast' || forecastOn);
  // With every stage answered even on cut photos, a stage missing is a stage required: no need to
  // read the answers to know.
  const everyStageRuns = active.every((s) => runsAfterCut(cfg, s));
  const answered = loadAnsweredStageKeys(db, active);
  const stamps = loadCullVerdictStamps(db);
  const currentIds = stageVersionIds(ctx);

  const needsAnswers = (key: string): boolean => {
    const has = answered.get(key);
    if (!active.some((s) => !has?.has(s.stageKey))) return false;
    if (everyStageRuns) return true;
    const stored = loadCurrentStageAnswers(db, ctx.stages, [key]).get(key) ?? {};
    return missingStages(ctx, stored, false).length > 0;
  };

  const work: string[] = [];
  const diedOn: string[] = [];
  for (const key of keys) {
    const stamp = stamps.get(key);
    const stale =
      stamp === undefined ||
      stamp.pipelineSettingVersion !== ctx.pipeline.version ||
      !sameIds(stamp.stageVersionIds, currentIds);
    if (!stale && !needsAnswers(key)) continue;
    (stamp?.pendingReason === WORKER_DIED_REASON ? diedOn : work).push(key);
  }
  return [...work, ...diedOn];
}
