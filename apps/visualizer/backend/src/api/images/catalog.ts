/**
 * Catalog list, thumbnails, CLIP similar, similarity groups, and image detail.
 *
 * Both `/api/images/catalog` and `/api/images/catalog/` are declared — they are two
 * contract entries, not a redirect pair. The thumbnail route is not an `openapi()`
 * route (file response, not JSON).
 */
import { createRoute, z } from '@hono/zod-openapi';
import { existsSync } from 'node:fs';
import { ERROR_IMAGE_NOT_FOUND } from '../../constants/errors.js';
import { NoClipEmbeddingError, runClipSimilarForSeed } from '../../clip/similarity.js';
import {
  CatalogQueryError,
  queryCatalogImages,
  queryCatalogImagesByKeys,
} from '../../db/library/catalog-query.js';
import {
  getCatalogMonths,
  getImage,
  setInstagramPosted,
  type Row,
} from '../../db/library/catalog.js';
import { getBestCurrentCatalogScore } from '../../db/library/catalog-best-score.js';
import { getImageDescription } from '../../db/library/descriptions.js';
import { getCurrentScoresForImage } from '../../db/library/scores.js';
import {
  getCatalogSimilarityGroupsPaginated,
  getSimilarityCandidatesForGroup,
} from '../../db/library/similarity.js';
import { batchCullManuallySent } from '../../db/library/cull-review.js';
import { catalogImageStackRowFields } from '../../db/library/stacks.js';
import { getVisionCachedImage } from '../../db/library/vision-cache.js';
import { libraryDb, type LibraryEnv } from '../library-db.js';
import { libraryWrite } from '../../db/library/write.js';
import { computeSingleImageAggregateScores } from '../../identity/aggregates.js';
import { resolveCatalogPath } from '../../utils/path-resolve.js';
import { clampPagination, errorNotFound } from '../../utils/responses.js';
import { validateScorePerspectiveExists } from '../../utils/score-perspective.js';
import { sendFile } from '../../utils/send-file.js';
import { createOpenApiApp } from '../openapi.js';
import { jsonBody, withValidationError } from '../route-helpers.js';
import {
  type CatalogImage,
  CatalogListResponse,
  CatalogMonthsResponse,
  CatalogSimilarResponse,
  CatalogSimilarityGroupsResponse,
  ImageView,
  InstagramPostedRequest,
  InstagramPostedResponse,
} from '../schemas/catalog.js';
import { ErrorBody } from '../schemas/errors.js';
import { catalogThumbnailRoots, isPathUnderAllowedRoots } from './common.js';
import { registerFrameSubstanceRoutes } from './frame-substance.js';
import { parseCatalogListParams, parseCatalogSimilarParams } from './query-params.js';
import {
  catalogThumbnailUrl,
  clipSimilarityWhyMatchedLine,
  rowsToCatalogApiImages,
} from './row-shaping.js';

export const catalogRoutes = createOpenApiApp<LibraryEnv>();

/**
 * One connection per request, writable only for the mutating method.
 *
 * The bare `/images/catalog` form needs its own registration: `'/images/catalog/*'`
 * does not match a path with nothing after the prefix.
 */
catalogRoutes.use('/images/catalog', libraryDb());
// PATCH is instagram-posted; POST and DELETE are the frame-substance override,
// registered onto this group by `registerFrameSubstanceRoutes`.
catalogRoutes.use(
  '/images/catalog/*',
  libraryDb({ writeForMethods: ['PATCH', 'POST', 'DELETE'] }),
);
catalogRoutes.use('/images/catalog-similarity-groups', libraryDb());

/**
 * Plain `{image_key}` routing — no catalog keys contain slashes. A greedy `{.+}`
 * would swallow `/similar` unless registration order is exact.
 */
const imageKeyParams = z.object({ image_key: z.string() });

// --- thumbnail (not in the OpenAPI document) --------------------------------

/**
 * Serve a catalog thumbnail, preferring the vision cache.
 *
 * Every path that reaches `sendFile` is checked against
 * `catalogThumbnailRoots()` first. That check is the security boundary of this
 * route: the key comes from the URL and the path comes from the database, so
 * neither is trustworthy, and without containment this would serve any file the
 * process can read.
 *
 * Cache generation is not wired up yet. On cache miss, serve the original file.
 */
