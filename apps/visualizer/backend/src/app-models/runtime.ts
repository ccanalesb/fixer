/**
 * The models in this app, from the main thread: a worker thread that holds the installed models (ADR-0020). Owned by this
 * app's System One endpoint (`app-models.ts`), which starts it on its first request and closes it when
 * idle; `close` terminates the worker, which releases the ~2–3.5 GB the sessions hold.
 */
import { Worker } from 'node:worker_threads';
import type { SystemOneQuestion } from '../systemone/question.js';
import type { ImageAnswer, ModelRef } from './sessions.js';

export interface AnswerRequest {
  id: number;
  model: ModelRef;
  image: Uint8Array;
  questions: Record<string, SystemOneQuestion>;
}

export type WorkerMessage =
  | { type: 'ready' }
  | ({ type: 'answer'; id: number; ok: true } & ImageAnswer)
  | { type: 'answer'; id: number; ok: false; message: string };

/** What this app's endpoint needs of its models; tests fake it. */
export interface AnswerRuntime {
  answer(model: ModelRef, image: Uint8Array, questions: Record<string, SystemOneQuestion>): Promise<ImageAnswer>;
  /** The worker died: every later answer fails too. */
  readonly broken: boolean;
  close(): Promise<void>;
}

/** Under `tsx` (dev server, CLI, tests) the worker is the `.ts` source and needs the same loader. */
function spawnWorker(): Worker {
  const fromSource = import.meta.url.endsWith('.ts');
  const url = new URL(fromSource ? './worker.ts' : './worker.js', import.meta.url);
  return new Worker(url, { execArgv: fromSource ? ['--import', import.meta.resolve('tsx')] : [] });
}

export class ModelRuntime implements AnswerRuntime {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (r: ImageAnswer) => void; reject: (e: Error) => void }>();
  private failure: Error | null = null;

  private constructor(private readonly worker: Worker) {
    worker.on('message', (m: WorkerMessage) => {
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
    worker.on('exit', (code) => fail(new Error(`Model worker exited (code ${code})`)));
  }

  /** Spawn the worker and wait until onnxruntime has loaded in it. */
  static async start(): Promise<ModelRuntime> {
    const worker = spawnWorker();
    try {
      await new Promise<void>((resolve, reject) => {
        worker.once('message', () => resolve());
        worker.once('error', reject);
      });
    } catch (e) {
      await worker.terminate();
      throw new Error(`The model worker failed to start (${e instanceof Error ? e.message : String(e)})`);
    }
    return new ModelRuntime(worker);
  }

  get broken(): boolean {
    return this.failure !== null;
  }

  answer(model: ModelRef, image: Uint8Array, questions: Record<string, SystemOneQuestion>): Promise<ImageAnswer> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const ref: ModelRef = { name: model.name, dir: model.dir, visionDir: model.visionDir };
      this.worker.postMessage({ id, model: ref, image, questions } satisfies AnswerRequest);
    });
  }

  async close(): Promise<void> {
    this.worker.removeAllListeners('exit');
    await this.worker.terminate();
  }
}

/** The one place a model worker is started. */
export function startModelRuntime(): Promise<AnswerRuntime> {
  return ModelRuntime.start();
}
