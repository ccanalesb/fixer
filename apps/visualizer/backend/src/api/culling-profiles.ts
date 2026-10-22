/**
 * Culling profiles and pipeline setting API.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { config } from '../config.js';
import { validateProfileShape } from '../cull/profile-shape.js';
import { validateProfileDefinitionForLaya, type ProfileValidationError } from '../cull/profile-validate.js';
import type { PipelineSettingConfig } from '../cull/types.js';
import { createPipelineSettingVersion, getCurrentPipelineSetting } from '../db/library/cull-pipeline.js';
import {
  countCatalogPhotosForCullEstimate,
  defaultMinimalProfileDefinition,
  defaultMinimalProfileRule,
  duplicateCullProfile,
  saveProfileDefinition,
  setCullProfilePipelineActive,
  updateCullProfileMeta,
} from '../db/library/cull-profiles-mutations.js';
import { createCullProfile, getCullProfile, listCullProfiles, setProfileRule } from '../db/library/cull-profiles.js';
import { initJobsDb, createJob, getJob } from '../db/jobs/jobs.js';
import { BATCH_CULL_JOB_TYPE } from '../jobs/handlers/cull.js';
import { enqueueRedecideCullVerdicts } from '../jobs/handlers/redecide.js';
import { isValidPerspectiveSlug } from '../utils/perspective-slug.js';
import { errorNotFound } from '../utils/responses.js';
import { emitJobEvent } from '../websocket/events.js';
import { libraryDb, type LibraryEnv } from './library-db.js';
import { createOpenApiApp } from './openapi.js';
import { jsonBody, redirectToTrailingSlash, withValidationError } from './route-helpers.js';
import { ErrorBody } from './schemas/errors.js';
import {
  CullProfileDetail,
  CullProfileListResponse,
  PipelineSettingResponse,
  ProfileDefinitionSchema,
  ProfileRuleSchema,
  ScoreForecastSettingSchema,
} from './schemas/culling-profiles.js';
import { compactJobPayload } from './schemas/jobs.js';

export const cullingProfilesRoutes = createOpenApiApp<LibraryEnv>();

const validationFailed = (errors: ProfileValidationError[]) => ({
  error: errors.map((e) => e.message).join('; '),
  validation_errors: errors,
});

cullingProfilesRoutes.use('/culling-profiles/*', libraryDb({ write: true }));
redirectToTrailingSlash(cullingProfilesRoutes, '/culling-profiles');

/** Fixed path segments under `/culling-profiles/` — not profile slugs. */
export const RESERVED_CULL_PROFILE_SLUGS = new Set(['pipeline']);

