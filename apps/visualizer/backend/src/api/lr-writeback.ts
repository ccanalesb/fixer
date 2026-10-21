/**
 * Lightroom write-back settings and per-photo detail (#341).
 */
import { createRoute, z } from '@hono/zod-openapi';
import { config, loadLibraryConfig } from '../config.js';
import { buildWritebackPhotoDetail, undoWritebackKind } from '../lightroom/writeback.js';
import type { WritebackKind } from '../lightroom/writeback-types.js';
import { countWritebackByStatus } from '../db/library/lr-writeback-state.js';
import {
  activePipelineProfileSlugs,
  activePipelineProfiles,
  getLrWritebackSettings,
  patchLrWritebackSettings,
} from '../db/library/lr-writeback-settings.js';
import { getJob, initJobsDb } from '../db/jobs/jobs.js';
import {
  cancelActiveLrWritebackJobs,
  enqueueLrWritebackWrite,
  findActiveLrWritebackJob,
} from '../jobs/handlers/lr-writeback.js';
import { compactJobPayload } from './schemas/jobs.js';
import { describeLrCatalogWriteStatus } from '../utils/lr-catalog-write.js';
import { HttpError } from '../utils/responses.js';
import { emitJobEvent } from '../websocket/events.js';
import { libraryDb, type LibraryEnv } from './library-db.js';
import { createOpenApiApp } from './openapi.js';
import { jsonBody, withValidationError } from './route-helpers.js';
import { ErrorBody } from './schemas/errors.js';
import {
  LrWritebackPhotoDetailSchema,
  LrWritebackSettingsPatchSchema,
  LrWritebackSettingsSchema,
  LrWritebackWriteResponse,
} from './schemas/lr-writeback.js';

export const lrWritebackRoutes = createOpenApiApp<LibraryEnv>();

lrWritebackRoutes.use('/cull/lightroom-writeback/*', libraryDb({ write: true }));

function withJobsDb<T>(fn: (db: import('../db/connection.js').Db) => T): T {
  const db = initJobsDb(config.VISUALIZER_DB);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function settingsPayload(db: import('../db/connection.js').Db) {
  const settings = getLrWritebackSettings(db);
  const counts = countWritebackByStatus(db);
  const status = describeLrCatalogWriteStatus();
  return {
    write_stars: settings.write_stars,
    write_reject: settings.write_reject,
    stars_profile_slug: settings.stars_profile_slug,
    active_profile_slugs: activePipelineProfileSlugs(db),
    active_profiles: activePipelineProfiles(db),
    catalog_write_available: status.available,
    catalog_write_unavailable_reason: status.reason,
    counts: {
      stars: { pending: counts.stars.pending, written: counts.stars.written },
      reject: { pending: counts.reject.pending, written: counts.reject.written },
    },
  };
}

const getSettingsRoute = createRoute({
  method: 'get',
  path: '/cull/lightroom-writeback/settings',
  tags: ['cull'],
  responses: withValidationError({
    200: { description: 'Write-back settings', content: jsonBody(LrWritebackSettingsSchema) },
  }),
});

lrWritebackRoutes.openapi(getSettingsRoute, (c) => {
  const db = c.get('libraryDb');
  return c.json(settingsPayload(db), 200);
});

const patchSettingsRoute = createRoute({
  method: 'patch',
  path: '/cull/lightroom-writeback/settings',
  tags: ['cull'],
  request: { body: { content: jsonBody(LrWritebackSettingsPatchSchema) } },
  responses: withValidationError({
    200: { description: 'Updated settings', content: jsonBody(LrWritebackSettingsSchema) },
  }),
});

lrWritebackRoutes.openapi(patchSettingsRoute, (c) => {
  const db = c.get('libraryDb');
  const body = c.req.valid('json');
  const before = getLrWritebackSettings(db);

  const turningStarsOff = body.write_stars === false && before.write_stars;
  const turningRejectOff = body.write_reject === false && before.write_reject;
  const turningAnyOff = turningStarsOff || turningRejectOff;

  patchLrWritebackSettings(db, body);

  if (turningAnyOff) {
    withJobsDb((jobsDb) => cancelActiveLrWritebackJobs(jobsDb));
  }

  return c.json(settingsPayload(db), 200);
});

const writeRoute = createRoute({
  method: 'post',
  path: '/cull/lightroom-writeback/write',
  tags: ['cull'],
  responses: withValidationError({
    200: { description: 'Write-back job enqueued', content: jsonBody(LrWritebackWriteResponse) },
  }),
});

lrWritebackRoutes.openapi(writeRoute, (c) => {
  const db = c.get('libraryDb');
  const settings = getLrWritebackSettings(db);
  if (!settings.write_stars && !settings.write_reject) {
    throw new HttpError(400, 'Enable at least one write-back switch first.');
  }
  const jobId = withJobsDb((jobsDb) => {
    const hadActive = Boolean(findActiveLrWritebackJob(jobsDb));
    const id = enqueueLrWritebackWrite(jobsDb);
    if (!hadActive) {
      const job = getJob(jobsDb, id);
      if (job) {
        emitJobEvent('job_created', compactJobPayload(job as unknown as Record<string, unknown>) as never);
      }
    }
    return id;
  });
  return c.json({ job_id: jobId }, 200);
});

const photoDetailRoute = createRoute({
  method: 'get',
  path: '/cull/lightroom-writeback/photos/{image_key}',
  tags: ['cull'],
  request: { params: z.object({ image_key: z.string() }) },
  responses: withValidationError({
    200: { description: 'Per-photo write-back readout', content: jsonBody(LrWritebackPhotoDetailSchema) },
  }),
});

lrWritebackRoutes.openapi(photoDetailRoute, (c) => {
  const db = c.get('libraryDb');
  const imageKey = c.req.valid('param').image_key;
  const settings = getLrWritebackSettings(db);
  const status = describeLrCatalogWriteStatus();
  if (!status.available || !status.path) {
    throw new HttpError(400, status.reason ?? 'Lightroom catalog unavailable.');
  }
  return c.json(buildWritebackPhotoDetail(db, status.path, imageKey, settings), 200);
});

const undoRoute = createRoute({
  method: 'post',
  path: '/cull/lightroom-writeback/photos/{image_key}/undo',
  tags: ['cull'],
  request: {
    params: z.object({ image_key: z.string() }),
    body: { content: jsonBody(z.object({ kind: z.enum(['stars', 'reject']) }).strict()) },
  },
  responses: withValidationError({
    200: { description: 'Undo result', content: jsonBody(z.object({ ok: z.boolean(), reason: z.string().optional() })) },
    400: { description: 'Cannot undo', content: jsonBody(ErrorBody) },
  }),
});

lrWritebackRoutes.openapi(undoRoute, (c) => {
  const db = c.get('libraryDb');
  const imageKey = c.req.valid('param').image_key;
  const { kind } = c.req.valid('json');
  const status = describeLrCatalogWriteStatus();
  if (!status.available || !status.path) {
    throw new HttpError(400, status.reason ?? 'Lightroom catalog unavailable.');
  }
  const cfg = loadLibraryConfig(config.LT_CONFIG_YAML);
  const path = (cfg.catalogPath ?? '').trim();
  const result = undoWritebackKind(db, path, imageKey, kind as WritebackKind);
  if (!result.ok) throw new HttpError(400, result.reason ?? 'Undo failed.');
  return c.json(result, 200);
});
