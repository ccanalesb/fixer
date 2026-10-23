/**
 * The models this app serves on its own System One endpoint (ADR-0021): every model installed in
 * `app_models_dir`, by its directory name.
 *
 * The model worker starts on the first request and is closed after two idle minutes, which frees the
 * ~2–3.5 GB it holds; the next request starts it again.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { config, loadLibraryConfig } from '../config.js';
import { AppModelSetupError, installedModels, resolveInstalledModel, type InstalledModel } from './files.js';
import { installedModelId } from './model-id.js';
import type { SystemOneQuestion } from '../systemone/question.js';
import { startModelRuntime, type AnswerRuntime } from './runtime.js';
import type { ImageAnswer } from './sessions.js';

export const APP_MODELS_IDLE_MS = 120_000;

export interface AppModelEntry {
  name: string;
  description: string;
  release_date: string;
  /** The identity stage versions hash: the Hugging Face id and commit, else the decoder's hash. */
  x_model_id: string;
}

/** A model this app does not serve (HTTP 404). */
export class AppModelNotListed extends Error {}
/** The worker could not start or died (HTTP 503). */
export class AppModelsUnavailable extends Error {}
/** The worker answered with an error for this request: an unreadable image, a question too long (HTTP 422). */
export class AppModelAnswerFailed extends Error {}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

function description(m: InstalledModel): string {
  const from = m.revision ? `${m.source}@${m.revision.slice(0, 7)}` : (m.source ?? 'a folder');
  return `${from}, converted to ONNX in this app`;
}

export class AppModels {
  private runtime: AnswerRuntime | null = null;
  private starting: Promise<AnswerRuntime> | null = null;
  private inFlight = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly modelsDir: () => string,
    private readonly idleMs = APP_MODELS_IDLE_MS,
  ) {}

  /** Nothing until a model is installed. */
  async list(): Promise<AppModelEntry[]> {
    const out: AppModelEntry[] = [];
    for (const m of installedModels(this.modelsDir())) {
      out.push({
        name: m.name,
        description: description(m),
        release_date: statSync(join(m.dir, 'decoder.onnx')).mtime.toISOString().slice(0, 10),
        x_model_id: await installedModelId(m),
      });
    }
    return out;
  }

  async answer(name: string, image: Uint8Array, questions: Record<string, SystemOneQuestion>): Promise<ImageAnswer> {
    let model: InstalledModel;
    try {
      model = resolveInstalledModel(this.modelsDir(), name);
    } catch (e) {
      if (e instanceof AppModelSetupError) throw new AppModelNotListed(e.message);
      throw e;
    }
    this.inFlight += 1;
    this.clearIdle();
    try {
      const runtime = await this.ensure();
      try {
        return await runtime.answer(model, image, questions);
      } catch (e) {
        if (runtime.broken) {
          this.runtime = null;
          throw new AppModelsUnavailable(errorMessage(e));
        }
        throw new AppModelAnswerFailed(errorMessage(e));
      }
    } finally {
      this.inFlight -= 1;
      this.armIdle();
    }
  }

  private async ensure(): Promise<AnswerRuntime> {
    if (this.runtime && !this.runtime.broken) return this.runtime;
    if (this.runtime) {
      const old = this.runtime;
      this.runtime = null;
      await old.close().catch(() => undefined);
    }
    this.starting ??= startModelRuntime().finally(() => {
      this.starting = null;
    });
    try {
      this.runtime = await this.starting;
    } catch (e) {
      throw new AppModelsUnavailable(errorMessage(e));
    }
    return this.runtime;
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private armIdle(): void {
    if (this.inFlight > 0 || !this.runtime) return;
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      if (this.inFlight === 0) void this.close();
    }, this.idleMs);
    this.idleTimer.unref();
  }

  /** Close the worker now; the next request starts it again. */
  async close(): Promise<void> {
    this.clearIdle();
    if (this.starting) await this.starting.catch(() => undefined);
    const runtime = this.runtime;
    this.runtime = null;
    await runtime?.close();
  }
}

let shared: AppModels | null = null;

export function appModels(): AppModels {
  shared ??= new AppModels(() => loadLibraryConfig(config.LT_CONFIG_YAML).appModelsDir);
  return shared;
}

/** Frees the worker (CLI exit, tests). */
export async function closeAppModels(): Promise<void> {
  await shared?.close();
}
