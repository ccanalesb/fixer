/**
 * Read and write the repo-level `config.yaml`.
 *
 * These routes edit the user's own config file, so there is no library-DB
 * middleware here.
 */
import { createRoute } from '@hono/zod-openapi';
import { existsSync, statSync } from 'node:fs';
import {
  applyCatalogChange,
  previewCatalogChange,
} from '../catalog-change.js';
import {
  findCatalogLibrariesForPath,
  inferCatalogKind,
} from '../catalog-library.js';
import { folderCatalogStats } from '../folder/walk.js';
import {
  config,
  expandUserPath,
  loadLibraryConfig,
  updateConfigYamlStackBurstDeltaMs,
} from '../config.js';
import { openLibraryDb } from '../db/connection.js';
import { getImageCount } from '../db/library/statistics.js';
import { getJob, initJobsDb } from '../db/jobs/jobs.js';
import { emitJobEvent } from '../websocket/events.js';
import { createOpenApiApp } from './openapi.js';
import { jsonBody, withValidationError } from './route-helpers.js';
import { compactJobPayload } from './schemas/jobs.js';
import {
  ConfigCatalogChangePreviewRequest,
  ConfigCatalogChangePreviewResponse,
  ConfigCatalogGetResponse,
  ConfigCatalogPickFolderResponse,
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
  chooseFolder,
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

function currentPhotoCount(resolved: string): number | null {
  if (!resolved) return null;
  const matches = findCatalogLibrariesForPath(resolved);
  if (matches.length !== 1) return null;
  const dbPath = matches[0]!.libraryDbPath;
  if (!existsSync(dbPath)) return null;
  const db = openLibraryDb(dbPath, { readonly: true });
  try {
    return getImageCount(db);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function catalogPhotoAndFolderCounts(
  resolved: string,
  kind: ReturnType<typeof inferCatalogKind>,
): { photo_count: number | null; folder_count: number | null } {
  if (!resolved || !catalogExists(resolved)) {
    return { photo_count: null, folder_count: null };
  }
  const libraryCount = currentPhotoCount(resolved);
  if (kind === 'folder') {
    const walked = folderCatalogStats(resolved);
    return {
      photo_count: libraryCount && libraryCount > 0 ? libraryCount : walked.photoCount,
      folder_count: walked.folderCount,
    };
  }
  return { photo_count: libraryCount, folder_count: null };
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
  const kind = resolved ? inferCatalogKind(resolved) : 'lightroom';
  const counts = resolved ? catalogPhotoAndFolderCounts(resolved, kind) : { photo_count: null, folder_count: null };
  return c.json(
    {
      catalog_path: raw,
      resolved_path: resolved,
      exists: Boolean(resolved && catalogExists(resolved)),
      catalog_kind: kind,
      photo_count: counts.photo_count,
      folder_count: counts.folder_count,
      picker_available: nativeFileDialogAvailable(),
    },
    200,
  );
});

const previewCatalogChangeRoute = createRoute({
  method: 'post',
  path: '/config/catalog/change-preview',
  tags: ['config'],
  request: { body: { content: jsonBody(ConfigCatalogChangePreviewRequest) } },
  responses: withValidationError({
    200: {
      description: 'What changing the catalog would do',
      content: jsonBody(ConfigCatalogChangePreviewResponse),
    },
    400: { description: 'Invalid request', content: jsonBody(ErrorBody) },
  }),
});

ltConfigRoutes.openapi(previewCatalogChangeRoute, (c) => {
  const { catalog_path: value } = c.req.valid('json');
  const preview = previewCatalogChange(value);
  if ('error' in preview) return c.json({ error: preview.error }, 400);
  return c.json(preview, 200);
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

const pickFolderCatalogRoute = createRoute({
  method: 'post',
  path: '/config/catalog/pick-folder',
  tags: ['config'],
  responses: withValidationError({
    200: { description: 'Chosen folder, or null', content: jsonBody(ConfigCatalogPickFolderResponse) },
    409: { description: 'A dialog is already open', content: jsonBody(ErrorBody) },
    500: { description: 'The dialog failed to open', content: jsonBody(ErrorBody) },
    501: { description: 'This host has no native dialog', content: jsonBody(ErrorBody) },
  }),
});

ltConfigRoutes.openapi(pickFolderCatalogRoute, async (c) => {
  try {
    const result = await chooseFolder('Select a folder of photos');
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
  const { catalog_path: value, change } = c.req.valid('json');
  const result = applyCatalogChange(value, change);
  if ('error' in result) return c.json({ error: result.error }, 400);
  announceCatalogSyncJob(result.catalog_sync_job_id);
  return c.json({ ...result, ok: true }, 200);
});

/** Broadcast the freshly queued catalog sync so connected clients show it at once. */
function announceCatalogSyncJob(jobId: string | null): void {
  if (!jobId) return;
  const jobsDb = initJobsDb(config.VISUALIZER_DB);
  try {
    const job = getJob(jobsDb, jobId);
    if (job) {
      emitJobEvent(
        'job_created',
        compactJobPayload(job as unknown as Record<string, unknown>) as never,
      );
    }
  } finally {
    jobsDb.close();
  }
}

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
