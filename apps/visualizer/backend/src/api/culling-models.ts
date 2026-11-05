/**
 * Culling models: each culling stage's System One provider (or this app) and model (`culling_models` in
 * `config.yaml`), the models that endpoint offers, and how many photos the stage's current answers cover.
 */
import { createRoute } from '@hono/zod-openapi';
import { config, loadLibraryConfig, updateConfigYamlCullingModel, type CullingModelConfig } from '../config.js';
import { resolveLibraryStages, type ResolveStageResult } from '../cull/stage-resolver.js';
import type { StageKind } from '../cull/types.js';
import type { Db } from '../db/connection.js';
import { getCurrentPipelineSetting } from '../db/library/cull-pipeline.js';
import { countCatalogPhotosForCullEstimate } from '../db/library/cull-profiles-mutations.js';
import { countPhotosAnsweredByCurrentStage, readStoredStageModelIds } from '../db/library/cull-stages.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  findSystemOneEndpoint,
  listSystemOneModels,
  SystemOneError,
  THIS_APP_ENDPOINT,
} from '../systemone/client.js';
import { errorBadRequest } from '../utils/responses.js';
import { libraryDb, type LibraryEnv } from './library-db.js';
import { createOpenApiApp } from './openapi.js';
import { jsonBody, withValidationError } from './route-helpers.js';
import {
  CullingModelsResponse,
  CullingModelsUsableResponse,
  CullingStageModel,
  CullingStageModelPutRequest,
  CullingStageModelsList,
  CullingStageParam,
  CullingSystemOneProvider,
} from './schemas/culling-models.js';
import { ErrorBody } from './schemas/errors.js';
import type { z } from '@hono/zod-openapi';

export const cullingModelsRoutes = createOpenApiApp<LibraryEnv>();

cullingModelsRoutes.use('/culling-models', libraryDb());
cullingModelsRoutes.use('/culling-models/:stage', libraryDb());

const stagesConfig = () => loadLibraryConfig(config.LT_CONFIG_YAML).cullingModels;

