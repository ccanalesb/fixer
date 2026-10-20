/**
 * One photo through the cull: what is still missing is asked of Laya — in as few worker calls as the
 * pipeline's switches allow — and the photo is stored and decided (`persist.ts`).
 *
 * Takes the Laya runtime as an argument, so the cull job and the jobs that cull before describing
 * (#339) share it, and tests run it on a fake.
 */
import type { Db } from '../db/connection.js';
import { getImage } from '../db/library/catalog.js';
import { loadCurrentStageAnswers } from '../db/library/cull-stages.js';
import type { LayaPhotoResult } from '../laya/runtime.js';
import type { LayaAnswerWant } from '../laya/sessions.js';
import { resolveFilepath } from '../utils/path-resolve.js';
import { resolveVisionImage } from '../vision/vision-cache.js';
import { requiredStages } from './decide.js';
import { imageSignature } from './image-signature.js';
import { decideAndStorePhoto, WORKER_DIED_REASON, type CullContext } from './persist.js';
import { layaWant, stageAnswersFromLaya } from './stages.js';
import type { PhotoDecision, PipelineSettingConfig, ResolvedStage, StageAnswers } from './types.js';

/** What the cull needs of the Laya runtime. */
export interface LayaAnswerer {
  answer(file: string, want?: LayaAnswerWant): Promise<LayaPhotoResult>;
  /** The worker died: every later answer fails too. */
  readonly broken: boolean;
}

/** Whether a stage is answered even on a photo an earlier stage already cut. */
export function runsAfterCut(cfg: PipelineSettingConfig, stage: ResolvedStage): boolean {
  if (stage.kind === 'score_forecast') return cfg.score_forecast.run_after_cut;
  return cfg.culling_recipes.find((r) => r.recipe_slug === stage.recipeSlug)?.run_after_cut ?? true;
}

/**
 * The missing stages to ask in one worker call. A stage switched off for cut photos waits until the
 * stages before it are answered: whether it runs depends on what they say.
 */
export function askNow(cfg: PipelineSettingConfig, missing: readonly ResolvedStage[]): ResolvedStage[] {
  const out: ResolvedStage[] = [];
  for (const s of missing) {
    const group = s.recipeSlug ?? s.stageKey;
    if (out.length > 0 && !runsAfterCut(cfg, s) && out.some((o) => (o.recipeSlug ?? o.stageKey) !== group)) break;
    out.push(s);
  }
  return out;
}

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

export type CullPhotoOutcome = 'culled' | 'redecided' | 'no_image' | 'laya_failed' | 'worker_died';

export interface CullPhotoResult {
  outcome: CullPhotoOutcome;
  decision: PhotoDecision;
  /** Stages Laya answered for this photo now. */
  answeredStages: string[];
  seconds: { prep: number; vision: number; base: number; new: number };
  /** Set with `worker_died`: the caller stops the job with it. */
  error?: Error;
}

export interface CullPhotoArgs {
  imageKey: string;
  sentByHand: boolean;
  runId: number;
  resolveImage?: (db: Db, key: string) => Promise<string | null>;
}

/**
 * Cull one photo. A photo Laya fails on stays pending (retried by the next job); when the worker
 * itself died, the photo is stored as pending for that reason and the error is handed back.
 */
export async function cullPhoto(db: Db, ctx: CullContext, laya: LayaAnswerer, args: CullPhotoArgs): Promise<CullPhotoResult> {
  const { imageKey, sentByHand, runId } = args;
  const seconds = { prep: 0, vision: 0, base: 0, new: 0 };
  const stored = loadCurrentStageAnswers(db, ctx.stages, [imageKey]).get(imageKey) ?? {};
  const pending = (outcome: CullPhotoOutcome, reason: string, error?: Error): CullPhotoResult => ({
    outcome,
    decision: decideAndStorePhoto(db, ctx, { imageKey, stored, sentByHand, runId, pendingReason: reason }),
    answeredStages: [],
    seconds,
    error,
  });

  let missing = missingStages(ctx, stored, sentByHand);
  if (missing.length === 0) {
    return {
      outcome: 'redecided',
      decision: decideAndStorePhoto(db, ctx, { imageKey, stored, sentByHand, runId }),
      answeredStages: [],
      seconds,
    };
  }

  const image = await (args.resolveImage ?? resolveCullImage)(db, imageKey);
  if (image === null) return pending('no_image', 'no_image');

  const fresh: Record<string, StageAnswers> = {};
  try {
    for (let round = 0; missing.length > 0 && round < ctx.stages.length; round += 1) {
      const ask = askNow(ctx.pipeline.config, missing);
      const r = await laya.answer(image, layaWant(ask));
      seconds.prep += r.seconds.prep;
      seconds.vision += r.seconds.vision;
      seconds.base += r.seconds.base;
      seconds.new += r.seconds.new;
      Object.assign(fresh, stageAnswersFromLaya(ask, r.answers));
      missing = missingStages(ctx, { ...stored, ...fresh }, sentByHand);
    }
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    if (laya.broken) return pending('worker_died', WORKER_DIED_REASON, error);
    return pending('laya_failed', `laya_failed: ${error.message}`, error);
  }

  return {
    outcome: 'culled',
    decision: decideAndStorePhoto(db, ctx, {
      imageKey,
      stored,
      fresh: { answers: fresh, source: 'job', producedBy: 'onnx-cpu', imagePath: image, imageSignature: imageSignature(image) },
      sentByHand,
      runId,
    }),
    answeredStages: Object.keys(fresh),
    seconds,
  };
}
