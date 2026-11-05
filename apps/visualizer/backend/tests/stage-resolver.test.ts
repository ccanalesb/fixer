/**
 * Local stage readiness: this app and System One providers, before listing models.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CullingStageError, resolveStageModelIds, stageModelsFromConfig } from '../src/cull/stage-models.js';
import { cullingStageErrorForProblem, resolveStage, stageEndpoint } from '../src/cull/stage-resolver.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { THIS_APP_ENDPOINT } from '../src/systemone/client.js';
import { setupErrorMessage } from '../src/app-models/files.js';
import { fakeModelState } from './helpers/fake-app-models.js';
import { registerSystemOneProvider } from './helpers/register-systemone-provider.js';
import { startFakeSystemOneServer, type FakeSystemOneServer } from './helpers/fake-systemone-server.js';

let server: FakeSystemOneServer;
let providerId: string;
let providersPath: string;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lt-stage-resolver-'));
  server = await startFakeSystemOneServer(fakeModelState(), ['clef-forecast']);
  providersPath = join(dir, 'providers.json');
  providerId = registerSystemOneProvider({ providersPath, url: server.url });
  process.env.LT_PROVIDERS_JSON = providersPath;
});

afterEach(() => {
  delete process.env.LT_PROVIDERS_JSON;
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const at = (model: string) => ({ endpoint: providerId, model });
const thisApp = (model: string) => ({ endpoint: THIS_APP_ENDPOINT, model });
const registry = () => new ProviderRegistry(providersPath);

const baseFields = (overrides: Record<string, unknown> = {}) => ({
  job_id: null,
  provider_name: null,
  systemOne: expect.anything(),
  ...overrides,
});

describe('resolveStage', () => {
  it('off → problem null', async () => {
    const r = await resolveStage('score_forecast', {
      on: false,
      cfg: thisApp(''),
      appModels: [],
      questionCount: 0,
      registry: registry(),
    });
    expect(r).toMatchObject({ on: false, problem: null, model: null, endpoint: THIS_APP_ENDPOINT });
    expect(r.systemOne).not.toBeNull();
  });

  it('happy path builds systemOne for a System One provider', async () => {
    const r = await resolveStage('score_forecast', {
      on: true,
      cfg: at('clef-forecast'),
      appModels: [],
      questionCount: 3,
      registry: registry(),
    });
    expect(r).toMatchObject({
      on: true,
      problem: null,
      model: 'clef-forecast',
      endpoint: providerId,
      ...baseFields(),
    });
    expect(r.systemOne?.url).toBe(server.url.replace(/\/+$/, ''));
  });

  it('a Score forecast with no questions cannot run', async () => {
    expect(
      await resolveStage('score_forecast', {
        on: true,
        cfg: at('clef-forecast'),
        appModels: [],
        questionCount: 0,
        registry: registry(),
      }),
    ).toMatchObject({
      on: true,
      problem: 'no_questions',
      model: 'clef-forecast',
      endpoint: providerId,
      ...baseFields(),
    });
  });

  it('questions count only for the Score forecast', async () => {
    const r = await resolveStage('culling_profile', {
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
    const r = await resolveStage('score_forecast', {
      on: true,
      cfg: at(''),
      appModels: [],
      questionCount: 0,
      registry: registry(),
    });
    expect(r.problem).toBe('no_model');
  });

  it('this app: no model when not installed', async () => {
    const r = await resolveStage('culling_profile', {
      on: true,
      cfg: thisApp('missing-model'),
      appModels: [{ name: 'other', source: null, revision: null, status: 'ready', job_id: 'j' }],
      questionCount: 0,
      registry: registry(),
    });
    expect(r.problem).toBe('no_model');
    expect(r.systemOne?.id).toBe(THIS_APP_ENDPOINT);
  });

  it('this app: converting names its job', async () => {
    const r = await resolveStage('culling_profile', {
      on: true,
      cfg: thisApp('model-x'),
      appModels: [{ name: 'model-x', source: '/x', revision: null, status: 'converting', job_id: 'job-1' }],
      questionCount: 0,
      registry: registry(),
    });
    expect(r).toMatchObject({
      problem: 'converting',
      job_id: 'job-1',
      model: 'model-x',
    });
    expect(cullingStageErrorForProblem('culling_profile', 'converting', r).failure).toBe('converting');
  });

  it('this app: ready model is usable', async () => {
    const r = await resolveStage('culling_profile', {
      on: true,
      cfg: thisApp('culling-model'),
      appModels: [{ name: 'culling-model', source: null, revision: null, status: 'ready', job_id: 'j' }],
      questionCount: 0,
      registry: registry(),
    });
    expect(r.problem).toBeNull();
  });

  it('this app: a ready model builds its systemOne endpoint', async () => {
    const r = await resolveStage('culling_profile', {
      on: true,
      cfg: thisApp('culling-model'),
      appModels: [{ name: 'culling-model', source: null, revision: null, status: 'ready', job_id: 'j' }],
      questionCount: 0,
      registry: registry(),
    });
    expect(r.systemOne).toMatchObject({ id: THIS_APP_ENDPOINT, label: 'this app' });
  });

  it('this app: a Score forecast with no questions cannot run', async () => {
    const r = await resolveStage('score_forecast', {
      on: true,
      cfg: thisApp('forecast-model'),
      appModels: [{ name: 'forecast-model', source: null, revision: null, status: 'ready', job_id: 'j' }],
      questionCount: 0,
      registry: registry(),
    });
    expect(r.problem).toBe('no_questions');
  });

  it('this app: a chosen model not installed fails naming the model and the setup step', async () => {
    const r = await resolveStage('culling_profile', {
      on: true,
      cfg: thisApp('missing-model'),
      appModels: [],
      questionCount: 0,
      registry: registry(),
    });
    const err = cullingStageErrorForProblem('culling_profile', 'no_model', r);
    expect(err.failure).toBe('not_listed');
    expect(err.message).toBe(`Culling profile: ${setupErrorMessage('missing-model is not listed by this app')}`);
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
    const r = await resolveStage('score_forecast', {
      on: true,
      cfg: at('clef-forecast'),
      appModels: [],
      questionCount: 3,
      registry: registry(),
    });
    expect(r).toMatchObject({ problem: 'parked', provider_name: 'Studio GPU' });
  });

  it('a removed provider id is reported without calling the endpoint', async () => {
    await server.close();
    const r = await resolveStage('score_forecast', {
      on: true,
      cfg: { endpoint: 'gone_provider', model: 'clef-forecast' },
      appModels: [],
      questionCount: 3,
      registry: registry(),
    });
    expect(r.problem).toBe('removed');
    expect(r.systemOne).toBeNull();
  });

  it('an empty endpoint means removed', async () => {
    const r = await resolveStage('culling_profile', {
      on: true,
      cfg: { endpoint: '', model: 'clef-forecast' },
      appModels: [],
      questionCount: 0,
      registry: registry(),
    });
    expect(r.problem).toBe('removed');
  });

  it('a legacy raw URL in config is removed', async () => {
    const r = await resolveStage('culling_profile', {
      on: true,
      cfg: { endpoint: server.url, model: 'clef-forecast' },
      appModels: [],
      questionCount: 0,
      registry: registry(),
    });
    expect(r.problem).toBe('removed');
    expect(r.systemOne).toBeNull();
    expect(stageEndpoint({ endpoint: server.url, model: '' }, registry())).toBeNull();
  });

  it('a non-System One provider is removed', async () => {
    writeFileSync(
      providersPath,
      JSON.stringify(
        {
          providers: {
            other: { name: 'Other', protocol: 'openai', enabled: true, base_url: { from: 'literal', value: 'http://x' }, auth: { mode: 'none' } },
          },
          defaults: {},
          fallback_order: [],
        },
        null,
        2,
      ),
    );
    const r = await resolveStage('score_forecast', {
      on: true,
      cfg: { endpoint: 'other', model: 'm' },
      appModels: [],
      questionCount: 1,
      registry: registry(),
    });
    expect(r.problem).toBe('removed');
  });
});

describe('resolveStage before resolveStageModelIds', () => {
  async function jobFailure(
    kind: 'culling_profile' | 'score_forecast',
    cfg: { endpoint: string; model: string },
  ): Promise<string | null> {
    const cullingModels = {
      culling_profile: kind === 'culling_profile' ? cfg : { endpoint: 'this_app', model: 'm' },
      score_forecast: kind === 'score_forecast' ? cfg : { endpoint: 'this_app', model: 'm' },
    };
    const onMap = { culling_profile: kind === 'culling_profile', score_forecast: kind === 'score_forecast' };
    const reg = registry();
    const resolved = await resolveStage(kind, {
      on: true,
      cfg,
      appModels: [],
      questionCount: 1,
      registry: reg,
    });
    if (resolved.problem) return resolved.problem;
    const models = stageModelsFromConfig(cullingModels, {
      registry: reg,
      systemOne: { [kind]: resolved.systemOne },
    });
    try {
      await resolveStageModelIds(models, onMap, { culling_profile: null, score_forecast: null });
      return null;
    } catch (e) {
      expect(e).toBeInstanceOf(CullingStageError);
      return (e as CullingStageError).failure;
    }
  }

  it('parked matches before listing models', async () => {
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
    expect(await jobFailure('score_forecast', cfg)).toBe('parked');
  });

  it('removed matches before listing models', async () => {
    await server.close();
    const cfg = { endpoint: 'gone_provider', model: 'clef-forecast' };
    expect(await jobFailure('score_forecast', cfg)).toBe('removed');
  });
});
