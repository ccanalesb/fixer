/**
 * Laya from the main thread: a worker thread that holds both models (ADR-0020).
 *
 * Loaded when a cull job starts and freed when it ends; `close` terminates the worker, which releases
 * the ~2–3.5 GB the sessions hold.
 */
import { Worker } from 'node:worker_threads';
import {
  LayaSetupError,
  referencePhotoPath,
  resolveLayaModelFiles,
  setupErrorMessage,
  type LayaModelFiles,
} from './files.js';
import type { LayaAnswers, LayaAnswerWant, LayaQuestionsByModel, LayaSeconds } from './sessions.js';

export interface LayaRequest {
  id: number;
  file: string;
  want?: LayaAnswerWant;
}

/** The worker's `workerData`: no `questions` means `questions.json`. */
export interface LayaWorkerData {
  files: LayaModelFiles;
  questions?: LayaQuestionsByModel;
}

export interface LayaPhotoResult {
  answers: LayaAnswers;
  seconds: LayaSeconds;
}

export type LayaWorkerMessage =
  | { type: 'ready'; scoreForecastOn: boolean }
  | { type: 'load-error'; message: string }
  | ({ type: 'answer'; id: number; ok: true } & LayaPhotoResult)
  | { type: 'answer'; id: number; ok: false; message: string };

/** Under `tsx` (dev server, CLI, tests) the worker is the `.ts` source and needs the same loader. */
function spawnWorker(data: LayaWorkerData): Worker {
  const fromSource = import.meta.url.endsWith('.ts');
  const url = new URL(fromSource ? './worker.ts' : './worker.js', import.meta.url);
  return new Worker(url, {
    workerData: data,
    execArgv: fromSource ? ['--import', import.meta.resolve('tsx')] : [],
  });
}

export class LayaRuntime {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (r: LayaPhotoResult) => void; reject: (e: Error) => void }>();
  private failure: Error | null = null;

  private constructor(
    private readonly worker: Worker,
    readonly files: LayaModelFiles,
    readonly scoreForecastOn: boolean,
  ) {
    worker.on('message', (m: LayaWorkerMessage) => {
      if (m.type !== 'answer') return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve({ answers: m.answers, seconds: m.seconds });
      else p.reject(new Error(m.message));
    });
    const fail = (e: Error) => {
      this.failure = e;
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    };
    worker.on('error', fail);
    worker.on('exit', (code) => fail(new Error(`Laya worker exited (code ${code})`)));
  }

  /** Spawn the worker and wait until both sessions are loaded. */
  static async start(files: LayaModelFiles, questions?: LayaQuestionsByModel): Promise<LayaRuntime> {
    const worker = spawnWorker({ files, questions });
    const ready = await new Promise<LayaWorkerMessage>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    }).catch((e: unknown) => ({ type: 'load-error' as const, message: String(e) }));
    if (ready.type !== 'ready') {
      await worker.terminate();
      const message = ready.type === 'load-error' ? ready.message : 'unexpected first message';
      throw new LayaSetupError(setupErrorMessage(`Laya models failed to load (${message})`));
    }
    return new LayaRuntime(worker, files, ready.scoreForecastOn);
  }

  /** The worker died: every later answer fails too, so a job stops rather than marking each photo pending. */
  get broken(): boolean {
    return this.failure !== null;
  }

  answer(file: string, want?: LayaAnswerWant): Promise<LayaPhotoResult> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, file, want } satisfies LayaRequest);
    });
  }

  async close(): Promise<void> {
    this.worker.removeAllListeners('exit');
    await this.worker.terminate();
  }
}

export interface LayaStartCheck {
  runtime: LayaRuntime;
  loadSeconds: number;
  /** The setup step's reference photo, answered once. */
  testPhoto: LayaPhotoResult;
}

/**
 * The cull job's start check: files present, models load, the reference photo answered — with the
 * questions the job will ask, so a recipe too long for Laya fails here rather than on every photo.
 * Anything else throws a `LayaSetupError` naming the missing piece and the setup step.
 */
export async function startLayaWithCheck(
  modelsDir: string,
  questions?: LayaQuestionsByModel,
): Promise<LayaStartCheck> {
  const files = resolveLayaModelFiles(modelsDir);
  const t0 = performance.now();
  const runtime = await LayaRuntime.start(files, questions);
  const loadSeconds = (performance.now() - t0) / 1000;
  try {
    const testPhoto = await runtime.answer(referencePhotoPath(files));
    return { runtime, loadSeconds, testPhoto };
  } catch (e) {
    await runtime.close();
    throw new LayaSetupError(
      setupErrorMessage(`Laya could not answer the test photo (${e instanceof Error ? e.message : String(e)})`),
    );
  }
}