function withJobsDb<T>(fn: (db: import('../db/connection.js').Db) => T): T {
  const db = initJobsDb(config.VISUALIZER_DB);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function profileSummary(db: import('../db/connection.js').Db, profile: ReturnType<typeof getCullProfile>) {
  if (!profile) throw new Error('missing profile');
  const pipe = getCurrentPipelineSetting(db);
  const idx = pipe.config.culling_profiles.findIndex((r) => r.profile_slug === profile.slug);
  return {
    slug: profile.slug,
    name: profile.name,
    model: profile.model,
    active: profile.active,
    measured: profile.measured,
    version: profile.version,
    in_pipeline: idx >= 0,
    pipeline_order: idx >= 0 ? idx : null,
  };
}

function profileDetail(db: import('../db/connection.js').Db, slug: string) {
  const profile = getCullProfile(db, slug);
  if (!profile) return null;
  return {
    ...profileSummary(db, profile),
    definition: profile.definition,
    rule: profile.rule,
  };
}

const listRoute = createRoute({
  method: 'get',
  path: '/culling-profiles/',
  tags: ['culling-profiles'],
  responses: withValidationError({
    200: { description: 'All culling profiles', content: jsonBody(CullProfileListResponse) },
  }),
});

cullingProfilesRoutes.openapi(listRoute, (c) => {
  const db = c.get('libraryDb');
  const profiles = listCullProfiles(db).map((r) => profileSummary(db, r));
  return c.json({ profiles }, 200);
});

const pipelineGetRoute = createRoute({
  method: 'get',
  path: '/culling-profiles/pipeline',
  tags: ['culling-profiles'],
  responses: withValidationError({
    200: { description: 'Pipeline setting', content: jsonBody(PipelineSettingResponse) },
  }),
});

cullingProfilesRoutes.openapi(pipelineGetRoute, (c) => {
  const db = c.get('libraryDb');
  const pipe = getCurrentPipelineSetting(db);
  return c.json(pipe, 200);
});

const PipelineChangeResponse = z.object({ version: z.number().int(), redecide_job_id: z.string().nullable() });

const notEmpty = (body: object) => Object.keys(body).length > 0;

/** A new pipeline-setting version, and the re-decide job that applies it to every photo. */
function savePipelineChange(db: import('../db/connection.js').Db, next: PipelineSettingConfig, note: string) {
  const version = createPipelineSettingVersion(db, next, note);
  const redecideJobId = withJobsDb((jobsDb) => {
    const id = enqueueRedecideCullVerdicts(jobsDb, note);
    if (id) {
      const job = getJob(jobsDb, id);
      if (job) emitJobEvent('job_created', compactJobPayload(job as unknown as Record<string, unknown>) as never);
    }
    return id;
  });
  return { version, redecide_job_id: redecideJobId };
}

const scoreForecastRoute = createRoute({
  method: 'put',
  path: '/culling-profiles/pipeline/score-forecast',
  tags: ['culling-profiles'],
  request: {
    body: {
      content: jsonBody(
        z
          .object({
            threshold: z.number().optional(),
            enabled: z.boolean().optional(),
            high_from_level: z.number().int().optional(),
            excused_at: z.number().optional(),
          })
          .strict()
          .refine(notEmpty, { message: 'nothing to change' }),
      ),
    },
  },
  responses: withValidationError({
    200: { description: 'Updated', content: jsonBody(PipelineChangeResponse) },
  }),
});

cullingProfilesRoutes.openapi(scoreForecastRoute, (c) => {
  const db = c.get('libraryDb');
  const body = c.req.valid('json');
  const { config: pipeConfig } = getCurrentPipelineSetting(db);
  const next = { ...pipeConfig, score_forecast: { ...pipeConfig.score_forecast, ...body } };
  return c.json(savePipelineChange(db, next, 'score forecast changed'), 200);
});

const cullingProfilesSwitchRoute = createRoute({
  method: 'put',
  path: '/culling-profiles/pipeline/culling-profiles',
  tags: ['culling-profiles'],
  request: {
    body: {
      content: jsonBody(
        z
          .object({ enabled: z.boolean().optional(), filter_enabled: z.boolean().optional() })
          .strict()
          .refine(notEmpty, { message: 'nothing to change' }),
      ),
    },
  },
  responses: withValidationError({
    200: { description: 'Updated', content: jsonBody(PipelineChangeResponse) },
  }),
});

cullingProfilesRoutes.openapi(cullingProfilesSwitchRoute, (c) => {
  const db = c.get('libraryDb');
  const body = c.req.valid('json');
  const { config: pipeConfig } = getCurrentPipelineSetting(db);
  const next = {
    ...pipeConfig,
    ...(body.enabled !== undefined ? { culling_profiles_enabled: body.enabled } : {}),
    ...(body.filter_enabled !== undefined ? { culling_profiles_filter_enabled: body.filter_enabled } : {}),
  };
  return c.json(savePipelineChange(db, next, 'culling profile switches changed'), 200);
});

const detailRoute = createRoute({
  method: 'get',
  path: '/culling-profiles/{slug}',
  tags: ['culling-profiles'],
  request: { params: z.object({ slug: z.string() }) },
  responses: withValidationError({
    200: { description: 'One profile', content: jsonBody(CullProfileDetail) },
    404: { description: 'Not found', content: jsonBody(ErrorBody) },
  }),
});

cullingProfilesRoutes.openapi(detailRoute, (c) => {
  const slug = c.req.param('slug');
  if (RESERVED_CULL_PROFILE_SLUGS.has(slug)) return errorNotFound(c, 'image');
  const db = c.get('libraryDb');
  const detail = profileDetail(db, slug);
  if (!detail) return errorNotFound(c, 'image');
  return c.json(detail, 200);
});

const createRouteDef = createRoute({
  method: 'post',
  path: '/culling-profiles/',
  tags: ['culling-profiles'],
  request: {
    body: {
      content: jsonBody(
        z
          .object({
            slug: z.string(),
            name: z.string(),
            model: z.string(),
            definition: ProfileDefinitionSchema,
            rule: ProfileRuleSchema,
            active: z.boolean().optional(),
          })
          .strict(),
      ),
    },
  },
  responses: withValidationError({
    201: { description: 'Created', content: jsonBody(CullProfileDetail) },
    400: { description: 'Validation failed', content: jsonBody(ErrorBody) },
    409: { description: 'Duplicate slug', content: jsonBody(ErrorBody) },
  }),
});

cullingProfilesRoutes.openapi(createRouteDef, (c) => {
  const db = c.get('libraryDb');
  const body = c.req.valid('json');
  if (!isValidPerspectiveSlug(body.slug)) return c.json({ error: 'invalid slug' }, 400);
  if (RESERVED_CULL_PROFILE_SLUGS.has(body.slug)) return c.json({ error: 'slug is reserved' }, 400);
  if (getCullProfile(db, body.slug)) return c.json({ error: 'slug already exists' }, 409);
  const shape = validateProfileShape(body.definition, body.rule, { requireText: false });
  if (shape.length) return c.json(validationFailed(shape), 400);
  const v = validateProfileDefinitionForLaya(body.definition, body.model);
  if (!v.ok) return c.json(validationFailed(v.errors), 400);
  createCullProfile(db, { ...body, measured: false, active: body.active !== false });
  if (body.active !== false) setCullProfilePipelineActive(db, body.slug, true);
  const detail = profileDetail(db, body.slug)!;
  return c.json(detail, 201);
});

const duplicateRoute = createRoute({
  method: 'post',
  path: '/culling-profiles/{slug}/duplicate',
  tags: ['culling-profiles'],
  request: {
    params: z.object({ slug: z.string() }),
    body: { content: jsonBody(z.object({ new_slug: z.string(), new_name: z.string().optional() }).strict()) },
  },
  responses: withValidationError({
    201: { description: 'Duplicated', content: jsonBody(CullProfileDetail) },
    404: { description: 'Not found', content: jsonBody(ErrorBody) },
    409: { description: 'Duplicate slug', content: jsonBody(ErrorBody) },
  }),
});

cullingProfilesRoutes.openapi(duplicateRoute, (c) => {
  const db = c.get('libraryDb');
  const slug = c.req.param('slug');
  const { new_slug, new_name } = c.req.valid('json');
  if (!getCullProfile(db, slug)) return errorNotFound(c, 'image');
  if (getCullProfile(db, new_slug)) return c.json({ error: 'slug already exists' }, 409);
  duplicateCullProfile(db, slug, new_slug, new_name);
  return c.json(profileDetail(db, new_slug)!, 201);
});

const definitionRoute = createRoute({
  method: 'put',
  path: '/culling-profiles/{slug}/definition',
  tags: ['culling-profiles'],
  request: {
    params: z.object({ slug: z.string() }),
    body: {
      content: jsonBody(
        z
          .object({
            definition: ProfileDefinitionSchema,
            rule: ProfileRuleSchema.optional().openapi({
              description: 'Saved with the definition; required when level sets or their bands change.',
            }),
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
          profile: CullProfileDetail,
          version: z.number().int(),
          created: z.boolean(),
          impact: z.object({ photos: z.number().int(), hours_estimate: z.number() }),
          cull_job_id: z.string().nullable(),
        }),
      ),
    },
    404: { description: 'Not found', content: jsonBody(ErrorBody) },
    400: {
      description: 'Validation failed',
      content: jsonBody(
        z.object({
          error: z.string(),
          validation_errors: z.array(z.object({ field: z.string(), message: z.string() })),
        }),
      ),
    },
  }),
});

