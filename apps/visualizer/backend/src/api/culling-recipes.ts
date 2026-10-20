/**
 * Culling recipes and pipeline setting API.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { config } from '../config.js';
import { validateRecipeDefinitionForLaya } from '../cull/recipe-validate.js';
import { createPipelineSettingVersion, getCurrentPipelineSetting } from '../db/library/cull-pipeline.js';
import {
  countCatalogPhotosForCullEstimate,
  defaultMinimalRecipeDefinition,
  defaultMinimalRecipeRule,
  duplicateCullRecipe,
  saveRecipeDefinition,
  setCullRecipePipelineActive,
  updateCullRecipeMeta,
} from '../db/library/cull-recipes-mutations.js';
import { createCullRecipe, getCullRecipe, listCullRecipes, setRecipeRule } from '../db/library/cull-recipes.js';
import { initJobsDb, createJob, getJob } from '../db/jobs/jobs.js';
import { BATCH_CULL_JOB_TYPE } from '../jobs/handlers/cull.js';
import { enqueueRedecideCullVerdicts } from '../jobs/handlers/redecide.js';
import { isValidPerspectiveSlug } from '../utils/perspective-slug.js';
import { emitJobEvent } from '../websocket/events.js';
import { libraryDb, type LibraryEnv } from './library-db.js';
import { createOpenApiApp } from './openapi.js';
import { jsonBody, redirectToTrailingSlash, withValidationError } from './route-helpers.js';
import { ErrorBody } from './schemas/errors.js';
import {
  CullRecipeDetail,
  CullRecipeListResponse,
  PipelineSettingResponse,
  RecipeDefinitionSchema,
  RecipeRuleSchema,
  ScoreForecastSettingSchema,
} from './schemas/culling-recipes.js';
import { compactJobPayload } from './schemas/jobs.js';

export const cullingRecipesRoutes = createOpenApiApp<LibraryEnv>();

cullingRecipesRoutes.use('/culling-recipes/*', libraryDb({ write: true }));
redirectToTrailingSlash(cullingRecipesRoutes, '/culling-recipes');

function withJobsDb<T>(fn: (db: import('../db/connection.js').Db) => T): T {
  const db = initJobsDb(config.VISUALIZER_DB);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function recipeSummary(db: import('../db/connection.js').Db, recipe: ReturnType<typeof getCullRecipe>) {
  if (!recipe) throw new Error('missing recipe');
  const pipe = getCurrentPipelineSetting(db);
  const idx = pipe.config.culling_recipes.findIndex((r) => r.recipe_slug === recipe.slug);
  return {
    slug: recipe.slug,
    name: recipe.name,
    model: recipe.model,
    active: recipe.active,
    measured: recipe.measured,
    version: recipe.version,
    in_pipeline: idx >= 0,
    pipeline_order: idx >= 0 ? idx : null,
  };
}

function recipeDetail(db: import('../db/connection.js').Db, slug: string) {
  const recipe = getCullRecipe(db, slug);
  if (!recipe) return null;
  return {
    ...recipeSummary(db, recipe),
    definition: recipe.definition,
    rule: recipe.rule,
  };
}

const listRoute = createRoute({
  method: 'get',
  path: '/culling-recipes/',
  tags: ['culling-recipes'],
  responses: withValidationError({
    200: { description: 'All culling recipes', content: jsonBody(CullRecipeListResponse) },
  }),
});

cullingRecipesRoutes.openapi(listRoute, (c) => {
  const db = c.get('libraryDb');
  const recipes = listCullRecipes(db).map((r) => recipeSummary(db, r));
  return c.json({ recipes }, 200);
});

const detailRoute = createRoute({
  method: 'get',
  path: '/culling-recipes/{slug}',
  tags: ['culling-recipes'],
  request: { params: z.object({ slug: z.string() }) },
  responses: withValidationError({
    200: { description: 'One recipe', content: jsonBody(CullRecipeDetail) },
    404: { description: 'Not found', content: jsonBody(ErrorBody) },
  }),
});

cullingRecipesRoutes.openapi(detailRoute, (c) => {
  const db = c.get('libraryDb');
  const detail = recipeDetail(db, c.req.param('slug'));
  if (!detail) return c.json({ error: 'resource not found' }, 404);
  return c.json(detail, 200);
});

const createRouteDef = createRoute({
  method: 'post',
  path: '/culling-recipes/',
  tags: ['culling-recipes'],
  request: {
    body: {
      content: jsonBody(
        z
          .object({
            slug: z.string(),
            name: z.string(),
            model: z.string(),
            definition: RecipeDefinitionSchema,
            rule: RecipeRuleSchema,
            active: z.boolean().optional(),
          })
          .strict(),
      ),
    },
  },
  responses: withValidationError({
    201: { description: 'Created', content: jsonBody(CullRecipeDetail) },
    400: { description: 'Validation failed', content: jsonBody(ErrorBody) },
    409: { description: 'Duplicate slug', content: jsonBody(ErrorBody) },
  }),
});

cullingRecipesRoutes.openapi(createRouteDef, (c) => {
  const db = c.get('libraryDb');
  const body = c.req.valid('json');
  if (!isValidPerspectiveSlug(body.slug)) return c.json({ error: 'invalid slug' }, 400);
  if (getCullRecipe(db, body.slug)) return c.json({ error: 'slug already exists' }, 409);
  const v = validateRecipeDefinitionForLaya(body.definition, body.model);
  if (!v.ok) return c.json({ error: v.errors.map((e) => e.message).join('; ') }, 400);
  createCullRecipe(db, { ...body, measured: false, active: body.active !== false });
  if (body.active !== false) setCullRecipePipelineActive(db, body.slug, true);
  const detail = recipeDetail(db, body.slug)!;
  return c.json(detail, 201);
});

const duplicateRoute = createRoute({
  method: 'post',
  path: '/culling-recipes/{slug}/duplicate',
  tags: ['culling-recipes'],
  request: {
    params: z.object({ slug: z.string() }),
    body: { content: jsonBody(z.object({ new_slug: z.string(), new_name: z.string().optional() }).strict()) },
  },
  responses: withValidationError({
    201: { description: 'Duplicated', content: jsonBody(CullRecipeDetail) },
    404: { description: 'Not found', content: jsonBody(ErrorBody) },
    409: { description: 'Duplicate slug', content: jsonBody(ErrorBody) },
  }),
});

cullingRecipesRoutes.openapi(duplicateRoute, (c) => {
  const db = c.get('libraryDb');
  const slug = c.req.param('slug');
  const { new_slug, new_name } = c.req.valid('json');
  if (!getCullRecipe(db, slug)) return c.json({ error: 'resource not found' }, 404);
  if (getCullRecipe(db, new_slug)) return c.json({ error: 'slug already exists' }, 409);
  duplicateCullRecipe(db, slug, new_slug, new_name);
  return c.json(recipeDetail(db, new_slug)!, 201);
});

const definitionRoute = createRoute({
  method: 'put',
  path: '/culling-recipes/{slug}/definition',
  tags: ['culling-recipes'],
  request: {
    params: z.object({ slug: z.string() }),
    body: {
      content: jsonBody(
        z
          .object({
            definition: RecipeDefinitionSchema,
            mode: z.enum(['save_only', 'save_and_queue_cull']),
          })
          .strict(),
      ),
    },
  },
  responses: withValidationError({
    200: {
      description: 'Saved',
      content: jsonBody(
        z.object({
          recipe: CullRecipeDetail,
          version: z.number().int(),
          created: z.boolean(),
          impact: z.object({ photos: z.number().int(), hours_estimate: z.number() }).optional(),
        }),
      ),
    },
    404: { description: 'Not found', content: jsonBody(ErrorBody) },
    400: { description: 'Validation failed', content: jsonBody(ErrorBody) },
  }),
});

cullingRecipesRoutes.openapi(definitionRoute, (c) => {
  const db = c.get('libraryDb');
  const slug = c.req.param('slug');
  const recipe = getCullRecipe(db, slug);
  if (!recipe) return c.json({ error: 'resource not found' }, 404);
  const { definition, mode } = c.req.valid('json');
  const v = validateRecipeDefinitionForLaya(definition, recipe.model);
  if (!v.ok) return c.json({ error: v.errors.map((e) => e.message).join('; ') }, 400);
  const saved = saveRecipeDefinition(db, slug, definition);
  const photos = countCatalogPhotosForCullEstimate(db);
  const hours_estimate = (photos * 2) / 3600;
  let jobId: string | null = null;
  if (mode === 'save_and_queue_cull') {
    jobId = withJobsDb((jobsDb) => {
      const id = createJob(jobsDb, BATCH_CULL_JOB_TYPE, {});
      const job = getJob(jobsDb, id);
      if (job) emitJobEvent('job_created', compactJobPayload(job as unknown as Record<string, unknown>) as never);
      return id;
    });
  }
  return c.json(
    {
      recipe: recipeDetail(db, slug)!,
      version: saved.version,
      created: saved.created,
      impact: { photos, hours_estimate },
      ...(jobId ? {} : {}),
    },
    200,
  );
});

const ruleRoute = createRoute({
  method: 'put',
  path: '/culling-recipes/{slug}/rule',
  tags: ['culling-recipes'],
  request: {
    params: z.object({ slug: z.string() }),
    body: { content: jsonBody(z.object({ rule: RecipeRuleSchema }).strict()) },
  },
  responses: withValidationError({
    200: {
      description: 'Rule saved',
      content: jsonBody(
        z.object({
          recipe: CullRecipeDetail,
          pipeline_setting_version: z.number().int().nullable(),
          redecide_job_id: z.string().nullable(),
        }),
      ),
    },
    404: { description: 'Not found', content: jsonBody(ErrorBody) },
  }),
});

cullingRecipesRoutes.openapi(ruleRoute, (c) => {
  const db = c.get('libraryDb');
  const slug = c.req.param('slug');
  if (!getCullRecipe(db, slug)) return c.json({ error: 'resource not found' }, 404);
  const { rule } = c.req.valid('json');
  const version = setRecipeRule(db, slug, rule);
  let redecideJobId: string | null = null;
  if (version !== null) {
    redecideJobId = withJobsDb((jobsDb) => {
      const id = enqueueRedecideCullVerdicts(jobsDb, `rule of ${slug} changed`);
      if (id) {
        const job = getJob(jobsDb, id);
        if (job) emitJobEvent('job_created', compactJobPayload(job as unknown as Record<string, unknown>) as never);
      }
      return id;
    });
  }
  return c.json(
    { recipe: recipeDetail(db, slug)!, pipeline_setting_version: version, redecide_job_id: redecideJobId },
    200,
  );
});

const patchRoute = createRoute({
  method: 'patch',
  path: '/culling-recipes/{slug}',
  tags: ['culling-recipes'],
  request: {
    params: z.object({ slug: z.string() }),
    body: {
      content: jsonBody(
        z.object({ name: z.string().optional(), model: z.string().optional(), active: z.boolean().optional() }).strict(),
      ),
    },
  },
  responses: withValidationError({
    200: { description: 'Updated', content: jsonBody(CullRecipeDetail) },
    404: { description: 'Not found', content: jsonBody(ErrorBody) },
  }),
});

cullingRecipesRoutes.openapi(patchRoute, (c) => {
  const db = c.get('libraryDb');
  const slug = c.req.param('slug');
  if (!getCullRecipe(db, slug)) return c.json({ error: 'resource not found' }, 404);
  const body = c.req.valid('json');
  updateCullRecipeMeta(db, slug, body);
  let redecideJobId: string | null = null;
  if (body.active !== undefined) {
    const version = setCullRecipePipelineActive(db, slug, body.active);
    if (version !== null) {
      redecideJobId = withJobsDb((jobsDb) => enqueueRedecideCullVerdicts(jobsDb, `${slug} active=${body.active}`));
    }
  }
  void redecideJobId;
  return c.json(recipeDetail(db, slug)!, 200);
});

const pipelineGetRoute = createRoute({
  method: 'get',
  path: '/culling-recipes/pipeline',
  tags: ['culling-recipes'],
  responses: withValidationError({
    200: { description: 'Pipeline setting', content: jsonBody(PipelineSettingResponse) },
  }),
});

cullingRecipesRoutes.openapi(pipelineGetRoute, (c) => {
  const db = c.get('libraryDb');
  const pipe = getCurrentPipelineSetting(db);
  return c.json(pipe, 200);
});

const scoreForecastRoute = createRoute({
  method: 'put',
  path: '/culling-recipes/pipeline/score-forecast',
  tags: ['culling-recipes'],
  request: {
    body: {
      content: jsonBody(
        z
          .object({
            threshold: z.number(),
            enabled: z.boolean().optional(),
            high_from_level: z.number().int().optional(),
            excused_at: z.number().optional(),
            run_after_cut: z.boolean().optional(),
          })
          .strict(),
      ),
    },
  },
  responses: withValidationError({
    200: {
      description: 'Updated',
      content: jsonBody(z.object({ version: z.number().int(), redecide_job_id: z.string().nullable() })),
    },
  }),
});

cullingRecipesRoutes.openapi(scoreForecastRoute, (c) => {
  const db = c.get('libraryDb');
  const body = c.req.valid('json');
  const { config: pipeConfig, version: _v } = getCurrentPipelineSetting(db);
  const next = {
    ...pipeConfig,
    score_forecast: {
      ...pipeConfig.score_forecast,
      threshold: body.threshold,
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.high_from_level !== undefined ? { high_from_level: body.high_from_level } : {}),
      ...(body.excused_at !== undefined ? { excused_at: body.excused_at } : {}),
      ...(body.run_after_cut !== undefined ? { run_after_cut: body.run_after_cut } : {}),
    },
  };
  const version = createPipelineSettingVersion(db, next, 'score forecast threshold changed');
  const redecideJobId = withJobsDb((jobsDb) => enqueueRedecideCullVerdicts(jobsDb, 'score forecast threshold changed'));
  return c.json({ version, redecide_job_id: redecideJobId }, 200);
});

/** Default body for POST when client sends minimal create (F19). */
export function minimalNewRecipeBody(slug: string, name: string) {
  return {
    slug,
    name,
    model: 'laya-base',
    definition: defaultMinimalRecipeDefinition(),
    rule: defaultMinimalRecipeRule(),
    active: false,
  };
}
