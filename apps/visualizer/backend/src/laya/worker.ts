/**
 * Laya worker thread entry: loads the sessions once, then answers one photo per message, in order.
 * Spawned by `runtime.ts`; never imported.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { LayaRequest, LayaWorkerData, LayaWorkerMessage } from './runtime.js';
import { LayaSessions } from './sessions.js';

const port = parentPort!;
const post = (m: LayaWorkerMessage) => port.postMessage(m);
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

try {
  const { files, questions } = workerData as LayaWorkerData;
  const sessions = await LayaSessions.load(files, questions);
  let queue = Promise.resolve();
  port.on('message', ({ id, file, want }: LayaRequest) => {
    queue = queue.then(async () => {
      try {
        post({ type: 'answer', id, ok: true, ...(await sessions.answerFile(file, want)) });
      } catch (e) {
        post({ type: 'answer', id, ok: false, message: errorMessage(e) });
      }
    });
  });
  post({ type: 'ready', scoreForecastOn: sessions.scoreForecastOn });
} catch (e) {
  post({ type: 'load-error', message: errorMessage(e) });
}
