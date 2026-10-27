/**
 * System routes — health, stats, catalog cache readiness.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { existsSync } from 'node:fs';
import { clipCacheDir, config, loadLibraryConfig } from '../config.js';
import { ERROR_DB_NOT_FOUND } from '../constants/errors.js';
import { openDb, openLibraryDb } from '../db/connection.js';
import { getCachePipelineStatus } from '../db/jobs/pipeline-status.js';
import { getUserModels } from '../db/jobs/user-models.js';
import { getInsightsSummary } from '../db/library/insights.js';
import {
  getCacheStats,
  getImageCount,
  getPostedImagesCount,
  hasCachedEntries,
} from '../db/library/statistics.js';
import { ProviderRegistry } from '../providers/registry.js';
import { createOpenApiApp } from './openapi.js';
import { jsonBody, withValidationError } from './route-helpers.js';
import { ErrorBody } from './schemas/errors.js';
import {
  CachePipelineStatus,
  CacheStatus,
  CatalogCacheReadyResponse,
  ClipModelStatus,
  InsightsSummary,
  Stats,
  SystemStatusResponse,
  VisionModelsResponse,
} from './schemas/system.js';
import { isClipModelOnDisk } from '../imaging/clip-embed.js';

export const systemRoutes = createOpenApiApp();

const statusRoute = createRoute({
  method: 'get',
  path: '/status',
  tags: ['system'],
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(SystemStatusResponse) },
  }),
});

systemRoutes.openapi(statusRoute, (c) => c.json({ status: 'ok' }, 200));

const clipModelRoute = createRoute({
  method: 'get',
  path: '/clip-model',
  tags: ['system'],
  responses: withValidationError({
    200: { description: 'CLIP vision model cache on disk', content: jsonBody(ClipModelStatus) },
  }),
});

systemRoutes.openapi(clipModelRoute, (c) =>
  c.json({ model_on_disk: isClipModelOnDisk(), cache_dir: clipCacheDir() }, 200),
);

const statsRoute = createRoute({
  method: 'get',
  path: '/stats',
  tags: ['system'],
  responses: withValidationError({
    200: { description: 'Catalog statistics', content: jsonBody(Stats) },
    404: { description: 'Library database not found', content: jsonBody(ErrorBody) },
    500: { description: 'Server error', content: jsonBody(ErrorBody) },
  }),
});

systemRoutes.openapi(statsRoute, (c) => {
  const dbPath = config.LIBRARY_DB;
  if (!existsSync(dbPath)) {
    return c.json({ error: ERROR_DB_NOT_FOUND }, 404);
  }
  // Read-only: these routes never mutate, which also keeps them off the write
  // lock the job processor holds during a catalog sync.
  const db = openLibraryDb(dbPath, { readonly: true });
  try {
    return c.json(
      {
        catalog_images: getImageCount(db),
        posted_to_instagram: getPostedImagesCount(db),
        db_path: dbPath,
      },
      200,
    );
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  } finally {
    db.close();
  }
});

const catalogStatusRoute = createRoute({
  method: 'get',
  path: '/catalog/status',
  tags: ['system'],
  responses: withValidationError({
    200: { description: 'Catalog cache readiness', content: jsonBody(CatalogCacheReadyResponse) },
    500: { description: 'Server error', content: jsonBody(ErrorBody) },
  }),
});

systemRoutes.openapi(catalogStatusRoute, (c) => {
  const dbPath = config.LIBRARY_DB;
  // A missing library DB is "not cached", not an error.
  if (!existsSync(dbPath)) return c.json({ cached: false }, 200);

  let db;
  try {
    db = openLibraryDb(dbPath, { readonly: true });
    return c.json({ cached: hasCachedEntries(db) }, 200);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  } finally {
    db?.close();
  }
});

/**
 * These three do not use the `libraryDb` middleware.
 *
 * `/stats` and `/catalog/status` above already open their own connection, because
 * the system group is mounted at `/api` alongside every other group and a
 * `use('/*', …)` here would open a connection for requests it does not own.
 * `/cache/pipeline-status` reads a different database entirely.
 */

const insightsSummaryRoute = createRoute({
  method: 'get',
  path: '/insights-summary',
  tags: ['system'],
  responses: withValidationError({
    200: { description: 'Insights tile counts', content: jsonBody(InsightsSummary) },
    404: { description: 'Library database not found', content: jsonBody(ErrorBody) },
    500: { description: 'Server error', content: jsonBody(ErrorBody) },
  }),
});

systemRoutes.openapi(insightsSummaryRoute, (c) => {
  const dbPath = config.LIBRARY_DB;
  if (!existsSync(dbPath)) return c.json({ error: ERROR_DB_NOT_FOUND }, 404);

  const db = openLibraryDb(dbPath, { readonly: true });
  try {
    return c.json(getInsightsSummary(db), 200);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  } finally {
    db.close();
  }
});

