/**
 * One photo through culling: what is still missing is asked of each stage's model, and the photo is
 * stored and decided (`persist.ts`).
 *
 * Takes the stages' models as an argument, so the culling job and the jobs that cull before describing
 * (#339) share them, and tests run it on a fake.
 */
import type { Db } from '../db/connection.js';
import { getImage } from '../db/library/catalog.js';
import { loadCurrentStageAnswers } from '../db/library/cull-stages.js';
import { resolveFilepath } from '../utils/path-resolve.js';
import { resolveVisionImage } from '../vision/vision-cache.js';
import { requiredStages } from './decide.js';
import { imageSignature } from './image-signature.js';
import { decideAndStorePhoto, ENDPOINT_DOWN_REASON, type CullContext } from './persist.js';
import { CullingStageError, type StageAnswerer } from './stage-models.js';
import type { PhotoDecision, ResolvedStage, StageAnswers, StageKind } from './types.js';

/** Required stages with no stored answer. */
export function missingStages(
  ctx: CullContext,
  answers: Readonly<Record<string, StageAnswers>>,
  sentByHand: boolean,
): ResolvedStage[] {
  return requiredStages(ctx.pipeline.config, ctx.stages, answers, {
    sentByHand,
    scoreForecastAvailable: ctx.scoreForecastAvailable,
  }).filter((s) => !answers[s.stageKey]);
}

/** The image describe and score read: the vision cache, built from the original when it is reachable. */
export async function resolveCullImage(db: Db, key: string): Promise<string | null> {
  const filepath = getImage(db, key)?.['filepath'];
  const { path } = await resolveVisionImage(db, key, resolveFilepath(typeof filepath === 'string' ? filepath : ''));
  return path;
}

export type CullPhotoOutcome = 'culled' | 'redecided' | 'no_image' | 'model_failed' | 'endpoint_down';

export interface CullPhotoResult {
  outcome: CullPhotoOutcome;
  decision: PhotoDecision;
  /** Stages answered for this photo now. */
  answeredStages: string[];
  /** Wall seconds per stage's call. */
  seconds: Partial<Record<StageKind, number>>;
  /** Set with `endpoint_down`: the caller stops the job with it. */
  error?: Error;
}

export interface CullPhotoArgs {
  imageKey: string;
  sentByHand: boolean;
  runId: number;
  /** Ask every required stage again, as if nothing were stored. */
  force?: boolean;
  resolveImage?: (db: Db, key: string) => Promise<string | null>;
}

/**
 * Cull one photo. A photo a model fails on stays pending (retried by the next job); when a stage's
 * endpoint stopped answering, the photo is stored as pending for that reason and the error is handed
 * back. A stage that cannot start (`CullingStageError`) is thrown.
 */
export async function cullPhoto(db: Db, ctx: CullContext, models: StageAnswerer, args: CullPhotoArgs): Promise<CullPhotoResult> {
  const { imageKey, sentByHand, runId } = args;
  const stored = loadCurrentStageAnswers(db, ctx.stages, [imageKey]).get(imageKey) ?? {};
  const pending = (outcome: CullPhotoOutcome, reason: string, error?: Error): CullPhotoResult => ({
    outcome,
    decision: decideAndStorePhoto(db, ctx, { imageKey, stored, sentByHand, runId, pendingReason: reason }),
    answeredStages: [],
    seconds: {},
    error,
  });

  // Forced, the stored answers still decide a photo no model can be asked about.
  const known = (fresh: Record<string, StageAnswers>) => (args.force ? fresh : { ...stored, ...fresh });
  const missing = missingStages(ctx, known({}), sentByHand);
  if (missing.length === 0) {
    return {
      outcome: 'redecided',
      decision: decideAndStorePhoto(db, ctx, { imageKey, stored, sentByHand, runId }),
      answeredStages: [],
      seconds: {},
    };
  }

  const image = await (args.resolveImage ?? resolveCullImage)(db, imageKey);
  if (image === null) return pending('no_image', 'no_image');

  let r;
  try {
    r = await models.answer(image, missing);
  } catch (e) {
    if (e instanceof CullingStageError) throw e;
    const error = e instanceof Error ? e : new Error(String(e));
    if (models.broken) return pending('endpoint_down', ENDPOINT_DOWN_REASON, error);
    return pending('model_failed', `model_failed: ${error.message}`, error);
  }

  return {
    outcome: 'culled',
    decision: decideAndStorePhoto(db, ctx, {
      imageKey,
      stored,
      fresh: { answers: r.answers, source: 'job', producedBy: r.producedBy, imagePath: image, imageSignature: imageSignature(image) },
      sentByHand,
      runId,
    }),
    answeredStages: Object.keys(r.answers),
    seconds: r.seconds,
  };
}
