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
import { jsonBody, withValidationError } from '../route-helpers.js';
import { ErrorBody } from '../schemas/errors.js';
import { FrameSubstanceOverrideResponse, FrameSubstanceResponse } from '../schemas/frame-substance.js';

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
    instrument,
    restore_tier: restoreTier,
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
}
