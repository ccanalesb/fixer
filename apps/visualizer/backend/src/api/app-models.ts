/**
 * Models in this app: the models its System One endpoint serves, the conversion jobs installing more,
 * and the folder dialog for choosing one (the catalog row's mechanism, ADR-0019: it opens on the
 * backend's machine, so the UI offers it only to a browser on that machine).
 */
import { createRoute } from '@hono/zod-openapi';
import { config, loadLibraryConfig } from '../config.js';
import type { Db } from '../db/connection.js';
import { getJob, initJobsDb } from '../db/jobs/jobs.js';
import { AppModelSourceError, addAppModel, listAppModels } from '../app-models/install.js';
import {
  FileDialogBusyError,
  FileDialogUnavailableError,
  chooseFolder,
  nativeFileDialogAvailable,
} from '../utils/native-file-dialog.js';
import { errorBadRequest } from '../utils/responses.js';
import { emitJobEvent } from '../websocket/events.js';
import { createOpenApiApp } from './openapi.js';
import { jsonBody, withValidationError } from './route-helpers.js';
import {
  AppModelAddRequest,
  AppModelAddResponse,
  AppModelPickResponse,
  AppModelsListResponse,
} from './schemas/app-models.js';
import { ErrorBody } from './schemas/errors.js';
import { compactJobPayload } from './schemas/jobs.js';

export const appModelsRoutes = createOpenApiApp();

function withJobsDb<T>(fn: (db: Db) => T): T {
  const db = initJobsDb(config.VISUALIZER_DB);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const modelsDir = () => loadLibraryConfig(config.LT_CONFIG_YAML).appModelsDir;

const listRoute = createRoute({
  method: 'get',
  path: '/app-models',
  tags: ['app-models'],
  responses: withValidationError({
    200: { description: 'Installed and converting models', content: jsonBody(AppModelsListResponse) },
  }),
});

appModelsRoutes.openapi(listRoute, (c) =>
  c.json(
    {
      models: withJobsDb((db) => listAppModels(modelsDir(), db)),
      picker_available: nativeFileDialogAvailable(),
    },
    200,
  ),
);

const addRoute = createRoute({
  method: 'post',
  path: '/app-models',
  tags: ['app-models'],
  request: { body: { content: jsonBody(AppModelAddRequest) } },
  responses: withValidationError({
    200: { description: 'Conversion job queued', content: jsonBody(AppModelAddResponse) },
    400: { description: 'Neither a folder nor a Hugging Face id', content: jsonBody(ErrorBody) },
    409: { description: 'That source is already converting', content: jsonBody(ErrorBody) },
  }),
});

appModelsRoutes.openapi(addRoute, (c) => {
  const { source } = c.req.valid('json');
  try {
    const added = withJobsDb((db) => {
      const out = addAppModel(db, modelsDir(), source);
      const job = getJob(db, out.job_id);
      if (job) emitJobEvent('job_created', compactJobPayload(job as unknown as Record<string, unknown>) as never);
      return out;
    });
    return c.json(added, 200);
  } catch (e) {
    if (!(e instanceof AppModelSourceError)) throw e;
    return e.status === 409 ? c.json({ error: e.message }, 409) : errorBadRequest(c, e.message);
  }
});

const pickRoute = createRoute({
  method: 'post',
  path: '/app-models/pick',
  tags: ['app-models'],
  responses: withValidationError({
    200: { description: 'Chosen folder, or null', content: jsonBody(AppModelPickResponse) },
    409: { description: 'A dialog is already open', content: jsonBody(ErrorBody) },
    500: { description: 'The dialog failed to open', content: jsonBody(ErrorBody) },
    501: { description: 'This host has no native dialog', content: jsonBody(ErrorBody) },
  }),
});

// Blocks until the user answers the dialog. It does not add: the folder still goes through POST.
appModelsRoutes.openapi(pickRoute, async (c) => {
  try {
    const result = await chooseFolder('Select a model folder in Hugging Face format');
    return c.json({ path: 'path' in result ? result.path : null }, 200);
  } catch (error) {
    if (error instanceof FileDialogUnavailableError) return c.json({ error: error.message }, 501);
    if (error instanceof FileDialogBusyError) return c.json({ error: error.message }, 409);
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
