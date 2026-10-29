/**
 * Whether a culling stage that is on can run, before any job starts: local causes only.
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
      provider_name: null,
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

  it('a missing model is said before the endpoint is checked', async () => {
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

  it('a parked provider is reported without calling the endpoint', async () => {
    writeFileSync(
      providersPath,
      JSON.stringify(
        {
          providers: {
            [providerId]: {
              name: 'Studio GPU',
              protocol: 'system_one',
              enabled: false,
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
    await server.close();
    const r = await stageUsability('score_forecast', {
      on: true,
      cfg: at('clef-forecast'),
      appModels: [],
      questionCount: 3,
      registry: registry(),
    });
    expect(r).toMatchObject({ problem: 'parked', provider_name: 'Studio GPU' });
  });

  it('a removed endpoint is reported without calling the endpoint', async () => {
    await server.close();
    const r = await stageUsability('score_forecast', {
      on: true,
      cfg: { endpoint: 'gone_provider', model: 'clef-forecast' },
      appModels: [],
      questionCount: 3,
      registry: registry(),
    });
    expect(r.problem).toBe('removed');
  });

  it('an empty endpoint means removed', async () => {
    const r = await stageUsability('culling_profile', {
      on: true,
      cfg: { endpoint: '', model: 'clef-forecast' },
      appModels: [],
      questionCount: 0,
      registry: registry(),
    });
    expect(r.problem).toBe('removed');
  });
});