cullingProfilesRoutes.openapi(definitionRoute, (c) => {
  const db = c.get('libraryDb');
  const slug = c.req.param('slug');
  const profile = getCullProfile(db, slug);
  if (!profile) return errorNotFound(c, 'image');
  const { definition, rule, mode } = c.req.valid('json');
  const shape = validateProfileShape(definition, rule ?? profile.rule, { requireText: true });
  if (shape.length) return c.json(validationFailed(shape), 400);
  const v = validateProfileDefinitionForLaya(definition, profile.model);
  if (!v.ok) return c.json(validationFailed(v.errors), 400);
  const saved = saveProfileDefinition(db, slug, definition);
  const ruleVersion = rule ? setProfileRule(db, slug, rule) : null;
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
  } else if (ruleVersion !== null) {
    withJobsDb((jobsDb) => {
      const id = enqueueRedecideCullVerdicts(jobsDb, `rule of ${slug} changed`);
      const job = id ? getJob(jobsDb, id) : null;
      if (job) emitJobEvent('job_created', compactJobPayload(job as unknown as Record<string, unknown>) as never);
    });
  }
  return c.json(
    {
      profile: profileDetail(db, slug)!,
      version: saved.version,
      created: saved.created,
      impact: { photos, hours_estimate },
      cull_job_id: jobId,
    },
    200,
  );
});

