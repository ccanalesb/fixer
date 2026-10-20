/**
 * Lightroom write-back settings, write-pending, and per-photo detail (#341).
 */
import { createRoute, z } from '@hono/zod-openapi';
import { config, loadLibraryConfig } from '../config.js';
import { countStrongDimensions, ratingFromStrongCount } from '../lightroom/writeback-stars.js';
import { markEligiblePending, reconcileLrWriteback, undoWritebackKind } from '../lightroom/writeback.js';
import type { WritebackKind } from '../lightroom/writeback-types.js';
import { resolveCurrentStages } from '../cull/stages.js';
import { getCurrentPipelineSetting } from '../db/library/cull-pipeline.js';
import { getCullRecipe } from '../db/library/cull-recipes.js';
import { loadCurrentStageAnswers, readStoredLayaModelIds } from '../db/library/cull-stages.js';
import { countWritebackByStatus, getWritebackState } from '../db/library/lr-writeback-state.js';
import {
  activePipelineRecipeSlugs,
  getLrWritebackSettings,
  patchLrWritebackSettings,
  resolveStarsRecipeSlug,
} from '../db/library/lr-writeback-settings.js';
import { describeLrCatalogWriteStatus } from '../utils/lr-catalog-write.js';
import {
  AUTO_REJECT_KEYWORD,
  AUTO_STARS_KEYWORD,
  connectCatalog,
  imageHasKeywordByKey,
  readPickRating,
} from '../lightroom/writer.js';
import { HttpError } from '../utils/responses.js';
import { libraryDb, type LibraryEnv } from './library-db.js';
import { createOpenApiApp } from './openapi.js';
import { jsonBody, withValidationError } from './route-helpers.js';
import { ErrorBody } from './schemas/errors.js';
import {
  LrWritebackPhotoDetailSchema,
  LrWritebackSettingsPatchSchema,
  LrWritebackSettingsSchema,
  LrWritebackWritePendingResponse,
} from './schemas/lr-writeback.js';

export const lrWritebackRoutes = createOpenApiApp<LibraryEnv>();

lrWritebackRoutes.use('/cull/lightroom-writeback/*', libraryDb({ write: true }));

function settingsPayload(db: import('../db/connection.js').Db) {
  const settings = getLrWritebackSettings(db);
  const counts = countWritebackByStatus(db);
  const status = describeLrCatalogWriteStatus();
  return {
    write_stars: settings.write_stars,
    write_reject: settings.write_reject,
    stars_recipe_slug: settings.stars_recipe_slug,
    active_recipe_slugs: activePipelineRecipeSlugs(db),
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
  patchLrWritebackSettings(db, body);
  const after = getLrWritebackSettings(db);
  if (!before.write_stars && after.write_stars) markEligiblePending(db, 'stars');
  if (!before.write_reject && after.write_reject) markEligiblePending(db, 'reject');
  return c.json(settingsPayload(db), 200);
});

const writePendingRoute = createRoute({
  method: 'post',
  path: '/cull/lightroom-writeback/write-pending',
  tags: ['cull'],
  responses: withValidationError({
    200: { description: 'Write pending result', content: jsonBody(LrWritebackWritePendingResponse) },
    400: { description: 'Catalog locked', content: jsonBody(ErrorBody) },
  }),
});

lrWritebackRoutes.openapi(writePendingRoute, async (c) => {
  const db = c.get('libraryDb');
  const status = describeLrCatalogWriteStatus();
  if (!status.available) {
    throw new HttpError(400, status.reason ?? 'Lightroom catalog unavailable.');
  }
  const result = await reconcileLrWriteback(db, { trigger: 'write_pending' });
  return c.json(
    {
      stars: {
        pending: result.stars.pending,
        written: result.stars.written,
        catalog_updated: result.catalog_updated_stars,
      },
      reject: {
        pending: result.reject.pending,
        written: result.reject.written,
        catalog_updated: result.catalog_updated_reject,
      },
    },
    200,
  );
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
  const starsSlug = resolveStarsRecipeSlug(db, settings);
  const starsRow = getWritebackState(db, imageKey, 'stars');
  const rejectRow = getWritebackState(db, imageKey, 'reject');

  const status = describeLrCatalogWriteStatus();
  let live: ReturnType<typeof readPickRating> = null;
  const keywords: string[] = [];
  if (status.available && status.path) {
    const conn = connectCatalog(status.path);
    try {
      live = readPickRating(conn, imageKey);
      if (imageHasKeywordByKey(conn, imageKey, AUTO_STARS_KEYWORD)) keywords.push(AUTO_STARS_KEYWORD);
      if (imageHasKeywordByKey(conn, imageKey, AUTO_REJECT_KEYWORD)) keywords.push(AUTO_REJECT_KEYWORD);
    } finally {
      conn.close();
    }
  }

  let strongLine: string | null = null;
  if (starsSlug) {
    const recipe = getCullRecipe(db, starsSlug);
    if (recipe) {
      const modelIds = readStoredLayaModelIds(db);
      const pipe = getCurrentPipelineSetting(db);
      const stages = modelIds
        ? resolveCurrentStages(db, pipe.config, modelIds).filter(
            (s) => s.recipeSlug === starsSlug && s.kind === 'culling_recipe',
          )
        : [];
      const answers = loadCurrentStageAnswers(db, stages, [imageKey]).get(imageKey) ?? {};
      const count = countStrongDimensions(recipe.definition, recipe.rule, answers, starsSlug);
      const rating = ratingFromStrongCount(count);
      strongLine =
        rating === null
          ? `Strong dimensions (${recipe.name}): none`
          : `Strong dimensions (${recipe.name}): ${count} strong → ${'★'.repeat(rating)}`;
    }
  }

  const ratingUserChanged =
    starsRow?.status === 'written' && live !== null && live.rating !== starsRow.written_rating;
  const flagUserChanged = rejectRow?.status === 'written' && live !== null && live.pick !== rejectRow.written_pick;

  return c.json(
    {
      image_key: imageKey,
      rating: {
        live: live?.rating ?? null,
        app_wrote: starsRow?.status === 'written',
        before_label: starsRow?.before_rating === null ? 'before: no rating' : null,
        undo_available:
          starsRow?.status === 'written' &&
          live !== null &&
          live.rating === starsRow.written_rating &&
          !ratingUserChanged,
        user_changed: Boolean(ratingUserChanged),
      },
      flag: {
        live_pick: live?.pick ?? null,
        app_wrote_reject: rejectRow?.status === 'written',
        undo_available:
          rejectRow?.status === 'written' && live !== null && live.pick === rejectRow.written_pick && !flagUserChanged,
        user_changed: Boolean(flagUserChanged),
      },
      keywords,
      strong_dimensions_line: strongLine,
    },
    200,
  );
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
