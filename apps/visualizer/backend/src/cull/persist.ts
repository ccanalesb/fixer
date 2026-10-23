/**
 * One photo's cull, stored: new stage answers (if any), every current stage's verdict re-decided, and
 * the summary row — in one `libraryWrite`, so a photo is never half-decided.
 *
 * The culling job, `cull-import` and the re-decide job all end here; re-decide passes no
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
 * Pending reason of a photo a stage's endpoint stopped answering on. Kept whatever the verdict (a photo
 * sent by hand is `passed` and still stopped it), so the next fresh job asks it last. Photos culled
 * before System One carry the older `laya_worker_died`, read the same way.
 */
export const ENDPOINT_DOWN_REASON = 'endpoint_down';
const ASK_LAST_REASONS = new Set([ENDPOINT_DOWN_REASON, 'laya_worker_died']);

export function asksLast(pendingReason: string | undefined): boolean {
  return pendingReason !== undefined && ASK_LAST_REASONS.has(pendingReason);
}

/** Everything a decision depends on, resolved once per run. */
export interface CullContext {
  stages: ResolvedStage[];
  pipeline: PipelineSetting;
  /** False when the Score forecast has no model identity (off, never answered): the profile decides alone. */
  scoreForecastAvailable: boolean;
}

/** The current stage versions a summary was decided under, as stored on the summary row. */
export function stageVersionIds(ctx: CullContext): number[] {
  return ctx.stages.map((s) => s.versionId);
}

export interface FreshAnswers {
  answers: Record<string, StageAnswers>;
  source: 'job' | 'import';
  /** The endpoint that answered (`this_app` or its URL), one for all or by stage key. */
  producedBy: string | Readonly<Record<string, string>>;
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
            producedBy:
              typeof args.fresh.producedBy === 'string' ? args.fresh.producedBy : (args.fresh.producedBy[stage.stageKey] ?? ''),
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
      filteredBy: decision.filteredBy,
      filteredByStageKey: decision.filteredByStageKey,
      cullingProfileVerdict: decision.cullingProfileVerdict,
      sentByHand: args.sentByHand,
      pendingStages: decision.pendingStages,
      pendingReason:
        decision.verdict === 'pending'
          ? (args.pendingReason ?? '')
          : asksLast(args.pendingReason)
            ? args.pendingReason!
            : '',
      scoreForecastOff: !ctx.scoreForecastAvailable || !ctx.pipeline.config.score_forecast.enabled,
      scoreForecastP8: decision.scoreForecastP8,
      pipelineSettingVersion: ctx.pipeline.version,
      stageVersionIds: stageVersionIds(ctx),
      runId: args.runId,
    });
  });
  return decision;
}