const ruleRoute = createRoute({
  method: 'put',
  path: '/culling-profiles/{slug}/rule',
  tags: ['culling-profiles'],
  request: {
    params: z.object({ slug: z.string() }),
    body: { content: jsonBody(z.object({ rule: ProfileRuleSchema }).strict()) },
  },
  responses: withValidationError({
    200: {
      description: 'Rule saved',
      content: jsonBody(
        z.object({
          profile: CullProfileDetail,
          pipeline_setting_version: z.number().int().nullable(),
          redecide_job_id: z.string().nullable(),
        }),
      ),
    },
    404: { description: 'Not found', content: jsonBody(ErrorBody) },
    400: {
      description: 'Bands do not fit the level sets',
      content: jsonBody(
        z.object({
          error: z.string(),
          validation_errors: z.array(z.object({ field: z.string(), message: z.string() })),
        }),
      ),
    },
  }),
});

cullingProfilesRoutes.openapi(ruleRoute, (c) => {
  const db = c.get('libraryDb');
  const slug = c.req.param('slug');
  const profile = getCullProfile(db, slug);
  if (!profile) return errorNotFound(c, 'image');
  const { rule } = c.req.valid('json');
  const shape = validateProfileShape(profile.definition, rule, { requireText: false });
  if (shape.length) return c.json(validationFailed(shape), 400);
  const version = setProfileRule(db, slug, rule);
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
    { profile: profileDetail(db, slug)!, pipeline_setting_version: version, redecide_job_id: redecideJobId },
    200,
  );
});

const patchRoute = createRoute({
  method: 'patch',
  path: '/culling-profiles/{slug}',
  tags: ['culling-profiles'],
  request: {
    params: z.object({ slug: z.string() }),
    body: {
      content: jsonBody(
        z.object({ name: z.string().optional(), model: z.string().optional(), active: z.boolean().optional() }).strict(),
      ),
    },
  },
  responses: withValidationError({
    200: { description: 'Updated', content: jsonBody(CullProfileDetail) },
    404: { description: 'Not found', content: jsonBody(ErrorBody) },
  }),
});

cullingProfilesRoutes.openapi(patchRoute, (c) => {
  const db = c.get('libraryDb');
  const slug = c.req.param('slug');
  if (!getCullProfile(db, slug)) return errorNotFound(c, 'image');
  const body = c.req.valid('json');
  updateCullProfileMeta(db, slug, body);
  if (body.active !== undefined) {
    const version = setCullProfilePipelineActive(db, slug, body.active);
    if (version !== null) {
      withJobsDb((jobsDb) => {
        const id = enqueueRedecideCullVerdicts(jobsDb, `${slug} active=${body.active}`);
        if (id) {
          const job = getJob(jobsDb, id);
          if (job) emitJobEvent('job_created', compactJobPayload(job as unknown as Record<string, unknown>) as never);
        }
        return id;
      });
    }
  }
  return c.json(profileDetail(db, slug)!, 200);
});

/** Default body for POST when client sends minimal create (F19). */
export function minimalNewProfileBody(slug: string, name: string) {
  return {
    slug,
    name,
    model: 'laya-base',
    definition: defaultMinimalProfileDefinition(),
    rule: defaultMinimalProfileRule(),
    active: false,
  };
}
