/**
 * Image description routes.
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
  getAllImagesWithDescriptions,
  getImageDescription,
} from '../db/library/descriptions.js';
import { libraryDb, type LibraryEnv } from './library-db.js';
import {
  AuthenticationError,
  ModelUnavailableError,
  ProviderConnectionError,
  RateLimitError,
} from '../providers/errors.js';
import { UnknownProviderError } from '../providers/registry.js';
import { HttpError } from '../utils/responses.js';
import { describeMatchedImage } from '../vision/description-service.js';
import { createOpenApiApp } from './openapi.js';
import { jsonBody, redirectToTrailingSlash, withValidationError } from './route-helpers.js';
import { ErrorBody } from './schemas/errors.js';
import {
  DescriptionGenerateRequest,
  DescriptionGenerateResponse,
  DescriptionGetResponse,
  DescriptionProviderError,
  DescriptionsListResponse,
  ImageDescription,
} from './schemas/descriptions.js';

export const descriptionsRoutes = createOpenApiApp<LibraryEnv>();

// Only `POST /{image_key}/generate` writes; the two list/detail reads stay read-only.
descriptionsRoutes.use('/descriptions/*', libraryDb({ writeForMethods: ['POST'] }));
redirectToTrailingSlash(descriptionsRoutes, '/descriptions');

/**
 * `limit`/`offset` use loose int parsing: an unparseable value falls back to the
 * default rather than erroring. Unlike the shared pagination helper, no bounds are
 * imposed here.
 */
function intArg(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) ? n : fallback;
}

const listRoute = createRoute({
  method: 'get',
  path: '/descriptions/',
  tags: ['descriptions'],
  responses: withValidationError({
    200: { description: 'Images with descriptions', content: jsonBody(DescriptionsListResponse) },
  }),
});

descriptionsRoutes.openapi(listRoute, (c) => {
  const imageType = c.req.query('image_type');
  // Catalog-only; anything else is a client error, not empty results.
  // Thrown rather than returned: the OpenAPI contract documents only 200 and 422.
  // See `HttpError`.
  if (imageType !== undefined && imageType !== '' && imageType !== 'catalog') {
    throw new HttpError(400, `Invalid image_type: ${imageType}`);
  }

  const describedOnly = c.req.query('described_only') === 'true';
  const limit = intArg(c.req.query('limit'), 50);
  const offset = intArg(c.req.query('offset'), 0);

  const { items, total } = getAllImagesWithDescriptions(c.get('libraryDb'), {
    describedOnly,
    limit,
    offset,
  });

  return c.json(
    {
      total,
      items,
      pagination: {
        offset,
        limit,
        current_page: Math.floor(offset / limit) + 1,
        // Empty result yields 0 pages, not 1.
        total_pages: total ? Math.floor((total + limit - 1) / limit) : 0,
        has_more: offset + limit < total,
      },
    },
    200,
  );
});

const detailRoute = createRoute({
  method: 'get',
  path: '/descriptions/{image_key}',
  tags: ['descriptions'],
  request: { params: z.object({ image_key: z.string() }) },
  responses: withValidationError({
    200: { description: 'One description, or null', content: jsonBody(DescriptionGetResponse) },
  }),
});

descriptionsRoutes.openapi(detailRoute, (c) => {
  // A missing description is `{"description": null}` with a 200, not a 404 —
  // the UI renders an empty panel rather than treating it as an error.
  const desc = getImageDescription(c.get('libraryDb'), c.req.valid('param').image_key);
  return c.json({ description: desc as z.infer<typeof DescriptionGetResponse>['description'] }, 200);
});

type GenerateDescription = z.infer<typeof ImageDescription> | null;

const generateRoute = createRoute({
  method: 'post',
  path: '/descriptions/{image_key}/generate',
  tags: ['descriptions'],
  summary: 'Generate AI description for a single image.',
  request: {
    params: z.object({ image_key: z.string() }),
    body: { required: true, content: jsonBody(DescriptionGenerateRequest) },
  },
  responses: withValidationError({
    200: { description: 'OK', content: jsonBody(DescriptionGenerateResponse) },
    400: { description: 'Bad Request', content: jsonBody(ErrorBody) },
    401: { description: 'Unauthorized', content: jsonBody(DescriptionProviderError) },
    429: { description: 'Too Many Requests', content: jsonBody(DescriptionProviderError) },
    503: { description: 'Service Unavailable', content: jsonBody(DescriptionProviderError) },
  }),
});

descriptionsRoutes.openapi(generateRoute, async (c) => {
  const db = c.get('libraryDb');
  const imageKey = c.req.valid('param').image_key;
  const body = c.req.valid('json');
  const providerId = body.provider_id ?? null;

  // Catalog-only. Validated here rather than as a Zod enum so bad values
  // return 400, not 422.
  if (body.image_type !== '' && body.image_type !== 'catalog') {
    return c.json({ error: `Invalid image_type: ${body.image_type}` }, 400);
  }

  // The model is passed as an argument instead of via env var to avoid races between
  // concurrent requests. `provider_model` wins over `model`; bare `model` is ignored
  // when an explicit `provider_id` is given.
  const model = body.provider_model ?? (providerId ? null : body.model ?? null);

  const respond = (generated: boolean, desc: unknown) =>
    c.json({ generated, description: (desc ?? null) as GenerateDescription }, 200);

  try {
    const outcome = await describeMatchedImage(db, imageKey, {
      force: body.force,
      providerId,
      model,
    });

    // A skipped or failed outcome still returns whatever description already
    // exists, so the UI can show the old text instead of blanking the panel.
    if (!outcome.wrote) return respond(false, getImageDescription(db, imageKey));
    return respond(true, getImageDescription(db, imageKey));
  } catch (e) {
    // Without `provider_id`, an unknown provider from config is a server fault (500).
    if (e instanceof UnknownProviderError) {
      if (!providerId) throw e;
      return c.json(
        { error: 'invalid_provider', message: `Unknown provider: ${providerId}` },
        400,
      );
    }
    // `provider` falls back to the requested id: the exception often lacks it
    // when the failure happened before any provider was contacted, and the UI
    // needs to name the provider it asked for.
    if (e instanceof RateLimitError) {
      return c.json(
        { error: 'rate_limit', message: e.message, provider: e.provider ?? providerId },
        429,
      );
    }
    if (e instanceof AuthenticationError) {
      return c.json(
        { error: 'auth_error', message: e.message, provider: e.provider ?? providerId },
        401,
      );
    }
    if (e instanceof ModelUnavailableError || e instanceof ProviderConnectionError) {
      return c.json(
        { error: 'provider_unavailable', message: e.message, provider: e.provider ?? providerId },
        503,
      );
    }
    // Unhandled provider errors become 500 via `app.onError`.
    throw e;
  }
});
