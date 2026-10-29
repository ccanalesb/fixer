/**
 * Whether a culling stage that is on can run, before any job starts: the order the causes are checked in,
 * and the Score forecast without questions.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stageUsability } from '../src/cull/stage-usable.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { providerIdFromCullingUrl } from '../src/providers/culling-provider-id.js';
import { fakeModelState } from './helpers/fake-app-models.js';
import { startFakeSystemOneServer, type FakeSystemOneServer } from './helpers/fake-systemone-server.js';

let server: FakeSystemOneServer;
let providerId: string;
let providersPath: string;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lt-stage-usable-'));
  server = await startFakeSystemOneServer(fakeModelState(), ['clef-forecast']);
  providerId = providerIdFromCullingUrl(server.url);
  providersPath = join(dir, 'providers.json');
  writeFileSync(
    providersPath,
    JSON.stringify(
      {
        providers: {
          [providerId]: {
            name: 'Host',
            protocol: 'system_one',
            enabled: true,
            base_url: { from: 'literal', value: server.url },
            auth: { mode: 'none' },
          },
        },
        defaults: {},
        fallback_order: [],
      },
      null,
      2,
    ),
  );
  process.env.LT_PROVIDERS_JSON = providersPath;
});

afterEach(() => {
  delete process.env.LT_PROVIDERS_JSON;
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const at = (model: string) => ({ endpoint: providerId, model });
const registry = () => new ProviderRegistry(providersPath);

describe('stageUsability', () => {
  it('a Score forecast with no questions cannot run', async () => {
    expect(
      await stageUsability('score_forecast', {
        on: true,
        cfg: at('clef-forecast'),
        appModels: [],
        questionCount: 0,
        registry: registry(),
      }),
    ).toEqual({
      on: true,
      problem: 'no_questions',
      model: 'clef-forecast',
      endpoint: providerId,
      job_id: null,
      detail: null,
    });
  });

  it('questions count only for the Score forecast', async () => {
    const r = await stageUsability('culling_profile', {
      on: true,
      cfg: at('clef-forecast'),
      appModels: [],
      questionCount: 0,
      registry: registry(),
    });
    expect(r.problem).toBeNull();
  });

  it('a missing model is said before the endpoint is asked', async () => {
    await server.close();
    const r = await stageUsability('score_forecast', {
      on: true,
      cfg: at(''),
      appModels: [],
      questionCount: 0,
      registry: registry(),
    });
    expect(r.problem).toBe('no_model');
  });

  it('an endpoint that does not answer is said before missing questions', async () => {
    await server.close();
    const r = await stageUsability('score_forecast', {
      on: true,
      cfg: at('clef-forecast'),
      appModels: [],
      questionCount: 0,
      registry: registry(),
    });
    expect(r.problem).toBe('down');
  });
});
