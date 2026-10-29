/**
 * Providers API — list providers, manage models, fallback order and defaults.
 *
 * A fresh `ProviderRegistry` per request: `providers.json` is user-editable on disk,
 * and a long-lived registry would serve a stale copy after edits.
 *
 * These routes read `providers.json` and `visualizer.db`, never `library.db`.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { existsSync } from 'node:fs';
import { config } from '../config.js';
import { openDb, type Db } from '../db/connection.js';
import { addUserModel, DuplicateUserModelError } from '../db/jobs/provider-models.js';
import { ProviderRegistry, UnknownProviderError } from '../providers/registry.js';
import { createOpenApiApp } from './openapi.js';
import { jsonBody, withValidationError } from './route-helpers.js';
import { ErrorBody } from './schemas/errors.js';
import {
  DescriptionModelsResponse,
  FallbackOrderResponse,
  ProviderDefaults,
  ProviderDeletedResponse,
  ProviderHealthResponse,
  ProviderListResponse,
  ProviderModel,
  ProviderModelsListResponse,
  ProviderReorderSuccessResponse,
} from './schemas/providers.js';

export const providersRoutes = createOpenApiApp();

/**
 * Open `visualizer.db` for a single operation.
 *
 * Not middleware: only three of the eight provider routes touch it, and the
 * middleware would have to be mounted on a prefix shared with the ones that do not.
 */
function withJobsDb<T>(write: boolean, fn: (db: Db) => T): T {
  const db = openDb(config.VISUALIZER_DB, { readonly: !write, vec: false });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Returns `null` for an absent or unparseable JSON body. */
async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

// --- providers --------------------------------------------------------------

const listRoute = createRoute({
  method: 'get',
  path: '/providers/',
  tags: ['providers'],
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(ProviderListResponse) },
  }),
});

providersRoutes.openapi(listRoute, async (c) =>
  c.json(await new ProviderRegistry().listProviders(), 200),
);

const fallbackOrderGetRoute = createRoute({
  method: 'get',
  path: '/providers/fallback-order',
  tags: ['providers'],
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(FallbackOrderResponse) },
    400: { description: 'Bad Request', content: jsonBody(ErrorBody) },
  }),
});

providersRoutes.openapi(fallbackOrderGetRoute, (c) =>
  c.json({ order: new ProviderRegistry().fallbackOrder }, 200),
);

const fallbackOrderPutRoute = createRoute({
  method: 'put',
  path: '/providers/fallback-order',
  tags: ['providers'],
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(FallbackOrderResponse) },
    400: { description: 'Bad Request', content: jsonBody(ErrorBody) },
  }),
});

providersRoutes.openapi(fallbackOrderPutRoute, async (c) => {
  const registry = new ProviderRegistry();
  const data = await readJson(c);
  if (!data || typeof data !== 'object' || !('order' in data)) {
    return c.json({ error: 'order is required' }, 400);
  }
  try {
    registry.updateFallbackOrder((data as { order: unknown }).order);
  } catch (e) {
    if (e instanceof RangeError) return c.json({ error: e.message }, 400);
    throw e;
  }
  return c.json({ order: registry.fallbackOrder }, 200);
});

const defaultsGetRoute = createRoute({
  method: 'get',
  path: '/providers/defaults',
  tags: ['providers'],
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(ProviderDefaults) },
    400: { description: 'Bad Request', content: jsonBody(ErrorBody) },
  }),
});

providersRoutes.openapi(defaultsGetRoute, (c) =>
  c.json(new ProviderRegistry().defaults as z.infer<typeof ProviderDefaults>, 200),
);

const defaultsPutRoute = createRoute({
  method: 'put',
  path: '/providers/defaults',
  tags: ['providers'],
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(ProviderDefaults) },
    400: { description: 'Bad Request', content: jsonBody(ErrorBody) },
  }),
});

providersRoutes.openapi(defaultsPutRoute, async (c) => {
  const registry = new ProviderRegistry();
  const data = await readJson(c);
  if (!data) return c.json({ error: 'body is required' }, 400);
  try {
    registry.updateDefaults(data);
  } catch (e) {
    if (e instanceof RangeError) return c.json({ error: e.message }, 400);
    throw e;
  }
  return c.json(registry.defaults as z.infer<typeof ProviderDefaults>, 200);
});

