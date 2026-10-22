/**
 * Culling's two stages through System One (ADR-0021): the culling profile and the Score forecast each
 * call the endpoint and model `config.yaml` names for them (`culling_models`).
 *
 * A stage that is on must be usable: its endpoint answers and lists its model, and the start check — the
 * job's own questions on a test image — passes; otherwise the job fails naming the stage and the cause.
 */
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import type { CullingModelsConfig } from '../config.js';
import { LAYA_SETUP_COMMAND } from '../laya/files.js';
import type { LayaQuestion } from '../laya/rows.js';
import {
  askSystemOne,
  listSystemOneModels,
  modelIdentity,
  SystemOneError,
  systemOneEndpoint,
  THIS_APP_ENDPOINT,
  type SystemOneAnswers,
  type SystemOneEndpoint,
  type SystemOneFailure,
  type SystemOneImageEncoding,
} from '../systemone/client.js';
import type { PipelineSettingConfig, ResolvedStage, StageAnswers, StageKind } from './types.js';

export const STAGE_NAMES: Record<StageKind, string> = {
  culling_profile: 'Culling profile',
  score_forecast: 'Score forecast',
};

const KINDS: readonly StageKind[] = ['culling_profile', 'score_forecast'];

/** Each stage's model identity; null when the stage has none (off, and never answered). */
export type StageModelIds = Record<StageKind, string | null>;

/** A stage that is on cannot run: the job stops before any photo. */
export class CullingStageError extends Error {
  override readonly name = 'CullingStageError';
  constructor(
    readonly stage: StageKind,
    readonly failure: SystemOneFailure,
    message: string,
  ) {
    super(message);
  }
}

/** One photo's call failed; `failure` says whether the endpoint itself is gone (`down`). */
export class StageCallError extends Error {
  override readonly name = 'StageCallError';
  constructor(
    readonly stage: StageKind,
    readonly failure: SystemOneFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface StageModel {
  endpoint: SystemOneEndpoint;
  model: string;
}

export type StageModels = Record<StageKind, StageModel>;

export function stageModelsFromConfig(cfg: CullingModelsConfig, opts: { thisAppFetch?: typeof fetch } = {}): StageModels {
  return {
    culling_profile: { endpoint: systemOneEndpoint(cfg.culling_profile, opts), model: cfg.culling_profile.model },
    score_forecast: { endpoint: systemOneEndpoint(cfg.score_forecast, opts), model: cfg.score_forecast.model },
  };
}

/** Which stages the pipeline setting has on. */
export function stagesOn(cfg: PipelineSettingConfig): Record<StageKind, boolean> {
  return {
    culling_profile: cfg.culling_profiles_enabled && cfg.culling_profiles.length > 0,
    score_forecast: cfg.score_forecast.enabled,
  };
}

const named = (kind: StageKind, message: string) => `${STAGE_NAMES[kind]}: ${message}`;

function notListedMessage(kind: StageKind, m: StageModel): string {
  const where = m.endpoint.label;
  const setup = m.endpoint.id === THIS_APP_ENDPOINT ? `. Run the setup step from the repo root: ${LAYA_SETUP_COMMAND}` : '';
  return named(kind, `${m.model} is not listed by ${where}${setup}`);
}

/**
 * The model identity each stage's versions hash: from its endpoint while the stage is on, else what its
 * current versions were made with, so turning a stage off never touches its versions.
 */
export async function resolveStageModelIds(
  models: StageModels,
  on: Record<StageKind, boolean>,
  stored: StageModelIds,
): Promise<StageModelIds> {
  const ids: StageModelIds = { ...stored };
  for (const kind of KINDS) {
    if (!on[kind]) continue;
    const m = models[kind];
    let listed;
    try {
      listed = await listSystemOneModels(m.endpoint);
    } catch (e) {
      if (e instanceof SystemOneError) throw new CullingStageError(kind, e.failure, named(kind, e.message));
      throw e;
    }
    const entry = listed.find((x) => x.name === m.model);
    if (!entry) throw new CullingStageError(kind, 'not_listed', notListedMessage(kind, m));
    ids[kind] = modelIdentity(m.endpoint, entry);
  }
  return ids;
}

/** Question ids sent to a model: prefixed with the stage key, since two profiles may share a level set. */
const sentQid = (stage: ResolvedStage, qid: string): string => `${stage.stageKey}#${qid}`;

export function stageQuestions(stages: readonly ResolvedStage[]): Record<string, LayaQuestion> {
  const out: Record<string, LayaQuestion> = {};
  for (const s of stages) for (const [qid, q] of Object.entries(s.questions)) out[sentQid(s, qid)] = q;
  return out;
}

/** Answers back onto stages: profile answers by dimension, Score forecast answers by question id. */
export function stageAnswersFromModel(
  stages: readonly ResolvedStage[],
  answers: SystemOneAnswers,
): Record<string, StageAnswers> {
  const out: Record<string, StageAnswers> = {};
  for (const s of stages) {
    const own: StageAnswers = {};
    for (const qid of Object.keys(s.questions)) {
      const key = s.kind === 'culling_profile' ? qid.slice(qid.indexOf('|') + 1) : qid;
      own[key] = answers[sentQid(s, qid)]!;
    }
    out[s.stageKey] = own;
  }
  return out;
}

export interface StagePhotoAnswers {
  answers: Record<string, StageAnswers>;
  /** Wall seconds per stage's call, the endpoint's work included. */
  seconds: Partial<Record<StageKind, number>>;
  /** The endpoint each stage key was answered by (`this_app` or its URL). */
  producedBy: Record<string, string>;
}

/** What culling needs to answer a photo's missing stages; tests fake it. */
export interface StageAnswerer {
  answer(image: string, stages: readonly ResolvedStage[]): Promise<StagePhotoAnswers>;
  /** A stage's endpoint stopped answering: every later photo would fail too. */
  readonly broken: boolean;
}

let testImage: Promise<Uint8Array> | null = null;

/** A plain grey JPEG: the start check asks the job's questions about it. */
function startCheckImage(): Promise<Uint8Array> {
  testImage ??= sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 128, g: 128, b: 128 } } })
    .jpeg()
    .toBuffer()
    .then((b) => new Uint8Array(b));
  return testImage;
}

