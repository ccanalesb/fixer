/**
 * Read and write the repo-level `config.yaml`.
 *
 * These routes edit the user's own config file, so there is no library-DB
 * middleware here.
 */
import { createRoute } from '@hono/zod-openapi';
import { existsSync, statSync } from 'node:fs';
import {
  absoluteCatalogPath,
  invalidateOpenLibraryCache,
  isLibraryDbPinned,
  pinnedLibraryCatalogPath,
  updatePinnedLibraryCatalogPath,
} from '../catalog-library.js';
import {
  config,
  expandUserPath,
  loadLibraryConfig,
  updateConfigYamlCatalogPath,
  updateConfigYamlStackBurstDeltaMs,
} from '../config.js';
import { createOpenApiApp } from './openapi.js';
import { jsonBody, withValidationError } from './route-helpers.js';
import {
  ConfigCatalogGetResponse,
  ConfigCatalogPickResponse,
  ConfigCatalogPutRequest,
  ConfigCatalogPutResponse,
  ConfigStackDetectionGetResponse,
  ConfigStackDetectionPutRequest,
  ConfigStackDetectionPutResponse,
} from './schemas/config.js';
import { ErrorBody } from './schemas/errors.js';
import {
  chooseFile,
  FileDialogBusyError,
  FileDialogUnavailableError,
  nativeFileDialogAvailable,
} from '../utils/native-file-dialog.js';

export const ltConfigRoutes = createOpenApiApp();

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function catalogExists(resolved: string): boolean {
  if (!resolved) return false;
  if (resolved.toLowerCase().endsWith('.lrcat')) return isFile(resolved);
  return isDirectory(resolved);
}

// --- catalog ----------------------------------------------------------------

const getCatalogRoute = createRoute({
  method: 'get',
  path: '/config/catalog',
  tags: ['config'],
  responses: withValidationError({
    200: { description: 'Catalog path config', content: jsonBody(ConfigCatalogGetResponse) },
  }),
});

ltConfigRoutes.openapi(getCatalogRoute, (c) => {
  const cfg = loadLibraryConfig(config.LT_CONFIG_YAML);
  const raw = cfg.catalogPathRaw || '';
  const resolved = raw ? expandUserPath(raw) : '';
  return c.json(
    {
      catalog_path: raw,
      resolved_path: resolved,
      exists: Boolean(resolved && catalogExists(resolved)),
      picker_available: nativeFileDialogAvailable(),
    },
    200,
  );
});

const pickCatalogRoute = createRoute({
  method: 'post',
  path: '/config/catalog/pick',
  tags: ['config'],
  responses: withValidationError({
    200: { description: 'Chosen path, or null', content: jsonBody(ConfigCatalogPickResponse) },
    409: { description: 'A dialog is already open', content: jsonBody(ErrorBody) },
    500: { description: 'The dialog failed to open', content: jsonBody(ErrorBody) },
    501: { description: 'This host has no native dialog', content: jsonBody(ErrorBody) },
  }),
});

ltConfigRoutes.openapi(pickCatalogRoute, async (c) => {
  try {
    const result = await chooseFile('Select your Lightroom Classic catalog', 'lrcat');
    return c.json({ catalog_path: 'path' in result ? result.path : null }, 200);
  } catch (error) {
    if (error instanceof FileDialogUnavailableError) return c.json({ error: error.message }, 501);
    if (error instanceof FileDialogBusyError) return c.json({ error: error.message }, 409);
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

const putCatalogRoute = createRoute({
  method: 'put',
  path: '/config/catalog',
  tags: ['config'],
  request: { body: { content: jsonBody(ConfigCatalogPutRequest) } },
  responses: withValidationError({
    200: { description: 'Saved', content: jsonBody(ConfigCatalogPutResponse) },
    400: { description: 'Invalid request', content: jsonBody(ErrorBody) },
  }),
});

ltConfigRoutes.openapi(putCatalogRoute, (c) => {
  const { catalog_path: value } = c.req.valid('json');
  if (!value.toLowerCase().endsWith('.lrcat')) {
    return c.json({ error: 'catalog_path must be a .lrcat file' }, 400);
  }
  if (!isFile(expandUserPath(value))) {
    return c.json({ error: 'catalog_path must be an existing file' }, 400);
  }

  if (isLibraryDbPinned()) {
    const recorded = pinnedLibraryCatalogPath();
    if (recorded) {
      const recordedAbs = absoluteCatalogPath(recorded);
      const newAbs = absoluteCatalogPath(value);
      const recordedBase = recordedAbs.split('/').pop() ?? '';
      const newBase = newAbs.split('/').pop() ?? '';
      if (recordedBase.toLowerCase() !== newBase.toLowerCase()) {
        return c.json({ error: 'library pinned by LIBRARY_DB' }, 400);
      }
      if (recordedAbs !== newAbs) {
        updatePinnedLibraryCatalogPath(newAbs);
      }
    }
  }

  updateConfigYamlCatalogPath(config.LT_CONFIG_YAML, value);
  invalidateOpenLibraryCache();
  return c.json({ catalog_path: value.trim(), ok: true }, 200);
});

// --- stack detection --------------------------------------------------------

const getStackDetectionRoute = createRoute({
  method: 'get',
  path: '/config/stack-detection',
  tags: ['config'],
  responses: withValidationError({
    200: {
      description: 'Stack detection config',
      content: jsonBody(ConfigStackDetectionGetResponse),
    },
  }),
});

ltConfigRoutes.openapi(getStackDetectionRoute, (c) => {
  const cfg = loadLibraryConfig(config.LT_CONFIG_YAML);
  return c.json({ stack_burst_delta_ms: Math.trunc(cfg.stackBurstDeltaMs) }, 200);
});

const putStackDetectionRoute = createRoute({
  method: 'put',
  path: '/config/stack-detection',
  tags: ['config'],
  request: { body: { content: jsonBody(ConfigStackDetectionPutRequest) } },
  responses: withValidationError({
    200: { description: 'Saved', content: jsonBody(ConfigStackDetectionPutResponse) },
    400: { description: 'Invalid request', content: jsonBody(ErrorBody) },
  }),
});

ltConfigRoutes.openapi(putStackDetectionRoute, (c) => {
  const { stack_burst_delta_ms: value } = c.req.valid('json');
  if (value < 1) {
    return c.json({ error: 'stack_burst_delta_ms must be at least 1' }, 400);
  }

  updateConfigYamlStackBurstDeltaMs(config.LT_CONFIG_YAML, value);
  return c.json({ stack_burst_delta_ms: value, ok: true }, 200);
});
