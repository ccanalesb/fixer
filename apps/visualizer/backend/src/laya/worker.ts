/**
 * Laya worker thread entry: loads the sessions once, then answers one photo per message, in order.
 * Spawned by `runtime.ts`; never imported.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { LayaModelFiles } from './files.js';
import type { LayaRequest, LayaWorkerMessage } from './runtime.js';
import { LayaSessions } from './sessions.js';

const port = parentPort!;
const post = (m: LayaWorkerMessage) => port.postMessage(m);
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

try {
  const sessions = await LayaSessions.load(workerData as LayaModelFiles);
  let queue = Promise.resolve();
  port.on('message', ({ id, file }: LayaRequest) => {
    queue = queue.then(async () => {
      try {
        post({ type: 'answer', id, ok: true, ...(await sessions.answerFile(file)) });
      } catch (e) {
        post({ type: 'answer', id, ok: false, message: errorMessage(e) });
      }
    });
  });
  post({ type: 'ready', scoreForecastOn: sessions.scoreForecastOn });
} catch (e) {
  post({ type: 'load-error', message: errorMessage(e) });
}
