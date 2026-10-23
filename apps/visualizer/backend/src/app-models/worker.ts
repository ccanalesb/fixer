/**
 * Model worker thread entry: answers one request per message, in order, loading each model on its first
 * request. Spawned by `runtime.ts`; never imported.
 */
import { parentPort } from 'node:worker_threads';
import type { AnswerRequest, WorkerMessage } from './runtime.js';
import { ModelSessions } from './sessions.js';

const port = parentPort!;
const post = (m: WorkerMessage) => port.postMessage(m);
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

const sessions = new ModelSessions();
let queue = Promise.resolve();
port.on('message', ({ id, model, image, questions }: AnswerRequest) => {
  queue = queue.then(async () => {
    try {
      post({ type: 'answer', id, ok: true, ...(await sessions.answerImage(model, image, questions)) });
    } catch (e) {
      post({ type: 'answer', id, ok: false, message: errorMessage(e) });
    }
  });
});
post({ type: 'ready' });