catalogRoutes.get('/images/catalog/:image_key/thumbnail', (c) => {
  const imageKey = c.req.param('image_key');
  {
    const db = c.get('libraryDb');
    const image = getImage(db, imageKey);
    if (!image) return errorNotFound(c, 'image');

    const allowed = catalogThumbnailRoots();

    const cached = getVisionCachedImage(db, imageKey);
    if (cached?.compressed_path && existsSync(cached.compressed_path)) {
      if (!isPathUnderAllowedRoots(cached.compressed_path, allowed)) {
        return errorNotFound(c, 'file');
      }
      return sendFile(c, cached.compressed_path, { mimetype: 'image/jpeg' });
    }

    const filepath = resolveCatalogPath(String(image.filepath ?? ''));
    if (!filepath || !existsSync(filepath)) return errorNotFound(c, 'file');
    if (!isPathUnderAllowedRoots(filepath, allowed)) return errorNotFound(c, 'file');

    // Declared mimetype is `image/jpeg` even for RAW originals; the browser sniffs content.
    return sendFile(c, filepath, { mimetype: 'image/jpeg' });
  }
});

// --- months -----------------------------------------------------------------

const monthsRoute = createRoute({
  method: 'get',
  path: '/images/catalog/months',
  tags: ['images-catalog'],
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(CatalogMonthsResponse) },
  }),
});

catalogRoutes.openapi(monthsRoute, (c) =>
  c.json({ months: getCatalogMonths(c.get('libraryDb')) }, 200),
);

// --- list -------------------------------------------------------------------

/** The list handler, shared by the slashed and unslashed paths. */
function listCatalogImages(c: Parameters<Parameters<typeof catalogRoutes.openapi>[1]>[0]) {
  const db = c.get('libraryDb');
  const parsed = parseCatalogListParams({
    query: (n: string) => c.req.query(n),
    queries: (n: string) => c.req.queries(n),
  });
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { filters, scorePerspectiveRaw, sortByScore, sortByDate, limitRaw, offsetRaw } =
    parsed.value;

  const sp = validateScorePerspectiveExists(db, scorePerspectiveRaw || null);
  if (sp.error) return c.json({ error: sp.error }, 400);

  // These two rules are checked against the *validated* slug, so an unknown
  // perspective reports the unknown-perspective error rather than this one.
  if (sortByScore && !sp.slug) {
    return c.json({ error: 'sort_by_score requires score_perspective' }, 400);
  }
  if (filters.minScore !== null && filters.minScore !== undefined && !sp.slug) {
    return c.json({ error: 'min_score requires score_perspective' }, 400);
  }

  const { limit, offset } = clampPagination(limitRaw, offsetRaw);

  try {
    const { rows, total } = queryCatalogImages(db, {
      ...filters,
      scorePerspective: sp.slug,
      sortByScore,
      sortByDate,
      limit,
      offset,
    });
    const manualKeys = batchCullManuallySent(
      db,
      rows.map((r) => String(r.key)),
    );
    const images = rowsToCatalogApiImages(rows).map((img) => ({
      ...img,
      cull_manually_sent: manualKeys.has(img.key),
    }));
    return c.json({ total, images }, 200);
  } catch (e) {
    // Only the caller-error case is caught; anything else reaches the app's 500
    // handler with its message intact.
    if (e instanceof CatalogQueryError) return c.json({ error: e.message }, 400);
    throw e;
  }
}

const listResponses = withValidationError({
  200: { description: 'OK', content: jsonBody(CatalogListResponse) },
  400: { description: 'Bad Request', content: jsonBody(ErrorBody) },
});

// Both forms are in the contract; neither is a redirect to the other.
const listSlashRoute = createRoute({
  method: 'get',
  path: '/images/catalog/',
  tags: ['images-catalog'],
  responses: listResponses,
});
const listBareRoute = createRoute({
  method: 'get',
  path: '/images/catalog',
  tags: ['images-catalog'],
  responses: listResponses,
});

catalogRoutes.openapi(listSlashRoute, listCatalogImages);
catalogRoutes.openapi(listBareRoute, listCatalogImages);

// --- visual similarity ------------------------------------------------------

const similarRoute = createRoute({
  method: 'get',
  path: '/images/catalog/{image_key}/similar',
  tags: ['images-catalog'],
  request: { params: imageKeyParams },
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(CatalogSimilarResponse) },
    400: { description: 'Bad Request', content: jsonBody(ErrorBody) },
    404: { description: 'Not Found', content: jsonBody(ErrorBody) },
  }),
});

