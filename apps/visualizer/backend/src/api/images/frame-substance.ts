/**
 * Frame substance per-image read and mutation routes.
 *
 * Registered onto the catalog group so both share one `library.db` middleware.
 * A second route group would open two connections per catalog request.
 */
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { ERROR_IMAGE_NOT_FOUND } from '../../constants/errors.js';
import { getImage } from '../../db/library/catalog.js';
import {
  deleteFrameSubstanceOverride,
  getFrameSubstanceVerdict,
  getLatestFinishedFrameSubstanceRun,
  hasExcusalChannelHint,
  hasFrameSubstanceOverride,
  insertFrameSubstanceOverride,
  isFrameSubstanceFlagged,
  isFrameSubstanceVerdictStale,
} from '../../db/library/frame-substance.js';
import type { LibraryEnv } from '../library-db.js';
import { libraryWrite } from '../../db/library/write.js';
import type { Db } from '../../db/connection.js';
import {
  describeLrCatalogWriteStatus,
  readCullKeywordPresent,
  removeCullKeyword,
  writeCullKeyword,
} from '../../utils/lr-catalog-write.js';
import { jsonBody, withValidationError } from '../route-helpers.js';
import { ErrorBody } from '../schemas/errors.js';
import {
  CullKeywordMutationResponse,
  FrameSubstanceOverrideResponse,
  FrameSubstanceResponse,
} from '../schemas/frame-substance.js';

const imageKeyParams = z.object({ image_key: z.string() });

/**
 * Assemble the verdict panel payload.
 *
 * Two signals, deliberately not merged: the pixel detector's verdict (tier A for
 * `void`, tier B for `illegible`) and, only when the detector has nothing to say,
 * the advisory excusal-channel hint. Collapsing them would let a weak signal look
 * like a detector judgement in the UI.
 */
function buildFrameSubstanceResponse(
  db: Db,
  imageKey: string,
): z.infer<typeof FrameSubstanceResponse> {
  const verdictRow = getFrameSubstanceVerdict(db, imageKey);
  const hasRun = getLatestFinishedFrameSubstanceRun(db) !== null;
  const catalogStatus = describeLrCatalogWriteStatus();

  let instrument: z.infer<typeof FrameSubstanceResponse>['instrument'] = null;
  let restoreTier: 'A' | 'B' | null = null;
  let verdictValue: 'void' | 'illegible' | 'ok' | 'unknown' | null = null;
  let unknownReason: string | null = null;
  let detectorVersion: string | null = null;
  let judgedAt: string | null = null;

  if (verdictRow !== null) {
    verdictValue = verdictRow.verdict;
    // Empty strings become null.
    unknownReason = String(verdictRow.unknown_reason || '') || null;
    detectorVersion = String(verdictRow.detector_version || '') || null;
    judgedAt = String(verdictRow.judged_at || '') || null;
    if (verdictValue === 'void' || verdictValue === 'illegible') {
      const tier = verdictValue === 'void' ? 'A' : 'B';
      instrument = { kind: 'pixel_detector', verdict: verdictValue, tier, advisory: false };
      restoreTier = tier;
    }
  }
  if (instrument === null && hasExcusalChannelHint(db, imageKey)) {
    instrument = { kind: 'excusal_channel', verdict: null, tier: null, advisory: true };
  }

  // `null` rather than `false` when the catalog cannot be read: "we do not know" is
  // a different state from "the keyword is absent", and the UI renders them
  // differently.
  const hasCullKeyword = catalogStatus.available ? readCullKeywordPresent(db, imageKey) : null;

  return {
    image_key: imageKey,
    has_detection_run: hasRun,
    verdict: verdictValue,
    unknown_reason: unknownReason,
    detector_version: detectorVersion,
    judged_at: judgedAt,
    is_stale: isFrameSubstanceVerdictStale(db, imageKey, { verdictRow }),
    has_override: hasFrameSubstanceOverride(db, imageKey),
    flagged: isFrameSubstanceFlagged(db, imageKey),
    has_cull_keyword: hasCullKeyword,
    instrument,
    restore_tier: restoreTier,
    catalog_write_available: catalogStatus.available,
    catalog_write_unavailable_reason: catalogStatus.reason,
  };
}

/**
 * Add the frame-substance routes to the catalog group.
 *
 * Takes the app rather than creating one so it shares the caller's `library.db`
 * middleware; the caller must open the connection writable for POST and DELETE.
 */