function listSystemOneProviders(registry: ProviderRegistry): z.infer<typeof CullingSystemOneProvider>[] {
  return Object.entries(registry.providerConfigs())
    .filter(([, cfg]) => cfg.protocol === 'system_one')
    .map(([id, cfg]) => ({
      id,
      name: cfg.name,
      url: registry.resolveSystemOneBaseUrl(cfg),
      enabled: cfg.enabled !== false,
      has_key: registry.providerHasKey(cfg),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The endpoint as saved: this app or a System One provider id; null for anything else. */
function normalizeEndpoint(raw: string, registry: ProviderRegistry): string | null {
  const text = raw.trim();
  return findSystemOneEndpoint(text, { registry }) ? text : null;
}

/** What a model identity is called: this app's model by its name, `<name>@<url>` as "name on url". */
async function modelName(identity: string | null): Promise<string | null> {
  if (identity === null) return null;
  try {
    const own = await listSystemOneModels(findSystemOneEndpoint(THIS_APP_ENDPOINT)!);
    const mine = own.find((m) => m.modelId === identity);
    if (mine) return mine.name;
  } catch {
    // This app lists nothing it can read: the identity says it.
  }
  const at = identity.lastIndexOf('@http');
  return at > 0 ? `${identity.slice(0, at)} on ${identity.slice(at + 1)}` : identity;
}

/** Whether the stage can run, as `/usable` and each stage's `usable` say it. */
function stageUsable({ on, problem, model, endpoint, job_id, provider_name }: ResolveStageResult) {
  return { on, problem, model, endpoint, job_id, provider_name };
}

async function stageState(
  db: Db,
  kind: StageKind,
  storedModelId: string | null,
  resolved: ResolveStageResult,
): Promise<z.infer<typeof CullingStageModel>> {
  const { problem, job_id, provider_name } = stageUsable(resolved);
  return {
    endpoint: resolved.endpoint,
    model: resolved.model,
    answered: { photos: countPhotosAnsweredByCurrentStage(db, kind), model: await modelName(storedModelId) },
    usable: { problem, job_id, provider_name },
  };
}

const getRoute = createRoute({
  method: 'get',
  path: '/culling-models',
  tags: ['culling-models'],
  responses: withValidationError({
    200: { description: 'Each culling stage’s endpoint and model', content: jsonBody(CullingModelsResponse) },
  }),
});

cullingModelsRoutes.openapi(getRoute, async (c) => {
  const db = c.get('libraryDb');
  const registry = new ProviderRegistry();
  const resolved = resolveLibraryStages(db, { registry });
  const stored = readStoredStageModelIds(db);
  return c.json(
    {
      culling_profile: await stageState(db, 'culling_profile', stored.culling_profile, resolved.culling_profile),
      score_forecast: await stageState(db, 'score_forecast', stored.score_forecast, resolved.score_forecast),
      total_photos: countCatalogPhotosForCullEstimate(db),
      system_one_providers: listSystemOneProviders(registry),
    },
    200,
  );
});

const putRoute = createRoute({
  method: 'put',
  path: '/culling-models/{stage}',
  tags: ['culling-models'],
  request: { params: CullingStageParam, body: { content: jsonBody(CullingStageModelPutRequest) } },
  responses: withValidationError({
    200: { description: 'Saved in config.yaml', content: jsonBody(CullingStageModel) },
    400: { description: 'Neither this app nor a System One provider', content: jsonBody(ErrorBody) },
  }),
});

cullingModelsRoutes.openapi(putRoute, async (c) => {
  const { stage } = c.req.valid('param');
  const body = c.req.valid('json');
  const saved = stagesConfig()[stage];
  const registry = new ProviderRegistry();
  let endpoint = saved.endpoint;
  if (body.endpoint !== undefined) {
    const normalized = normalizeEndpoint(body.endpoint, registry);
    if (normalized === null) return errorBadRequest(c, 'Choose this app or a System One provider');
    endpoint = normalized;
  }
  const moved = endpoint !== saved.endpoint;
  const next: CullingModelConfig = {
    endpoint,
    model: body.model !== undefined ? (body.model ?? '') : moved ? '' : saved.model,
  };
  updateConfigYamlCullingModel(config.LT_CONFIG_YAML, stage, next);
  const db = c.get('libraryDb');
  const resolved = resolveLibraryStages(db, { registry })[stage];
  return c.json(await stageState(db, stage, readStoredStageModelIds(db)[stage], resolved), 200);
});

const modelsRoute = createRoute({
  method: 'get',
  path: '/culling-models/{stage}/models',
  tags: ['culling-models'],
  request: { params: CullingStageParam },
  responses: withValidationError({
    200: { description: 'Models the stage’s endpoint offers', content: jsonBody(CullingStageModelsList) },
  }),
});

const usableRoute = createRoute({
  method: 'get',
  path: '/culling-models/usable',
  tags: ['culling-models'],
  responses: withValidationError({
    200: { description: 'Whether each culling stage that is on can run', content: jsonBody(CullingModelsUsableResponse) },
  }),
});

cullingModelsRoutes.openapi(usableRoute, async (c) => {
  const db = c.get('libraryDb');
  const resolved = resolveLibraryStages(db);
  return c.json(
    {
      culling_profile: stageUsable(resolved.culling_profile),
      score_forecast: stageUsable(resolved.score_forecast),
      culling_profile_filter: getCurrentPipelineSetting(db).config.culling_profiles_filter_enabled,
    },
    200,
  );
});

cullingModelsRoutes.openapi(modelsRoute, async (c) => {
  const { stage } = c.req.valid('param');
  const cfg = stagesConfig()[stage];
  const registry = new ProviderRegistry();
  const ep = findSystemOneEndpoint(cfg.endpoint, { registry });
  if (cfg.endpoint === THIS_APP_ENDPOINT) {
    try {
      const listed = await listSystemOneModels(ep!);
      return c.json({ answers: true, models: listed.map((m) => m.name), error: null }, 200);
    } catch (e) {
      if (!(e instanceof SystemOneError)) throw e;
      return c.json({ answers: false, models: [], error: e.message }, 200);
    }
  }
  if (!ep) {
    return c.json({ answers: false, models: [], error: 'Unknown provider' }, 200);
  }
  const models = await registry.listModels(cfg.endpoint);
  return c.json({ answers: true, models: models.map((m) => m.id), error: null }, 200);
});