catalogRoutes.openapi(similarRoute, (c) => {
  const imageKey = c.req.valid('param').image_key;
  const db = c.get('libraryDb');
  {
    if (getImage(db, imageKey) === null) return c.json({ error: ERROR_IMAGE_NOT_FOUND }, 404);

    const parsed = parseCatalogSimilarParams({
      query: (n: string) => c.req.query(n),
      queries: (n: string) => c.req.queries(n),
    });
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const { filters, scorePerspectiveRaw, limitRaw, offsetRaw } = parsed.value;

    const sp = validateScorePerspectiveExists(db, scorePerspectiveRaw || null);
    if (sp.error) return c.json({ error: sp.error }, 400);
    if (filters.minScore !== null && filters.minScore !== undefined && !sp.slug) {
      return c.json({ error: 'min_score requires score_perspective' }, 400);
    }

    const { limit, offset } = clampPagination(limitRaw, offsetRaw);

    // Fetch the whole filtered neighbour set, then page in memory: `total` is the
    // count of everything that matched, which a SQL-paged query could not report.
    let result;
    try {
      result = runClipSimilarForSeed(db, imageKey, {
        ...filters,
        scorePerspective: sp.slug,
        limit: 500,
        offset: 0,
      });
    } catch (err) {
      if (err instanceof NoClipEmbeddingError) {
        return c.json({ error: 'Visual similarity is unavailable' }, 404);
      }
      if (err instanceof CatalogQueryError) return c.json({ error: err.message }, 400);
      throw err;
    }

    const total = result.pairs.length;
    const pagePairs = result.pairs.slice(offset, offset + limit);
    if (pagePairs.length === 0) {
      return c.json({ images: [], total, meta: result.meta }, 200);
    }

    const keys = pagePairs.map(([k]) => k);
    const images = rowsToCatalogApiImages(
      queryCatalogImagesByKeys(db, keys, { scorePerspective: sp.slug }),
    );
    const distByKey = new Map(pagePairs);
    for (const img of images) {
      const d = distByKey.get(String(img.key)) ?? 0;
      const sim = Math.max(0, Math.min(1, 1 - d));
      img.similarity = sim;
      img.why_matched = clipSimilarityWhyMatchedLine(sim);
      img.thumbnail_url = catalogThumbnailUrl(String(img.key));
    }

    return c.json({ images, total, meta: result.meta }, 200);
  }
});

// --- similarity groups ------------------------------------------------------

/**
 * Registered at `/api/images/catalog-similarity-groups`, a sibling of the catalog
 * routes rather than a child — the path is part of the contract.
 */
const similarityGroupsRoute = createRoute({
  method: 'get',
  path: '/images/catalog-similarity-groups',
  tags: ['images-catalog'],
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(CatalogSimilarityGroupsResponse) },
  }),
});

catalogRoutes.openapi(similarityGroupsRoute, (c) => {
  const db = c.get('libraryDb');
  {
    // Note the default of 20, not the 50 the catalog list uses.
    const { limit, offset } = clampPagination(c.req.query('limit'), c.req.query('offset'), 20);
    const { rows: groups, total } = getCatalogSimilarityGroupsPaginated(db, { limit, offset });

    const items = [];
    for (const group of groups) {
      const seedKey = String(group.seed_key);
      const seedImages = rowsToCatalogApiImages(queryCatalogImagesByKeys(db, [seedKey]));
      // A seed that is now a non-representative stack member is filtered out by the
      // primary-grid collapse, which drops the whole group rather than showing a
      // group with no seed.
      if (seedImages.length === 0) continue;

      const candidateRows = getSimilarityCandidatesForGroup(db, Math.trunc(group.group_id));
      const candidates = rowsToCatalogApiImages(
        queryCatalogImagesByKeys(
          db,
          candidateRows.map((r) => String(r.candidate_key)),
        ),
      );
      const byKey = new Map(candidates.map((img) => [String(img.key), img]));

      // Re-ordered by the stored rank, not by whatever the row query returned.
      const orderedCandidates: CatalogImage[] = [];
      for (const row of candidateRows) {
        const img = byKey.get(String(row.candidate_key));
        if (!img) continue;
        const sim = Number(row.similarity ?? 0);
        img.similarity = sim;
        img.why_matched = row.why_matched || clipSimilarityWhyMatchedLine(sim);
        img.thumbnail_url = catalogThumbnailUrl(String(img.key));
        orderedCandidates.push(img);
      }

      const seed = seedImages[0]!;
      seed.thumbnail_url = catalogThumbnailUrl(String(seed.key));
      items.push({
        group_id: Math.trunc(group.group_id),
        seed,
        candidates: orderedCandidates,
        // The stored count wins when non-zero; a zero falls back to what survived
        // the primary-grid filter.
        candidate_count: Math.trunc(group.candidate_count || orderedCandidates.length),
        best_similarity: Number(group.best_similarity ?? 0),
        job_id: group.job_id,
        created_at: group.created_at,
      });
    }

    return c.json({ items, total }, 200);
  }
});

