/**
 * Read and write the repo-level `config.yaml`.
 *
 * These routes edit the user's own config file, so there is no library-DB
 * middleware here. The one exception is `GET /config/catalog`, which reads a
 * single `library_meta` key to answer whether `library.db` still mirrors the
 * configured catalog — opened by hand, read-only, and closed before returning,
 * because a missing or unreadable library is a normal answer here rather than
 * the 404 the middleware would raise.
 */
import { createRoute } from '@hono/zod-openapi';
import { existsSync, statSync } from 'node:fs';
import {
  config,
  expandUserPath,
  loadLibraryConfig,
  updateConfigYamlCatalogPath,
  updateConfigYamlStackBurstDeltaMs,
} from '../config.js';
import { openLibraryDb, type Db } from '../db/connection.js';
import { getLibraryMeta, SYNCED_CATALOG_META_KEY } from '../db/library/bootstrap.js';
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

/**
 * The catalog `library.db` was last synced from, or `null` when that is unknown —
 * no library yet, or one built before the key existed. `null` means "cannot say",
 * not "out of sync", so the UI stays quiet rather than warning on a guess.
 */
function syncedCatalogPath(): string | null {
  if (!existsSync(config.LIBRARY_DB)) return null;
  let db: Db | undefined;
  try {
    db = openLibraryDb(config.LIBRARY_DB, { readonly: true });
    return getLibraryMeta(db, SYNCED_CATALOG_META_KEY);
  } catch {
    return null;
  } finally {
    db?.close();
  }
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
  // The RAW value is echoed back, not the resolved one: the UI edits what the user
  // typed (which may contain `~`), and `resolved_path` is shown alongside it.
  const raw = cfg.catalogPathRaw || '';
  const resolved = raw ? expandUserPath(raw) : '';
  // `cfg.catalogPath`, not `resolved`: the sync records the path the config loader
  // produced, so comparing anything else would read a relative path as a mismatch.
  const synced = syncedCatalogPath();
  return c.json(
    {
      catalog_path: raw,
      resolved_path: resolved,
      exists: Boolean(resolved && isFile(resolved)),
      picker_available: nativeFileDialogAvailable(),
      synced_catalog_path: synced,
      needs_catalog_sync: synced !== null && synced !== cfg.catalogPath,
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

// Blocks until the user answers the dialog, which is the point: the response is
// their answer. It does not save — the path still goes through PUT's validation.
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

// Presence and type are the schema's job and answer 422 before this runs. What is
// left is the two checks Zod cannot make: the extension, and whether the file is
// really there.
ltConfigRoutes.openapi(putCatalogRoute, (c) => {
  const { catalog_path: value } = c.req.valid('json');
  if (!value.toLowerCase().endsWith('.lrcat')) {
    return c.json({ error: 'catalog_path must be a .lrcat file' }, 400);
  }
  if (!isFile(expandUserPath(value))) {
    return c.json({ error: 'catalog_path must be an existing file' }, 400);
  }

  updateConfigYamlCatalogPath(config.LT_CONFIG_YAML, value);
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

// `z.int()` already rejects a missing field, a fractional number, a numeric string
// and a boolean with 422. The floor is the one rule left to enforce.
ltConfigRoutes.openapi(putStackDetectionRoute, (c) => {
  const { stack_burst_delta_ms: value } = c.req.valid('json');
  if (value < 1) {
    return c.json({ error: 'stack_burst_delta_ms must be at least 1' }, 400);
  }

  updateConfigYamlStackBurstDeltaMs(config.LT_CONFIG_YAML, value);
  return c.json({ stack_burst_delta_ms: value, ok: true }, 200);
});
