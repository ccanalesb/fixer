/**
 * Re-decide every culled photo from stored answers — no model call, no endpoint.
 */
import { performance } from 'node:perf_hooks';
import type { Db } from '../db/connection.js';
import { getCurrentPipelineSetting } from '../db/library/cull-pipeline.js';
import { seedCullingDefaults } from '../db/library/cull-profiles.js';
import { loadCurrentStageAnswers, readStoredStageModelIds } from '../db/library/cull-stages.js';
import { listSentByHandKeys } from '../db/library/cull-user-actions.js';
import { finishCullRun, getCullVerdict, insertCullRun, listCulledImageKeys } from '../db/library/cull-verdicts.js';
import { libraryWrite } from '../db/library/write.js';
import { createEventLoopYieldState, pollCancelAndYield, type EventLoopYieldState } from '../utils/yield.js';
import { decideAndStorePhoto, type CullContext } from './persist.js';
import { resolveCurrentStages } from './stages.js';

const CHUNK = 500;

export interface RedecideAllPhotosResult {
  total: number;
  changed: number;
  filtered_by_culling_profile: number;
  filtered_by_score_forecast: number;
  pending: number;
  passed: number;
  sent_by_hand_passed: number;
  pipeline_setting_version: number;
  stage_versions: Record<string, number>;
  durations_s: { redecide: number; total: number };
}

export async function redecideAllPhotos(
  db: Db,
  opts: {
    isCancelled: () => boolean;
    onProgress?: (pct: number, message: string) => void;
    yieldState?: EventLoopYieldState;
  },
): Promise<RedecideAllPhotosResult> {
  const t0 = performance.now();
  seedCullingDefaults(db);
  const pipeline = getCurrentPipelineSetting(db);
  const ids = readStoredStageModelIds(db);
  if (ids.culling_profile === null && ids.score_forecast === null) {
    return {
      total: 0,
      changed: 0,
      filtered_by_culling_profile: 0,
      filtered_by_score_forecast: 0,
      pending: 0,
      passed: 0,
      sent_by_hand_passed: 0,
      pipeline_setting_version: pipeline.version,
      stage_versions: {},
      durations_s: { redecide: 0, total: 0 },
    };
  }

  const stages = resolveCurrentStages(db, pipeline.config, ids);
  const scoreForecastAvailable = ids.score_forecast !== null;
  const ctx: CullContext = { stages, pipeline, scoreForecastAvailable };
  const stageVersions = Object.fromEntries(stages.map((s) => [s.stageKey, s.versionId]));
  const keys = listCulledImageKeys(db);
  const sentByHand = listSentByHandKeys(db);
  const runId = libraryWrite(db, () =>
    insertCullRun(db, { kind: 'redecide', jobId: null, pipelineSettingVersion: pipeline.version }),
  );

  const counts = {
    changed: 0,
    filtered_by_culling_profile: 0,
    filtered_by_score_forecast: 0,
    pending: 0,
    passed: 0,
    sent_by_hand_passed: 0,
  };
  const yieldState = opts.yieldState ?? createEventLoopYieldState();
  const tRedecide = performance.now();

  for (let i = 0; i < keys.length; i += CHUNK) {
    if (await pollCancelAndYield(db, opts.isCancelled, yieldState)) {
      libraryWrite(db, () => finishCullRun(db, runId, { status: 'cancelled', ...counts, total: keys.length }));
      throw new RedecideCancelled();
    }
    const chunk = keys.slice(i, i + CHUNK);
    libraryWrite(db, () => {
      const answers = loadCurrentStageAnswers(db, stages, chunk);
      for (const key of chunk) {
        const before = getCullVerdict(db, key);
        const decision = decideAndStorePhoto(db, ctx, {
          imageKey: key,
          stored: answers.get(key) ?? {},
          sentByHand: sentByHand.has(key),
          runId,
          pendingReason: before?.pending_reason,
        });
        if (
          before?.verdict !== decision.verdict ||
          before?.filtered_by !== decision.filteredBy ||
          before?.pipeline_setting_version !== pipeline.version
        ) {
          counts.changed += 1;
        }
        if (decision.verdict === 'pending') counts.pending += 1;
        else if (decision.verdict === 'passed') counts.passed += 1;
        else if (decision.filteredBy === 'culling_profile') counts.filtered_by_culling_profile += 1;
        else counts.filtered_by_score_forecast += 1;
        if (decision.sentByHandOverride) counts.sent_by_hand_passed += 1;
      }
    });
    opts.onProgress?.(
      Math.trunc(((i + chunk.length) / Math.max(keys.length, 1)) * 100),
      `Re-decided ${Math.min(i + chunk.length, keys.length)}/${keys.length}`,
    );
  }

  const redecideS = Math.round((performance.now() - tRedecide) / 10) / 100;
  const result: RedecideAllPhotosResult = {
    total: keys.length,
    ...counts,
    pipeline_setting_version: pipeline.version,
    stage_versions: stageVersions,
    durations_s: { redecide: redecideS, total: Math.round((performance.now() - t0) / 10) / 100 },
  };
  libraryWrite(db, () => finishCullRun(db, runId, { status: 'complete', ...result }));
  return result;
}

export class RedecideCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'RedecideCancelled';
  }
}
