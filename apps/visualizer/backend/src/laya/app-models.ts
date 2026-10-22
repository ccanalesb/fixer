/**
 * The models this app serves on its own System One endpoint (ADR-0021): the setup step's exports in
 * `laya_models_dir`, as `laya-base` and `laya-new`.
 *
 * The Laya worker starts on the first request and is closed after two idle minutes, which frees the
 * ~2–3.5 GB it holds; the next request starts it again.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { config, loadLibraryConfig } from '../config.js';
import { LayaSetupError, resolveLayaModelFiles, setupErrorMessage, type LayaModelFiles } from './files.js';
import { readLayaModelIds } from './model-id.js';
import type { LayaModelName } from './questions.js';
import type { LayaQuestion } from './rows.js';
import { startLayaRuntime, type LayaAnswerRuntime } from './runtime.js';
import type { LayaImageAnswer } from './sessions.js';

export const APP_MODELS_IDLE_MS = 120_000;

const MODEL_NAMES: Record<string, LayaModelName> = { 'laya-base': 'base', 'laya-new': 'new' };

export interface AppModelEntry {
  name: string;
  description: string;
  release_date: string;
  /** The identity stage versions hash: Laya base's revision, Laya new's decoder hash. */
  x_model_id: string;
}

/** A model this app does not serve (HTTP 404). */
export class AppModelNotListed extends Error {}
/** The worker could not start or died (HTTP 503). */
export class AppModelsUnavailable extends Error {}
/** The worker answered with an error for this request: an unreadable image, a question too long (HTTP 422). */
export class AppModelAnswerFailed extends Error {}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

function exportedOn(file: string): string {
  return statSync(file).mtime.toISOString().slice(0, 10);
}

function sameFiles(a: LayaModelFiles, b: LayaModelFiles): boolean {
  return a.baseDir === b.baseDir && a.newDir === b.newDir;
}

export class AppModels {
  private runtime: LayaAnswerRuntime | null = null;
  private starting: Promise<LayaAnswerRuntime> | null = null;
  private inFlight = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly modelsDir: () => string,
    private readonly idleMs = APP_MODELS_IDLE_MS,
  ) {}

  /** Nothing when the setup step has not run. */
  async list(): Promise<AppModelEntry[]> {
    let files: LayaModelFiles;
    try {
      files = resolveLayaModelFiles(this.modelsDir());
    } catch (e) {
      if (e instanceof LayaSetupError) return [];
      throw e;
    }
    const ids = await readLayaModelIds(files);
    const out: AppModelEntry[] = [
      {
        name: 'laya-base',
        description: 'Laya base (thaitea/laya-vision), converted to ONNX in this app',
        release_date: exportedOn(join(files.baseDir, 'decoder.onnx')),
        x_model_id: ids.base,
      },
    ];
    if (files.newDir && ids.new) {
      out.push({
        name: 'laya-new',
        description: 'Laya new (Laya base fine-tuned on this library), converted to ONNX in this app',
        release_date: exportedOn(join(files.newDir, 'decoder.onnx')),
        x_model_id: ids.new,
      });
    }
    return out;
  }

  async answer(name: string, image: Uint8Array, questions: Record<string, LayaQuestion>): Promise<LayaImageAnswer> {
    const model = MODEL_NAMES[name];
    let files: LayaModelFiles;
    try {
      files = resolveLayaModelFiles(this.modelsDir());
    } catch (e) {
      if (e instanceof LayaSetupError) throw new AppModelNotListed(`${name} is not listed by this app. ${e.message}`);
      throw e;
    }
    if (!model) throw new AppModelNotListed(`${name} is not listed by this app`);
    if (model === 'new' && !files.newDir) {
      throw new AppModelNotListed(setupErrorMessage(`${name} is not listed by this app: Laya new was not exported`));
    }
    this.inFlight += 1;
    this.clearIdle();
    try {
      const runtime = await this.ensure(files);
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

  private async ensure(files: LayaModelFiles): Promise<LayaAnswerRuntime> {
    if (this.runtime && !this.runtime.broken && sameFiles(this.runtime.files, files)) return this.runtime;
    if (this.runtime) {
      const old = this.runtime;
      this.runtime = null;
      await old.close().catch(() => undefined);
    }
    this.starting ??= startLayaRuntime(files).finally(() => {
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
  shared ??= new AppModels(() => loadLibraryConfig(config.LT_CONFIG_YAML).layaModelsDir);
  return shared;
}

/** Frees the worker (CLI exit, tests). */
export async function closeAppModels(): Promise<void> {
  await shared?.close();
}
