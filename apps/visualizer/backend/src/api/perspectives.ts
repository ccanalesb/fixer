/**
 * REST API for the library `perspectives` registry.
 *
 * List responses expose `id`, `slug`, `display_name`, `description`, `active`,
 * `optional`, `source_filename`, `updated_at` — no `prompt_markdown` on the list.
 * `optional` is read-only: it is derived from the markdown marker on write
 * (ADR-0012), never accepted from a body.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resourcesRoot } from '../config.js';
import { isResolvedPathInsideDir } from '../utils/path-containment.js';
import {
  deletePerspective,
  getPerspectiveBySlug,
  insertPerspective,
  listPerspectives,
  updatePerspective,
  type PerspectiveRow,
} from '../db/library/scores.js';
import { libraryDb, type LibraryEnv } from './library-db.js';
import { isValidPerspectiveSlug } from '../utils/perspective-slug.js';
import { createOpenApiApp } from './openapi.js';
import { jsonBody, redirectToTrailingSlash, withValidationError } from './route-helpers.js';
import { ErrorBody } from './schemas/errors.js';
import {
  PerspectiveDetail,
  PerspectiveListResponse,
  PerspectiveSummary,
} from './schemas/perspectives.js';

export const perspectivesRoutes = createOpenApiApp<LibraryEnv>();

// This group writes (create/update/delete/reset), so the connection is writable.
perspectivesRoutes.use('/perspectives/*', libraryDb({ write: true }));

// Bare form redirects with 308 rather than 404ing.
redirectToTrailingSlash(perspectivesRoutes, '/perspectives');

/**
 * Route paths include the `/perspectives` prefix because the canonical URL is
 * `/api/perspectives/` with a trailing slash — mounting at `/api/perspectives` with
 * a bare `'/'` child would collapse to `/api/perspectives` without it.
 */

const SOURCE_FILENAME_RE = /^[a-zA-Z0-9_-]+\.md$/;
const MAX_PROMPT_MARKDOWN_BYTES = 256 * 1024;

function promptTooLarge(promptMarkdown: string): boolean {
  return Buffer.byteLength(promptMarkdown, 'utf8') > MAX_PROMPT_MARKDOWN_BYTES;
}

function rowListItem(row: PerspectiveRow): z.infer<typeof PerspectiveSummary> {
  return {
    id: row.id,
    slug: row.slug,
    display_name: row.display_name,
    description: row.description,
    active: Boolean(row.active),
    optional: Boolean(row.optional),
    source_filename: row.source_filename,
    updated_at: row.updated_at,
  };
}

function rowDetail(row: PerspectiveRow): z.infer<typeof PerspectiveDetail> {
  return {
    ...rowListItem(row),
    prompt_markdown: row.prompt_markdown,
    created_at: row.created_at,
  };
}

// --- list -------------------------------------------------------------------

const listRoute = createRoute({
  method: 'get',
  path: '/perspectives/',
  tags: ['perspectives'],
  responses: withValidationError({
    200: { description: 'Perspectives', content: jsonBody(PerspectiveListResponse) },
  }),
});

perspectivesRoutes.openapi(listRoute, (c) => {
  const activeOnly = (c.req.query('active_only') ?? '').toLowerCase() === 'true';
  const rows = listPerspectives(c.get('libraryDb'), { activeOnly });
  return c.json(rows.map(rowListItem), 200);
});

// --- detail -----------------------------------------------------------------

const detailRoute = createRoute({
  method: 'get',
  path: '/perspectives/{slug}',
  tags: ['perspectives'],
  request: { params: z.object({ slug: z.string() }) },
  responses: withValidationError({
    200: { description: 'One perspective', content: jsonBody(PerspectiveDetail) },
    404: { description: 'Not found', content: jsonBody(ErrorBody) },
  }),
});

