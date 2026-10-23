/**
 * Read-only REST API for persisted `image_scores` rows (library DB).
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
  getCurrentScoresForImage,
  listScoreHistoryForPerspective,
  type ImageScoreRow as DbScoreRow,
} from '../db/library/scores.js';
import { libraryDb, type LibraryEnv } from './library-db.js';
import { isValidPerspectiveSlug } from '../utils/perspective-slug.js';
import { createOpenApiApp } from './openapi.js';
import { jsonBody, withValidationError } from './route-helpers.js';
import { ErrorBody } from './schemas/errors.js';
import {
  ImageScoreRow,
  ScoresCurrentResponse,
  ScoresHistoryResponse,
} from './schemas/scores.js';

export const scoresRoutes = createOpenApiApp<LibraryEnv>();

// Every scores route reads the library DB; open it once per request here.
scoresRoutes.use('*', libraryDb());

/** SQLite stores these as 0/1; the API contract is boolean. */
function normalizeScoreRow(row: DbScoreRow): z.infer<typeof ImageScoreRow> {
  return {
    ...row,
    is_current: Boolean(row.is_current),
    repaired_from_malformed: Boolean(row.repaired_from_malformed),
    not_attempted: Boolean(row.not_attempted),
  };
}

/**
 * `image_type` is accepted but only `catalog` is valid — the Instagram scope was
 * removed. Kept as a parameter so existing callers get a clear 400 rather
 * than silently different data.
 */
function readImageType(raw: string | undefined): { ok: true; value: 'catalog' } | { ok: false } {
  const value = (raw ?? 'catalog').trim().toLowerCase();
  return value === 'catalog' ? { ok: true, value } : { ok: false };
}

/**
 * Plain `{image_key}` routing — no greedy `{.+}` — because no catalog keys contain
 * slashes. A greedy pattern would swallow `/history` unless registration order is exact.
 */
const historyRoute = createRoute({
  method: 'get',
  path: '/{image_key}/history',
  tags: ['scores'],
  request: { params: z.object({ image_key: z.string() }) },
  responses: withValidationError({
    200: { description: 'Score history for one perspective', content: jsonBody(ScoresHistoryResponse) },
    400: { description: 'Invalid request', content: jsonBody(ErrorBody) },
  }),
});

scoresRoutes.openapi(historyRoute, (c) => {
  const imageKey = c.req.valid('param').image_key;
  const imageType = readImageType(c.req.query('image_type'));
  if (!imageType.ok) return c.json({ error: 'image_type must be catalog' }, 400);

  const perspectiveSlug = (c.req.query('perspective_slug') ?? '').trim();
  if (!perspectiveSlug) return c.json({ error: 'perspective_slug is required' }, 400);
  if (!isValidPerspectiveSlug(perspectiveSlug)) {
    return c.json({ error: 'invalid perspective_slug' }, 400);
  }

  const rows = listScoreHistoryForPerspective(
    c.get('libraryDb'),
    imageKey,
    imageType.value,
    perspectiveSlug,
  );
  return c.json(
    {
      image_key: imageKey,
      image_type: imageType.value,
      perspective_slug: perspectiveSlug,
      history: rows.map(normalizeScoreRow),
    },
    200,
  );
});

const currentRoute = createRoute({
  method: 'get',
  path: '/{image_key}',
  tags: ['scores'],
  request: { params: z.object({ image_key: z.string() }) },
  responses: withValidationError({
    200: { description: 'Current scores for an image', content: jsonBody(ScoresCurrentResponse) },
    400: { description: 'Invalid request', content: jsonBody(ErrorBody) },
  }),
});

scoresRoutes.openapi(currentRoute, (c) => {
  const imageKey = c.req.valid('param').image_key;
  const imageType = readImageType(c.req.query('image_type'));
  if (!imageType.ok) return c.json({ error: 'image_type must be catalog' }, 400);

  const rows = getCurrentScoresForImage(c.get('libraryDb'), imageKey, imageType.value);
  return c.json(
    {
      image_key: imageKey,
      image_type: imageType.value,
      current: rows.map(normalizeScoreRow),
    },
    200,
  );
});
