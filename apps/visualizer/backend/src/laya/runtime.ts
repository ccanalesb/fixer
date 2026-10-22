/**
 * Laya from the main thread: a worker thread that holds both models (ADR-0020). Owned by this app's
 * System One endpoint (`app-models.ts`), which starts it on its first request and closes it when idle;
 * `close` terminates the worker, which releases the ~2–3.5 GB the sessions hold.
 */
import { Worker } from 'node:worker_threads';
import { LayaSetupError, setupErrorMessage, type LayaModelFiles } from './files.js';
import type { LayaModelName } from './questions.js';
import type { LayaQuestion } from './rows.js';
import type { LayaImageAnswer } from './sessions.js';

export interface LayaRequest {
  id: number;
  model: LayaModelName;
  image: Uint8Array;
  questions: Record<string, LayaQuestion>;
}

export interface LayaWorkerData {
  files: LayaModelFiles;
}

export type LayaWorkerMessage =
  | { type: 'ready'; models: LayaModelName[] }
  | { type: 'load-error'; message: string }
  | ({ type: 'answer'; id: number; ok: true } & LayaImageAnswer)
  | { type: 'answer'; id: number; ok: false; message: string };

/** What this app's endpoint needs of Laya; tests fake it. */
export interface LayaAnswerRuntime {
  readonly files: LayaModelFiles;
  answer(model: LayaModelName, image: Uint8Array, questions: Record<string, LayaQuestion>): Promise<LayaImageAnswer>;
  /** The worker died: every later answer fails too. */
  readonly broken: boolean;
  close(): Promise<void>;
}

/** Under `tsx` (dev server, CLI, tests) the worker is the `.ts` source and needs the same loader. */
function spawnWorker(data: LayaWorkerData): Worker {
  const fromSource = import.meta.url.endsWith('.ts');
  const url = new URL(fromSource ? './worker.ts' : './worker.js', import.meta.url);
  return new Worker(url, {
    workerData: data,
    execArgv: fromSource ? ['--import', import.meta.resolve('tsx')] : [],
  });
}

export class LayaRuntime implements LayaAnswerRuntime {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (r: LayaImageAnswer) => void; reject: (e: Error) => void }>();
  private failure: Error | null = null;

  private constructor(
    private readonly worker: Worker,
    readonly files: LayaModelFiles,
  ) {
    worker.on('message', (m: LayaWorkerMessage) => {
      if (m.type !== 'answer') return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve({ answers: m.answers, seconds: m.seconds, inputTokens: m.inputTokens });
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

  /** Spawn the worker and wait until its sessions are loaded. */
  static async start(files: LayaModelFiles): Promise<LayaRuntime> {
    const worker = spawnWorker({ files });
    const ready = await new Promise<LayaWorkerMessage>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    }).catch((e: unknown) => ({ type: 'load-error' as const, message: String(e) }));
    if (ready.type !== 'ready') {
      await worker.terminate();
      const message = ready.type === 'load-error' ? ready.message : 'unexpected first message';
      throw new LayaSetupError(setupErrorMessage(`Laya models failed to load (${message})`));
    }
    return new LayaRuntime(worker, files);
  }

  get broken(): boolean {
    return this.failure !== null;
  }

  answer(model: LayaModelName, image: Uint8Array, questions: Record<string, LayaQuestion>): Promise<LayaImageAnswer> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, model, image, questions } satisfies LayaRequest);
    });
  }

  async close(): Promise<void> {
    this.worker.removeAllListeners('exit');
    await this.worker.terminate();
  }
}

/** The one place a Laya worker is started. */
export function startLayaRuntime(files: LayaModelFiles): Promise<LayaAnswerRuntime> {
  return LayaRuntime.start(files);
}