// --- instagram-posted (write) -----------------------------------------------

const instagramPostedRoute = createRoute({
  method: 'patch',
  path: '/images/catalog/{image_key}/instagram-posted',
  tags: ['images-catalog'],
  request: { params: imageKeyParams, body: { content: jsonBody(InstagramPostedRequest) } },
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(InstagramPostedResponse) },
    400: { description: 'Bad Request', content: jsonBody(ErrorBody) },
    404: { description: 'Not Found', content: jsonBody(ErrorBody) },
  }),
});

catalogRoutes.openapi(instagramPostedRoute, (c) => {
  const imageKey = c.req.valid('param').image_key;
  const db = c.get('libraryDb');

  // The schema requires `posted` as boolean; non-boolean input is 422 before here.
  // The 400 remains declared because the contract lists it.
  const posted = c.req.valid('json').posted;

  if (!getImage(db, imageKey)) return c.json({ error: ERROR_IMAGE_NOT_FOUND }, 404);

  libraryWrite(db, () => setInstagramPosted(db, imageKey, posted));

  // Echoes the request value, not a re-read. `setInstagramPosted` reporting no
  // rows changed is not treated as a failure — writing the value it already had is
  // a successful no-op.
  return c.json({ key: imageKey, instagram_posted: posted }, 200);
});

// --- detail -----------------------------------------------------------------

/**
 * Registered last so `/months` and `/catalog-similarity-groups` are matched by
 * their own routes rather than being swallowed as an image key.
 */
const detailRoute = createRoute({
  method: 'get',
  path: '/images/catalog/{image_key}',
  tags: ['images-catalog'],
  request: { params: imageKeyParams },
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(ImageView) },
    400: { description: 'Bad Request', content: jsonBody(ErrorBody) },
    404: { description: 'Not Found', content: jsonBody(ErrorBody) },
  }),
});

catalogRoutes.openapi(detailRoute, (c) => {
  const imageKey = c.req.valid('param').image_key;
  const db = c.get('libraryDb');

  // Validated before the try block: a bad perspective is 400 even though unused below.
  const sp = validateScorePerspectiveExists(db, c.req.query('score_perspective') ?? null);
  if (sp.error) return c.json({ error: sp.error }, 400);

  {
    const row = getImage(db, imageKey);
    if (!row) return c.json({ error: ERROR_IMAGE_NOT_FOUND }, 404);

    const out: Row = { ...row, image_type: 'catalog' };

    const descRow = getImageDescription(db, imageKey);
    if (descRow && descRow.image_type === 'catalog') {
      out.ai_analyzed = true;
      out.description_summary = descRow.summary || '';
      out.description_best_perspective = descRow.best_perspective || '';
    } else {
      out.ai_analyzed = false;
      out.description_summary = null;
      out.description_best_perspective = null;
    }

    const identity = computeSingleImageAggregateScores(db, imageKey);
    if (identity !== null) {
      out.identity_aggregate_score = identity.aggregate_score;
      out.identity_perspectives_covered = identity.perspectives_covered;
      out.identity_eligible = identity.eligible;
      out.identity_per_perspective = identity.per_perspective;
    } else {
      out.identity_aggregate_score = null;
      out.identity_perspectives_covered = 0;
      out.identity_eligible = false;
      out.identity_per_perspective = [];
    }

    const scoreRows = getCurrentScoresForImage(db, imageKey, 'catalog');
    const [bestScore, bestSlug] = getBestCurrentCatalogScore(db, imageKey);
    out.catalog_perspective_score = bestScore;
    out.catalog_score_perspective = bestSlug;
    out.available_score_perspectives = scoreRows.map((r) => String(r.perspective_slug));

    const rid = out.id;
    const ridStr = rid === null || rid === undefined ? '' : String(rid).trim();
    out.id = /^[0-9]+$/.test(ridStr) ? Number.parseInt(ridStr, 10) : null;

    Object.assign(out, catalogImageStackRowFields(db, imageKey));

    return c.json(out as z.infer<typeof ImageView>, 200);
  }
});

// --- frame substance --------------------------------------------------------

// Registered last, after the `/{image_key}` catch-all, so route order in the
// emitted document is stable. The paths are all deeper than one segment anyway.
registerFrameSubstanceRoutes(catalogRoutes);
