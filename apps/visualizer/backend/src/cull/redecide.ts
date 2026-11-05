/**
 * Re-decide every culled photo from stored answers — no model call, no endpoint.
 */
import { performance } from 'node:perf_hooks';
import type { Db } from '../db/connection.js';
import { seedCullingDefaults } from '../db/library/cull-profiles.js';
import { loadCurrentStageAnswers } from '../db/library/cull-stages.js';
import { listSentByHandKeys } from '../db/library/sent-by-hand.js';
import { finishCullRun, getCullVerdict, insertCullRun, listCulledImageKeys } from '../db/library/cull-verdicts.js';
import { libraryWrite } from '../db/library/write.js';
import { createEventLoopYieldState, pollCancelAndYield, type EventLoopYieldState } from '../utils/yield.js';
import { decideAndStorePhoto, type CullContext } from './persist.js';
import { addDecision, emptyVerdictTally, type VerdictTally } from './verdict-tally.js';
import { readCurrentStages } from './stages.js';

const CHUNK = 500;

export interface RedecideAllPhotosResult extends VerdictTally {
  total: number;
  changed: number;
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
  const { pipeline, modelIds: ids, stages } = readCurrentStages(db);
  if (ids.culling_profile === null && ids.score_forecast === null) {
    return {
      total: 0,
      changed: 0,
      ...emptyVerdictTally(),
      pipeline_setting_version: pipeline.version,
      stage_versions: {},
      durations_s: { redecide: 0, total: 0 },
    };
  }

  const scoreForecastAvailable = ids.score_forecast !== null;
  const ctx: CullContext = { stages, pipeline, scoreForecastAvailable };
  const stageVersions = Object.fromEntries(stages.map((s) => [s.stageKey, s.versionId]));
  const keys = listCulledImageKeys(db);
  const sentByHand = listSentByHandKeys(db);
  const runId = libraryWrite(db, () =>
    insertCullRun(db, { kind: 'redecide', jobId: null, pipelineSettingVersion: pipeline.version }),
  );

  const counts = { changed: 0, ...emptyVerdictTally() };
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
        addDecision(counts, decision);
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
