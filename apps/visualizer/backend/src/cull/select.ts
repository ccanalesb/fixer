/**
 * Which photos a cull run takes: those missing an answer a required stage needs, and those whose
 * summary was decided under other stage or pipeline-setting versions (re-decided, no model call).
 */
import type { Db } from '../db/connection.js';
import { loadAnsweredStageKeys } from '../db/library/cull-stages.js';
import { loadCullVerdictStamps } from '../db/library/cull-verdicts.js';
import { requiredStages } from './decide.js';
import { asksLast, stageVersionIds, type CullContext } from './persist.js';

const sameIds = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * `keys` in order, minus photos with nothing to do. Photos a stage's endpoint stopped answering on go last, so one
 * bad photo cannot stop every run before it does any work.
 */
export interface SelectPhotosToCullResult {
  keys: string[];
  /** Photos that would call a stage's model (not re-decide-only). */
  needsAnswers: Set<string>;
}

export interface SelectPhotosToCullOptions {
  /**
   * Re-ask the models on every photo, except those one of these cull runs already decided — the forced
   * job's earlier attempts, so a resumed job does not start over.
   */
  force?: { doneByRuns: ReadonlySet<number> };
}

export function selectPhotosToCull(
  db: Db,
  ctx: CullContext,
  keys: readonly string[],
  opts: SelectPhotosToCullOptions = {},
): SelectPhotosToCullResult {
  if (opts.force) return selectAllPhotosToCull(db, keys, opts.force.doneByRuns);
  // Every stage that is on is required on every photo, so a stage missing is a stage to ask.
  const active = requiredStages(ctx.pipeline.config, ctx.stages, {}, { scoreForecastAvailable: ctx.scoreForecastAvailable });
  const answered = loadAnsweredStageKeys(db, active);
  const stamps = loadCullVerdictStamps(db);
  const currentIds = stageVersionIds(ctx);

  const needsAnswers = (key: string): boolean => {
    const has = answered.get(key);
    return active.some((s) => !has?.has(s.stageKey));
  };

  const work: string[] = [];
  const diedOn: string[] = [];
  const needsLaya = new Set<string>();
  for (const key of keys) {
    const stamp = stamps.get(key);
    const stale =
      stamp === undefined ||
      stamp.pipelineSettingVersion !== ctx.pipeline.version ||
      !sameIds(stamp.stageVersionIds, currentIds);
    if (!stale && !needsAnswers(key)) continue;
    if (needsAnswers(key)) needsLaya.add(key);
    (asksLast(stamp?.pendingReason) ? diedOn : work).push(key);
  }
  return { keys: [...work, ...diedOn], needsAnswers: needsLaya };
}

function selectAllPhotosToCull(db: Db, keys: readonly string[], doneByRuns: ReadonlySet<number>): SelectPhotosToCullResult {
  const stamps = loadCullVerdictStamps(db);
  const work: string[] = [];
  const diedOn: string[] = [];
  for (const key of keys) {
    const stamp = stamps.get(key);
    // Left pending by an earlier attempt: taken again, so the resumed run counts its failures.
    if (stamp?.runId != null && doneByRuns.has(stamp.runId) && stamp.pendingReason === '') continue;
    (asksLast(stamp?.pendingReason) ? diedOn : work).push(key);
  }
  const selected = [...work, ...diedOn];
  return { keys: selected, needsAnswers: new Set(selected) };
}