export function registerFrameSubstanceRoutes(app: OpenAPIHono<LibraryEnv>): void {
  // --- read -------------------------------------------------------------------

  const getRoute = createRoute({
    method: 'get',
    path: '/images/catalog/{image_key}/frame-substance',
    tags: ['images-catalog'],
    request: { params: imageKeyParams },
    responses: withValidationError({
      200: { description: 'OK', content: jsonBody(FrameSubstanceResponse) },
      404: { description: 'Not Found', content: jsonBody(ErrorBody) },
    }),
  });

  app.openapi(getRoute, (c) => {
    const db = c.get('libraryDb');
    const imageKey = c.req.valid('param').image_key;
    if (!getImage(db, imageKey)) return c.json({ error: ERROR_IMAGE_NOT_FOUND }, 404);
    return c.json(buildFrameSubstanceResponse(db, imageKey), 200);
  });

  // --- override ---------------------------------------------------------------

  const overrideResponses = withValidationError({
    200: { description: 'OK', content: jsonBody(FrameSubstanceOverrideResponse) },
    404: { description: 'Not Found', content: jsonBody(ErrorBody) },
  });

  const postOverrideRoute = createRoute({
    method: 'post',
    path: '/images/catalog/{image_key}/frame-substance/override',
    tags: ['images-catalog'],
    request: { params: imageKeyParams },
    responses: overrideResponses,
  });

  app.openapi(postOverrideRoute, (c) => {
    const db = c.get('libraryDb');
    const imageKey = c.req.valid('param').image_key;
    if (!getImage(db, imageKey)) return c.json({ error: ERROR_IMAGE_NOT_FOUND }, 404);

    libraryWrite(db, () => insertFrameSubstanceOverride(db, imageKey));
    // Reports the intended state, not a re-read; the insert is idempotent.
    return c.json({ image_key: imageKey, has_override: true }, 200);
  });

  const deleteOverrideRoute = createRoute({
    method: 'delete',
    path: '/images/catalog/{image_key}/frame-substance/override',
    tags: ['images-catalog'],
    request: { params: imageKeyParams },
    responses: overrideResponses,
  });

  app.openapi(deleteOverrideRoute, (c) => {
    const db = c.get('libraryDb');
    const imageKey = c.req.valid('param').image_key;
    if (!getImage(db, imageKey)) return c.json({ error: ERROR_IMAGE_NOT_FOUND }, 404);

    libraryWrite(db, () => deleteFrameSubstanceOverride(db, imageKey));
    // Deleting an override that was never there is a successful no-op.
    return c.json({ image_key: imageKey, has_override: false }, 200);
  });

  // --- cull keyword (writes the live Lightroom catalog) -----------------------

  const cullResponses = withValidationError({
    200: { description: 'OK', content: jsonBody(CullKeywordMutationResponse) },
    400: { description: 'Bad Request', content: jsonBody(ErrorBody) },
    404: { description: 'Not Found', content: jsonBody(ErrorBody) },
  });

  const postCullRoute = createRoute({
    method: 'post',
    path: '/images/catalog/{image_key}/cull-keyword',
    tags: ['images-catalog'],
    request: { params: imageKeyParams },
    responses: cullResponses,
  });

  app.openapi(postCullRoute, (c) => {
    const db = c.get('libraryDb');
    const imageKey = c.req.valid('param').image_key;
    if (!getImage(db, imageKey)) return c.json({ error: ERROR_IMAGE_NOT_FOUND }, 404);

    try {
      return c.json({ image_key: imageKey, result: writeCullKeyword(db, imageKey) }, 200);
    } catch (e) {
      // An unavailable or locked catalog is a 400 the user can act on ("close
      // Lightroom"), not a 500. Anything else is genuinely unexpected.
      if (e instanceof RangeError || (e instanceof Error && /Close Lightroom/.test(e.message))) {
        return c.json({ error: e.message }, 400);
      }
      throw e;
    }
  });

  const deleteCullRoute = createRoute({
    method: 'delete',
    path: '/images/catalog/{image_key}/cull-keyword',
    tags: ['images-catalog'],
    request: { params: imageKeyParams },
    responses: cullResponses,
  });

  app.openapi(deleteCullRoute, (c) => {
    const db = c.get('libraryDb');
    const imageKey = c.req.valid('param').image_key;
    if (!getImage(db, imageKey)) return c.json({ error: ERROR_IMAGE_NOT_FOUND }, 404);

    try {
      return c.json({ image_key: imageKey, result: removeCullKeyword(db, imageKey) }, 200);
    } catch (e) {
      if (e instanceof RangeError || (e instanceof Error && /Close Lightroom/.test(e.message))) {
        return c.json({ error: e.message }, 400);
      }
      throw e;
    }
  });
}