// --- description model selector ---------------------------------------------

const descriptionModelsRoute = createRoute({
  method: 'get',
  path: '/providers/models/description',
  tags: ['providers'],
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(DescriptionModelsResponse) },
  }),
});

/**
 * Every model across every provider, flattened for the description task selector.
 *
 * Providers with no statically configured models (oMLX, for one) get a live
 * `/v1/models` discovery with a short timeout, so the selector still lists them
 * while they are running and simply omits them when they are not.
 */
providersRoutes.openapi(descriptionModelsRoute, async (c) => {
  const registry = new ProviderRegistry();
  const result: z.infer<typeof DescriptionModelsResponse>['models'] = [];

  for (const provider of await registry.listProviders()) {
    const pid = provider.id;
    let modelsList = await registry.listModels(pid);

    if (modelsList.length === 0) {
      try {
        modelsList = (await registry.discoverOpenAiModels(pid, 2000)).map((id) => ({
          id,
          name: id,
          source: 'discovered' as const,
        }));
      } catch {
        // Not running, or no such endpoint. Leave it out of the selector.
      }
    }

    const seen = new Set<string>();
    for (const m of modelsList) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      result.push({
        provider_id: pid,
        provider_name: provider.name,
        model_id: m.id,
        model_name: m.name ?? m.id,
        tool_calling: Boolean(provider.tool_calling),
      });
    }
  }

  const defaults = registry.defaults.description ?? { provider: undefined, model: undefined };
  return c.json(
    {
      models: result,
      default_provider: defaults.provider ?? null,
      default_model: defaults.model ?? null,
    },
    200,
  );
});

// --- per-provider -----------------------------------------------------------

const healthRoute = createRoute({
  method: 'get',
  path: '/providers/{provider_id}/health',
  tags: ['providers'],
  request: { params: z.object({ provider_id: z.string() }) },
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(ProviderHealthResponse) },
    404: { description: 'Not Found', content: jsonBody(ErrorBody) },
  }),
});

providersRoutes.openapi(healthRoute, async (c) => {
  const registry = new ProviderRegistry();
  let probe;
  try {
    probe = await registry.probeConnection(c.req.valid('param').provider_id);
  } catch (e) {
    if (e instanceof UnknownProviderError) return c.json({ error: 'Unknown provider' }, 404);
    throw e;
  }
  // Unreachable is a 200 with `reachable: false` — the provider being down is a
  // state the UI renders, not a request failure.
  return probe.ok
    ? c.json({ reachable: true }, 200)
    : c.json({ reachable: false, error: probe.detail }, 200);
});

const modelsOrderRoute = createRoute({
  method: 'put',
  path: '/providers/{provider_id}/models/order',
  tags: ['providers'],
  request: { params: z.object({ provider_id: z.string() }) },
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(ProviderReorderSuccessResponse) },
    400: { description: 'Bad Request', content: jsonBody(ErrorBody) },
    404: { description: 'Not Found', content: jsonBody(ErrorBody) },
  }),
});

providersRoutes.openapi(modelsOrderRoute, async (c) => {
  const registry = new ProviderRegistry();
  const data = await readJson(c);
  if (!data || typeof data !== 'object' || !('order' in data)) {
    return c.json({ error: 'order is required' }, 400);
  }
  try {
    registry.reorderModels(c.req.valid('param').provider_id, (data as { order: unknown }).order);
    return c.json({ success: true }, 200);
  } catch (e) {
    if (e instanceof UnknownProviderError) return c.json({ error: e.message }, 404);
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// --- model list and creation ------------------------------------------------

const modelsListRoute = createRoute({
  method: 'get',
  path: '/providers/{provider_id}/models',
  tags: ['providers'],
  request: { params: z.object({ provider_id: z.string() }) },
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(ProviderModelsListResponse) },
    201: { description: 'Created', content: jsonBody(ProviderModel) },
    400: { description: 'Bad Request', content: jsonBody(ErrorBody) },
    404: { description: 'Not Found', content: jsonBody(ErrorBody) },
    409: { description: 'Conflict', content: jsonBody(ErrorBody) },
  }),
});

