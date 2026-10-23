/**
 * Whether a culling stage that is on can run, before any job starts: the order the causes are checked in,
 * and the Score forecast without questions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stageUsability } from '../src/cull/stage-usable.js';
import { fakeModelState } from './helpers/fake-app-models.js';
import { startFakeSystemOneServer, type FakeSystemOneServer } from './helpers/fake-systemone-server.js';

let server: FakeSystemOneServer;
beforeEach(async () => {
  server = await startFakeSystemOneServer(fakeModelState(), ['clef-forecast']);
});
afterEach(() => server.close());

const at = (model: string) => ({ endpoint: server.url, model, apiKey: '' });

describe('stageUsability', () => {
  it('a Score forecast with no questions cannot run', async () => {
    expect(
      await stageUsability('score_forecast', { on: true, cfg: at('clef-forecast'), appModels: [], questionCount: 0 }),
    ).toEqual({ on: true, problem: 'no_questions', model: 'clef-forecast', endpoint: server.url, job_id: null, detail: null });
  });

  it('questions count only for the Score forecast', async () => {
    const r = await stageUsability('culling_profile', { on: true, cfg: at('clef-forecast'), appModels: [], questionCount: 0 });
    expect(r.problem).toBeNull();
  });

  it('a missing model is said before the endpoint is asked', async () => {
    await server.close();
    const r = await stageUsability('score_forecast', { on: true, cfg: at(''), appModels: [], questionCount: 0 });
    expect(r.problem).toBe('no_model');
  });

  it('an endpoint that does not answer is said before missing questions', async () => {
    await server.close();
    const r = await stageUsability('score_forecast', { on: true, cfg: at('clef-forecast'), appModels: [], questionCount: 0 });
    expect(r.problem).toBe('down');
  });
});
