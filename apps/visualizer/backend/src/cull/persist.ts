/**
 * One photo's cull, stored: new stage answers (if any), every current stage's verdict re-decided, and
 * the summary row — in one `libraryWrite`, so a photo is never half-decided.
 *
 * The cull job, the research import and the re-decide job (#339) all end here; re-decide passes no
 * new answers and so never needs Laya.
 */
import type { Db } from '../db/connection.js';
import type { PipelineSetting } from '../db/library/cull-pipeline.js';
import { updateStageDecision, upsertStageAnswer } from '../db/library/cull-stages.js';
import { upsertCullVerdict } from '../db/library/cull-verdicts.js';
import { libraryWrite } from '../db/library/write.js';
import { decidePhoto } from './decide.js';
import type { PhotoDecision, ResolvedStage, StageAnswers } from './types.js';

/**
 * Pending reason of a photo the Laya worker died on. Kept whatever the verdict (a photo sent by hand
 * is `sent` and still killed the worker), so the next fresh job asks it last.
 */
export const WORKER_DIED_REASON = 'laya_worker_died';

/** Everything a decision depends on, resolved once per run. */
export interface CullContext {
  stages: ResolvedStage[];
  pipeline: PipelineSetting;
  /** False without Laya new: the Score forecast is off and the recipe decides alone. */
  scoreForecastAvailable: boolean;
}

/** The current stage versions a summary was decided under, as stored on the summary row. */
export function stageVersionIds(ctx: CullContext): number[] {
  return ctx.stages.map((s) => s.versionId);
}

export interface FreshAnswers {
  answers: Record<string, StageAnswers>;
  source: 'job' | 'research_import';
  producedBy: string;
  imagePath: string;
  imageSignature: string | null;
  /** Keep a row already stored for that stage version (the import never overwrites a job's). */
  ifAbsent?: boolean;
}

export interface StorePhotoArgs {
  imageKey: string;
  /** Answers already stored under the current stage versions. */
  stored: Record<string, StageAnswers>;
  fresh?: FreshAnswers;
  sentByHand: boolean;
  runId: number | null;
  pendingReason?: string;
}

export function decideAndStorePhoto(db: Db, ctx: CullContext, args: StorePhotoArgs): PhotoDecision {
  const fresh = args.fresh?.answers ?? {};
  const answers = { ...args.stored, ...fresh };
  const decision = decidePhoto(ctx.pipeline.config, ctx.stages, answers, {
    sentByHand: args.sentByHand,
    scoreForecastAvailable: ctx.scoreForecastAvailable,
  });
  libraryWrite(db, () => {
    for (const stage of ctx.stages) {
      const d = decision.stages[stage.stageKey];
      if (!d) continue;
      if (fresh[stage.stageKey] && args.fresh) {
        if (args.runId === null) throw new Error('new stage answers need a cull run');
        upsertStageAnswer(
          db,
          {
            imageKey: args.imageKey,
            stageVersionId: stage.versionId,
            answers: fresh[stage.stageKey]!,
            verdict: d.verdict,
            decision: d.detail,
            pipelineSettingVersion: ctx.pipeline.version,
            source: args.fresh.source,
            producedBy: args.fresh.producedBy,
            imagePath: args.fresh.imagePath,
            imageSignature: args.fresh.imageSignature,
            runId: args.runId,
          },
          { ifAbsent: args.fresh.ifAbsent },
        );
      } else {
        updateStageDecision(db, args.imageKey, stage.versionId, d.verdict, d.detail, ctx.pipeline.version);
      }
    }
    upsertCullVerdict(db, {
      imageKey: args.imageKey,
      verdict: decision.verdict,
      cutBy: decision.cutBy,
      cutByStageKey: decision.cutByStageKey,
      sentByHand: args.sentByHand,
      pendingStages: decision.pendingStages,
      pendingReason:
        decision.verdict === 'pending' || args.pendingReason === WORKER_DIED_REASON ? (args.pendingReason ?? '') : '',
      scoreForecastOff: !ctx.scoreForecastAvailable || !ctx.pipeline.config.score_forecast.enabled,
      scoreForecastP8: decision.scoreForecastP8,
      pipelineSettingVersion: ctx.pipeline.version,
      stageVersionIds: stageVersionIds(ctx),
      runId: args.runId,
    });
  });
  return decision;
}