/**
 * Both stages' models for one job. The start check runs on the first photo that needs an answer, so a
 * job that only re-decides never makes a model call. It also settles how each stage sends images: a
 * data URL, or raw base64 when the endpoint refuses the data URL with a 400.
 */
export class CullingModels implements StageAnswerer {
  private checked = false;
  private _broken = false;
  private readonly encoding: Record<StageKind, SystemOneImageEncoding> = { culling_profile: 'data_url', score_forecast: 'data_url' };
  /** Seconds the start check took; 0 when it never ran. */
  loadSeconds = 0;

  constructor(
    private readonly models: StageModels,
    /** The stages this job asks: the start check asks all of their questions. */
    private readonly jobStages: readonly ResolvedStage[],
  ) {}

  get started(): boolean {
    return this.checked;
  }

  get broken(): boolean {
    return this._broken;
  }

  private async ask(kind: StageKind, image: Uint8Array, stages: readonly ResolvedStage[]): Promise<SystemOneAnswers> {
    const m = this.models[kind];
    return askSystemOne(m.endpoint, { model: m.model, image, questions: stageQuestions(stages), encoding: this.encoding[kind] });
  }

  /** The start check's call: a 400 to the data URL is asked once more in raw base64, kept if it works. */
  private async askSettlingEncoding(kind: StageKind, image: Uint8Array, stages: readonly ResolvedStage[]): Promise<void> {
    try {
      await this.ask(kind, image, stages);
    } catch (e) {
      if (!(e instanceof SystemOneError) || e.status !== 400) throw e;
      this.encoding[kind] = 'base64';
      try {
        await this.ask(kind, image, stages);
      } catch (retry) {
        this.encoding[kind] = 'data_url';
        if (retry instanceof SystemOneError && retry.status === 400) throw e;
        throw retry;
      }
    }
  }

  /** The start check, once: each stage's questions on a test image. */
  async check(): Promise<void> {
    if (this.checked) return;
    const t0 = performance.now();
    const image = await startCheckImage();
    for (const kind of KINDS) {
      const stages = this.jobStages.filter((s) => s.kind === kind);
      if (stages.length === 0) continue;
      try {
        await this.askSettlingEncoding(kind, image, stages);
      } catch (e) {
        if (!(e instanceof SystemOneError)) throw e;
        const message =
          e.failure === 'not_listed'
            ? notListedMessage(kind, this.models[kind])
            : named(kind, `the start check failed: ${e.message}`);
        throw new CullingStageError(kind, e.failure, message);
      }
    }
    this.loadSeconds = (performance.now() - t0) / 1000;
    this.checked = true;
  }

  async answer(imagePath: string, stages: readonly ResolvedStage[]): Promise<StagePhotoAnswers> {
    await this.check();
    const image = new Uint8Array(await readFile(imagePath));
    const out: StagePhotoAnswers = { answers: {}, seconds: {}, producedBy: {} };
    for (const kind of KINDS) {
      const own = stages.filter((s) => s.kind === kind);
      if (own.length === 0) continue;
      const t0 = performance.now();
      let answers: SystemOneAnswers;
      try {
        answers = await this.ask(kind, image, own);
      } catch (e) {
        if (!(e instanceof SystemOneError)) throw e;
        if (e.failure === 'down') this._broken = true;
        throw new StageCallError(kind, e.failure, named(kind, e.message));
      }
      out.seconds[kind] = (performance.now() - t0) / 1000;
      Object.assign(out.answers, stageAnswersFromModel(own, answers));
      for (const s of own) out.producedBy[s.stageKey] = this.models[kind].endpoint.id;
    }
    return out;
  }
}