perspectivesRoutes.openapi(detailRoute, (c) => {
  const row = getPerspectiveBySlug(c.get('libraryDb'), c.req.valid('param').slug);
  if (!row) return c.json({ error: 'resource not found' }, 404);
  return c.json(rowDetail(row), 200);
});

// --- create -----------------------------------------------------------------

const createPerspectiveRoute = createRoute({
  method: 'post',
  path: '/perspectives/',
  tags: ['perspectives'],
  responses: withValidationError({
    201: { description: 'Created', content: jsonBody(PerspectiveDetail) },
    400: { description: 'Invalid request', content: jsonBody(ErrorBody) },
  }),
});

/**
 * Body validation is hand-rolled to preserve the exact error strings the frontend
 * and contract tests assert on.
 */
perspectivesRoutes.openapi(createPerspectiveRoute, async (c) => {
  let data: unknown;
  try {
    data = await c.req.json();
  } catch {
    data = null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return c.json({ error: 'JSON body required' }, 400);
  }
  const body = data as Record<string, unknown>;

  const { slug, display_name: displayName, prompt_markdown: promptMarkdown } = body;
  if (
    typeof slug !== 'string' ||
    typeof displayName !== 'string' ||
    typeof promptMarkdown !== 'string'
  ) {
    return c.json(
      { error: 'slug, display_name, and prompt_markdown are required strings' },
      400,
    );
  }
  if (!isValidPerspectiveSlug(slug)) return c.json({ error: 'invalid slug' }, 400);
  if (promptTooLarge(promptMarkdown)) return c.json({ error: 'prompt too large' }, 400);

  const rawDescription = 'description' in body ? body.description : '';
  if (rawDescription != null && typeof rawDescription !== 'string') {
    return c.json({ error: 'description must be a string' }, 400);
  }
  const description = (rawDescription as string | null) || '';

  const active = 'active' in body ? body.active : true;
  if (typeof active !== 'boolean') return c.json({ error: 'active must be a boolean' }, 400);

  const db = c.get('libraryDb');
  if (getPerspectiveBySlug(db, slug)) return c.json({ error: 'slug already exists' }, 400);

  try {
    insertPerspective(db, {
      slug,
      displayName,
      promptMarkdown,
      description,
      active,
      sourceFilename: null,
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }

  const created = getPerspectiveBySlug(db, slug);
  // Thrown, not returned: the OpenAPI contract documents no 500 for this route.
  // Read-after-write on the connection that just wrote the row.
  if (!created) throw new Error('perspective vanished after insert');
  return c.json(rowDetail(created), 201);
});

// --- update -----------------------------------------------------------------

const updateRoute = createRoute({
  method: 'put',
  path: '/perspectives/{slug}',
  tags: ['perspectives'],
  request: { params: z.object({ slug: z.string() }) },
  responses: withValidationError({
    200: { description: 'Updated', content: jsonBody(PerspectiveDetail) },
    400: { description: 'Invalid request', content: jsonBody(ErrorBody) },
    404: { description: 'Not found', content: jsonBody(ErrorBody) },
  }),
});

perspectivesRoutes.openapi(updateRoute, async (c) => {
  const slug = c.req.valid('param').slug;
  const db = c.get('libraryDb');
  if (!getPerspectiveBySlug(db, slug)) return c.json({ error: 'resource not found' }, 404);

  let data: unknown;
  try {
    data = await c.req.json();
  } catch {
    data = null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return c.json({ error: 'JSON body required' }, 400);
  }
  const body = data as Record<string, unknown>;

  // Absent field means "leave alone", not falsy.
  const displayName = 'display_name' in body ? body.display_name : null;
  const description = 'description' in body ? body.description : null;
  const promptMarkdown = 'prompt_markdown' in body ? body.prompt_markdown : null;
  const active = 'active' in body ? body.active : null;

  if (displayName == null && description == null && promptMarkdown == null && active == null) {
    return c.json({ error: 'at least one field required' }, 400);
  }
  if (displayName != null && typeof displayName !== 'string') {
    return c.json({ error: 'display_name must be a string' }, 400);
  }
  if (description != null && typeof description !== 'string') {
    return c.json({ error: 'description must be a string' }, 400);
  }
  if (promptMarkdown != null) {
    if (typeof promptMarkdown !== 'string') {
      return c.json({ error: 'prompt_markdown must be a string' }, 400);
    }
    if (promptTooLarge(promptMarkdown)) return c.json({ error: 'prompt too large' }, 400);
  }
  if (active != null && typeof active !== 'boolean') {
    return c.json({ error: 'active must be a boolean' }, 400);
  }

  const updated = updatePerspective(db, slug, {
    displayName: displayName as string | null,
    description: description as string | null,
    promptMarkdown: promptMarkdown as string | null,
    active: active as boolean | null,
  });
  if (!updated) return c.json({ error: 'no valid fields to update' }, 400);

  const row = getPerspectiveBySlug(db, slug);
  if (!row) throw new Error('perspective vanished after update');
  return c.json(rowDetail(row), 200);
});

// --- delete -----------------------------------------------------------------

const deleteRoute = createRoute({
  method: 'delete',
  path: '/perspectives/{slug}',
  tags: ['perspectives'],
  request: { params: z.object({ slug: z.string() }) },
  responses: withValidationError({
    204: { description: 'Deleted' },
    404: { description: 'Not found', content: jsonBody(ErrorBody) },
  }),
});

perspectivesRoutes.openapi(deleteRoute, (c) => {
  if (!deletePerspective(c.get('libraryDb'), c.req.valid('param').slug)) {
    return c.json({ error: 'resource not found' }, 404);
  }
  return c.body(null, 204);
});

// --- reset to default -------------------------------------------------------

const resetRoute = createRoute({
  method: 'post',
  path: '/perspectives/{slug}/reset-default',
  tags: ['perspectives'],
  request: { params: z.object({ slug: z.string() }) },
  responses: withValidationError({
    200: { description: 'Reset to the on-disk default', content: jsonBody(PerspectiveDetail) },
    400: { description: 'Invalid request', content: jsonBody(ErrorBody) },
    404: { description: 'Not found', content: jsonBody(ErrorBody) },
  }),
});

perspectivesRoutes.openapi(resetRoute, (c) => {
  const slug = c.req.valid('param').slug;
  const db = c.get('libraryDb');
  const row = getPerspectiveBySlug(db, slug);
  if (!row) return c.json({ error: 'resource not found' }, 404);

  const sourceFilename = row.source_filename;
  let filename: string;
  if (sourceFilename) {
    if (!SOURCE_FILENAME_RE.test(sourceFilename)) {
      return c.json({ error: 'invalid source_filename' }, 400);
    }
    filename = sourceFilename;
  } else {
    filename = `${slug}.md`;
  }

  // Containment check before reading: `source_filename` comes from the database,
  // and the regex above is the only thing standing between it and an arbitrary
  // read. Resolve and confirm the result is still inside the prompts directory.
  const base = resolve(join(resourcesRoot(), 'prompts', 'perspectives'));
  const filePath = resolve(join(base, filename));
  if (!isResolvedPathInsideDir(base, filePath)) {
    return c.json({ error: 'invalid source_filename' }, 400);
  }

  try {
    if (!statSync(filePath).isFile()) return c.json({ error: 'no default file' }, 404);
  } catch {
    return c.json({ error: 'no default file' }, 404);
  }

  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }

  if (promptTooLarge(text)) return c.json({ error: 'prompt too large' }, 400);

  updatePerspective(db, slug, { promptMarkdown: text });
  const refreshed = getPerspectiveBySlug(db, slug);
  if (!refreshed) throw new Error('perspective vanished after reset');
  return c.json(rowDetail(refreshed), 200);
});