providersRoutes.openapi(modelsListRoute, async (c) => {
  const registry = new ProviderRegistry();
  const providerId = c.req.valid('param').provider_id;
  if (!registry.hasProvider(providerId)) {
    return c.json({ error: `Unknown provider: ${providerId}` }, 404);
  }

  const modelsList = await registry.listModels(providerId);
  return c.json(modelsList as z.infer<typeof ProviderModelsListResponse>, 200);
});

const modelsCreateRoute = createRoute({
  method: 'post',
  path: '/providers/{provider_id}/models',
  tags: ['providers'],
  request: { params: z.object({ provider_id: z.string() }) },
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(ProviderModelsListResponse) },
    201: { description: 'Created', content: jsonBody(ProviderModel) },
    400: { description: 'Bad Request', content: jsonBody(ErrorBody) },
    404: { description: 'Not Found', content: jsonBody(ErrorBody) },
    409: { description: 'Conflict', content: jsonBody(ErrorBody) },
  }),
});

providersRoutes.openapi(modelsCreateRoute, async (c) => {
  const registry = new ProviderRegistry();
  const providerId = c.req.valid('param').provider_id;
  if (!registry.hasProvider(providerId)) {
    return c.json({ error: `Unknown provider: ${providerId}` }, 404);
  }

  const data = await readJson(c);
  if (!data || typeof data !== 'object') {
    return c.json({ error: 'id and name are required' }, 400);
  }
  const body = data as Record<string, unknown>;
  const modelId = body.id;
  const modelName = body.name;
  if (typeof modelId !== 'string' || !modelId.trim()) {
    return c.json({ error: 'id must be a non-empty string' }, 400);
  }
  if (typeof modelName !== 'string' || !modelName.trim()) {
    return c.json({ error: 'name must be a non-empty string' }, 400);
  }
  // Defaults to true, but an explicit non-boolean is rejected rather than coerced.
  if ('vision' in body && typeof body.vision !== 'boolean') {
    return c.json({ error: 'vision must be a boolean' }, 400);
  }
  const vision = 'vision' in body ? (body.vision as boolean) : true;

  try {
    withJobsDb(true, (db) => addUserModel(db, providerId, modelId, modelName, vision));
  } catch (e) {
    if (e instanceof DuplicateUserModelError) return c.json({ error: e.message }, 409);
    throw e;
  }
  return c.json({ id: modelId, name: modelName, vision, source: 'user' as const }, 201);
});

// --- model deletion ---------------------------------------------------------

/**
/** Delete a model row from `visualizer.db`. */
async function deleteModel(
  providerId: string,
  modelId: string,
): Promise<{ status: 200 | 404; body: { deleted: true } | { error: string } }> {
  const registry = new ProviderRegistry();
  if (!registry.hasProvider(providerId)) {
    return { status: 404, body: { error: `Unknown provider: ${providerId}` } };
  }
  if (registry.removeModel(providerId, modelId)) {
    return { status: 200, body: { deleted: true } };
  }
  return { status: 404, body: { error: 'Model not found' } };
}

const modelDeleteRoute = createRoute({
  method: 'delete',
  path: '/providers/{provider_id}/models/{model_id}',
  tags: ['providers'],
  request: { params: z.object({ provider_id: z.string(), model_id: z.string() }) },
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(ProviderDeletedResponse) },
    404: { description: 'Not Found', content: jsonBody(ErrorBody) },
  }),
});

/**
 * Registered twice: OpenAPI derives `{model_id}` as a single segment, but model ids
 * contain slashes (`meta/llama-4-maverick-…`). The greedy plain route below handles
 * requests; the `openapi()` registration puts the path in the document.
 */
providersRoutes.openapi(modelDeleteRoute, async (c) => {
  const result = await deleteModel(c.req.valid('param').provider_id, c.req.valid('param').model_id);
  return result.status === 200
    ? c.json(result.body as { deleted: true }, 200)
    : c.json(result.body as { error: string }, 404);
});

providersRoutes.delete('/providers/:provider_id/models/:model_id{.+}', async (c) => {
  const result = await deleteModel(c.req.param('provider_id'), c.req.param('model_id'));
  return c.json(result.body, result.status);
});
