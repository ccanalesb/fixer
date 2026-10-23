/**
 * This app's System One endpoint answers exactly what the direct model calls answered before it:
 * every level probability, equal, for the photos a master-code run dumped; and the event loop
 * stays free while it answers (ADR-0018).
 *
 * Needs the exported models and that dump, so it skips unless LT_SYSTEMONE_PARITY names the dump:
 *
 *   LT_SYSTEMONE_PARITY=/tmp/master-answers.json npx vitest run tests/systemone-parity.test.ts
 *
 * The dump is `{model_ids: {base, new}, answers: {<image path>: {base: {qid: p[]}, new: {qid: p[]}}}}`,
 * written by master's `startModelsWithCheck(...).runtime.answer(path)` with the default questions.
 */
import { existsSync, readFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterAll, describe, expect, it } from 'vitest';
import { closeAppModels } from '../src/app-models/app-models.js';
import { FACTORY_QUESTIONS } from '../src/app-models/factory-questions.js';
import { askSystemOne, listSystemOneModels, modelIdentity, systemOneEndpoint } from '../src/systemone/client.js';

const dumpPath = process.env.LT_SYSTEMONE_PARITY ?? '';
const enabled = dumpPath !== '' && existsSync(dumpPath);
const describeMaybe = enabled ? describe : describe.skip;

interface Dump {
  model_ids: { base: string; new: string | null };
  answers: Record<string, { base: Record<string, number[]>; new: Record<string, number[]> | null }>;
}

describeMaybe("this app's System One endpoint vs the direct model calls", () => {
  const dump = enabled ? (JSON.parse(readFileSync(dumpPath, 'utf8')) as Dump) : { model_ids: { base: '', new: null }, answers: {} };
  const ep = systemOneEndpoint({ endpoint: 'this_app', model: '', apiKey: '' });
  afterAll(() => closeAppModels());

  it('lists both models under the ids stage versions already hash', async () => {
    const listed = await listSystemOneModels(ep);
    expect(Object.fromEntries(listed.map((m) => [m.name, modelIdentity(ep, m)]))).toEqual({
      'culling-model': dump.model_ids.base,
      'forecast-model': dump.model_ids.new,
    });
  });

  it('gives identical probabilities for every photo, without holding the event loop', { timeout: 600_000 }, async () => {
    const lag = monitorEventLoopDelay({ resolution: 5 });
    const images = Object.entries(dump.answers);
    expect(images.length).toBeGreaterThan(0);
    lag.enable();
    for (const [path, want] of images) {
      const image = new Uint8Array(readFileSync(path));
      const base = await askSystemOne(ep, { model: 'culling-model', image, questions: FACTORY_QUESTIONS.culling_profile });
      const neu = await askSystemOne(ep, { model: 'forecast-model', image, questions: FACTORY_QUESTIONS.score_forecast });
      expect(base, path).toEqual(want.base);
      expect(neu, path).toEqual(want.new);
    }
    lag.disable();
    expect(lag.max / 1e6).toBeLessThan(200);
  });
});
