/**
 * Culling models: each culling stage's System One endpoint, model and API key (`culling_models` in
 * `config.yaml`, ADR-0021), the models that endpoint lists, and how many photos the stage's current
 * answers cover. The API key is written here and never read back out.
 */
import { createRoute } from '@hono/zod-openapi';
import { config, loadLibraryConfig, updateConfigYamlCullingModel, type CullingModelConfig } from '../config.js';
import type { StageKind } from '../cull/types.js';
import type { Db } from '../db/connection.js';
import { countCatalogPhotosForCullEstimate } from '../db/library/cull-profiles-mutations.js';
import { countPhotosAnsweredByCurrentStage, readStoredStageModelIds } from '../db/library/cull-stages.js';
import { listSystemOneModels, SystemOneError, systemOneEndpoint, THIS_APP_ENDPOINT } from '../systemone/client.js';
import { errorBadRequest } from '../utils/responses.js';
import { libraryDb, type LibraryEnv } from './library-db.js';
import { createOpenApiApp } from './openapi.js';
import { jsonBody, withValidationError } from './route-helpers.js';
import {
  CullingModelsResponse,
  CullingStageModel,
  CullingStageModelPutRequest,
  CullingStageModelsList,
  CullingStageParam,
} from './schemas/culling-models.js';
import { ErrorBody } from './schemas/errors.js';
import type { z } from '@hono/zod-openapi';

export const cullingModelsRoutes = createOpenApiApp<LibraryEnv>();

cullingModelsRoutes.use('/culling-models', libraryDb());
cullingModelsRoutes.use('/culling-models/:stage', libraryDb());

const stagesConfig = () => loadLibraryConfig(config.LT_CONFIG_YAML).cullingModels;

/** Check is someone waiting on a button, not a model loading for a job. */
const CHECK_TIMEOUT_MS = 10_000;

/** `this_app`, or an http(s) URL without its trailing slash; null for anything else. */
function normalizeEndpoint(raw: string): string | null {
  const text = raw.trim();
  if (text === THIS_APP_ENDPOINT) return text;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return text.replace(/\/+$/, '');
}

/** What a model identity is called: this app's model by its name, `<name>@<url>` as "name on url". */
async function modelName(identity: string | null): Promise<string | null> {
  if (identity === null) return null;
  try {
    const own = await listSystemOneModels(systemOneEndpoint({ endpoint: THIS_APP_ENDPOINT, model: '', apiKey: '' }));
    const mine = own.find((m) => m.modelId === identity);
    if (mine) return mine.name;
  } catch {
    // This app lists nothing it can read: the identity says it.
  }
  const at = identity.lastIndexOf('@http');
  return at > 0 ? `${identity.slice(0, at)} on ${identity.slice(at + 1)}` : identity;
}

async function stageState(
  db: Db,
  kind: StageKind,
  cfg: CullingModelConfig,
  storedModelId: string | null,
): Promise<z.infer<typeof CullingStageModel>> {
  return {
    endpoint: cfg.endpoint,
    model: cfg.model || null,
    has_api_key: cfg.endpoint !== THIS_APP_ENDPOINT && cfg.apiKey !== '',
    answered: { photos: countPhotosAnsweredByCurrentStage(db, kind), model: await modelName(storedModelId) },
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
  const cfg = stagesConfig();
  const stored = readStoredStageModelIds(db);
  return c.json(
    {
      culling_profile: await stageState(db, 'culling_profile', cfg.culling_profile, stored.culling_profile),
      score_forecast: await stageState(db, 'score_forecast', cfg.score_forecast, stored.score_forecast),
      total_photos: countCatalogPhotosForCullEstimate(db),
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
    400: { description: 'Neither this app nor an http(s) URL', content: jsonBody(ErrorBody) },
  }),
});

cullingModelsRoutes.openapi(putRoute, async (c) => {
  const { stage } = c.req.valid('param');
  const body = c.req.valid('json');
  const saved = stagesConfig()[stage];
  let endpoint = saved.endpoint;
  if (body.endpoint !== undefined) {
    const normalized = normalizeEndpoint(body.endpoint);
    if (normalized === null) return errorBadRequest(c, 'Enter this app or an http(s) URL');
    endpoint = normalized;
  }
  // A model and a key belong to the endpoint they were chosen for.
  const moved = endpoint !== saved.endpoint;
  const next: CullingModelConfig = {
    endpoint,
    model: body.model !== undefined ? (body.model ?? '') : moved ? '' : saved.model,
    apiKey: endpoint === THIS_APP_ENDPOINT ? '' : (body.api_key ?? (moved ? '' : saved.apiKey)),
  };
  updateConfigYamlCullingModel(config.LT_CONFIG_YAML, stage, next);
  const db = c.get('libraryDb');
  return c.json(await stageState(db, stage, next, readStoredStageModelIds(db)[stage]), 200);
});

const modelsRoute = createRoute({
  method: 'get',
  path: '/culling-models/{stage}/models',
  tags: ['culling-models'],
  request: { params: CullingStageParam },
  responses: withValidationError({
    200: { description: 'What the stage’s saved endpoint lists', content: jsonBody(CullingStageModelsList) },
  }),
});

cullingModelsRoutes.openapi(modelsRoute, async (c) => {
  const { stage } = c.req.valid('param');
  try {
    const listed = await listSystemOneModels(systemOneEndpoint(stagesConfig()[stage]), { timeoutMs: CHECK_TIMEOUT_MS });
    return c.json({ answers: true, models: listed.map((m) => m.name), error: null }, 200);
  } catch (e) {
    if (!(e instanceof SystemOneError)) throw e;
    return c.json({ answers: false, models: [], error: e.message }, 200);
  }
});
