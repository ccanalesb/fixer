/**
 * Culling jobs and `/api/culling-models/usable` agree on parked and removed endpoint problems.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CullingStageError, resolveStageModelIds, stageModelsFromConfig } from '../src/cull/stage-models.js';
import { stageUsability } from '../src/cull/stage-usable.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { providerIdFromCullingUrl } from '../src/providers/culling-provider-id.js';
import { startFakeSystemOneServer, type FakeSystemOneServer } from './helpers/fake-systemone-server.js';
import { fakeModelState } from './helpers/fake-app-models.js';

let server: FakeSystemOneServer;
let providerId: string;
let providersPath: string;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lt-stage-endpoint-'));
  server = await startFakeSystemOneServer(fakeModelState(), ['clef-forecast']);
  providerId = providerIdFromCullingUrl(server.url);
  providersPath = join(dir, 'providers.json');
  writeFileSync(
    providersPath,
    JSON.stringify(
      {
        providers: {
          [providerId]: {
            name: 'Studio GPU',
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

const registry = () => new ProviderRegistry(providersPath);

async function jobProblem(
  kind: 'culling_profile' | 'score_forecast',
  cfg: { endpoint: string; model: string },
  on: boolean,
): Promise<string | null> {
  const cullingModels = {
    culling_profile: kind === 'culling_profile' ? cfg : { endpoint: 'this_app', model: 'm' },
    score_forecast: kind === 'score_forecast' ? cfg : { endpoint: 'this_app', model: 'm' },
  };
  const onMap = { culling_profile: kind === 'culling_profile' && on, score_forecast: kind === 'score_forecast' && on };
  const reg = registry();
  try {
    await resolveStageModelIds(
      stageModelsFromConfig(cullingModels, { registry: reg }),
      onMap,
      { culling_profile: null, score_forecast: null },
      new Set(),
      { cfg: cullingModels, registry: reg },
    );
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(CullingStageError);
    return (e as CullingStageError).failure;
  }
}

describe('parked and removed endpoint problems', () => {
  it('matches stageUsability for a parked provider', async () => {
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
    const cfg = { endpoint: providerId, model: 'clef-forecast' };
    const usable = await stageUsability('score_forecast', {
      on: true,
      cfg,
      appModels: [],
      questionCount: 1,
      registry: registry(),
    });
    expect(await jobProblem('score_forecast', cfg, true)).toBe(usable.problem);
    expect(usable.problem).toBe('parked');
  });

  it('matches stageUsability for a removed provider id', async () => {
    await server.close();
    const cfg = { endpoint: 'gone_provider', model: 'clef-forecast' };
    const usable = await stageUsability('score_forecast', {
      on: true,
      cfg,
      appModels: [],
      questionCount: 1,
      registry: registry(),
    });
    expect(await jobProblem('score_forecast', cfg, true)).toBe(usable.problem);
    expect(usable.problem).toBe('removed');
  });
});