const cacheStatusRoute = createRoute({
  method: 'get',
  path: '/cache/status',
  tags: ['system'],
  responses: withValidationError({
    200: { description: 'Vision cache status', content: jsonBody(CacheStatus) },
    404: { description: 'Library database not found', content: jsonBody(ErrorBody) },
    500: { description: 'Server error', content: jsonBody(ErrorBody) },
  }),
});

systemRoutes.openapi(cacheStatusRoute, (c) => {
  const dbPath = config.LIBRARY_DB;
  if (!existsSync(dbPath)) return c.json({ error: ERROR_DB_NOT_FOUND }, 404);

  const db = openLibraryDb(dbPath, { readonly: true });
  try {
    const cacheDir = loadLibraryConfig(config.LT_CONFIG_YAML).visionCacheDir;
    const stats = getCacheStats(db, cacheDir);
    return c.json(
      {
        ...stats,
        // Rounded to two places for display; the raw byte sum stays in `getCacheStats`.
        cache_size_mb: Math.round(stats.cache_size_mb * 100) / 100,
      },
      200,
    );
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  } finally {
    db.close();
  }
});

const cachePipelineStatusRoute = createRoute({
  method: 'get',
  path: '/cache/pipeline-status',
  tags: ['system'],
  responses: withValidationError({
    200: { description: 'Latest run per pipeline trigger', content: jsonBody(CachePipelineStatus) },
    500: { description: 'Server error', content: jsonBody(ErrorBody) },
  }),
});

systemRoutes.openapi(cachePipelineStatusRoute, (c) => {
  // The jobs table lives in `visualizer.db`, opened per request so this route stays
  // safe while the job processor is writing.
  const dbPath = config.VISUALIZER_DB;
  if (!existsSync(dbPath)) {
    return c.json({ error: `Jobs database not found: ${dbPath}` }, 500);
  }
  const db = openDb(dbPath, { readonly: true, vec: false });
  try {
    return c.json(getCachePipelineStatus(db), 200);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  } finally {
    db.close();
  }
});

// --- vision models ----------------------------------------------------------

const visionModelsRoute = createRoute({
  method: 'get',
  path: '/vision-models',
  tags: ['system'],
  responses: withValidationError({
    200: { description: 'Vision-capable models', content: jsonBody(VisionModelsResponse) },
  }),
});

/**
 * Vision-capable models from every available provider, plus user-added rows.
 *
 * Never fails: any error falls back to `gemma3:27b` with `fallback: true`, so the
 * description UI always has something selectable. A 500 would leave an empty dropdown.
 */
systemRoutes.openapi(visionModelsRoute, async (c) => {
  // Not `as const`: the response type needs a mutable array of the schema's shape.
  const fallbackBody = (): z.infer<typeof VisionModelsResponse> => ({
    models: [{ name: 'gemma3:27b', default: true }],
    fallback: true,
  });
  try {
    const registry = new ProviderRegistry();
    const descriptionDefaults = registry.defaults.description;
    const defaultProvider = descriptionDefaults?.provider ?? 'ollama';
    const defaultModel = descriptionDefaults?.model ?? null;

    const allModels: { name: string; provider_id: string; default: boolean }[] = [];
    for (const provider of await registry.listProviders()) {
      if (!provider.available) continue;
      let models;
      try {
        models = await registry.listModels(provider.id);
      } catch {
        // One broken provider must not empty the whole dropdown.
        continue;
      }
      for (const model of models) {
        if (!model.vision) continue;
        // The first match for the configured default wins, and only one entry is
        // ever marked — hence the check against what has already been added.
        const isDefault =
          provider.id === defaultProvider &&
          (defaultModel === null || defaultModel === model.id) &&
          !allModels.some((entry) => entry.default);
        allModels.push({ name: model.id, provider_id: provider.id, default: isDefault });
      }
    }

    if (existsSync(config.VISUALIZER_DB)) {
      const db = openDb(config.VISUALIZER_DB, { readonly: true, vec: false });
      try {
        const seen = new Set(allModels.map((entry) => `${entry.provider_id}\u0000${entry.name}`));
        for (const userModel of getUserModels(db)) {
          if (!userModel.vision) continue;
          const key = `${userModel.provider_id}\u0000${userModel.model_id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          allModels.push({
            name: userModel.model_id,
            provider_id: userModel.provider_id,
            default: false,
          });
        }
      } finally {
        db.close();
      }
    }

    if (allModels.length === 0) return c.json(fallbackBody(), 200);
    // Something must be selected, even when no provider matched the default.
    if (!allModels.some((entry) => entry.default)) allModels[0]!.default = true;
    return c.json({ models: allModels, fallback: false }, 200);
  } catch {
    return c.json(fallbackBody(), 200);
  }
});
