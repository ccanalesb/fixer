/**
 * Cull review API — filtered photos list, detail, user actions, send by hand.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { config } from '../config.js';
import {
  batchDescribeScoreCompletion,
  buildProfileRowReadout,
  describeScoreCompletion,
  resolveFilteringProfile,
  scoreForecastByPerspective,
} from '../cull/review.js';
import { SCORE_FORECAST_STAGE_KEY, resolveCurrentStages } from '../cull/stages.js';
import { getCurrentPipelineSetting } from '../db/library/cull-pipeline.js';
import { getCullVerdict } from '../db/library/cull-verdicts.js';
import { getCullReviewSummary, listCullReviewPhotos } from '../db/library/cull-review.js';
import { loadCurrentStageAnswers, readStoredLayaModelIds } from '../db/library/cull-stages.js';
import {
  listCullUserActions,
  recordCullUserAction,
  withdrawShouldHaveBeenFiltered,
} from '../db/library/cull-user-actions.js';
import { initJobsDb, createJob, getJob } from '../db/jobs/jobs.js';
import { batchKeysWithSendWork } from '../jobs/handlers/work-keys.js';
import { emitJobEvent } from '../websocket/events.js';
import { clampPagination, errorNotFound } from '../utils/responses.js';
import { libraryDb, type LibraryEnv } from './library-db.js';
import { createOpenApiApp } from './openapi.js';
import { jsonBody, redirectToTrailingSlash, withValidationError } from './route-helpers.js';
import { ErrorBody } from './schemas/errors.js';
import {
  CullReviewDetail,
  CullReviewListResponse,
  CullReviewSummaryResponse,
  CullUserActionSchema,
} from './schemas/cull-review.js';
import { compactJobPayload } from './schemas/jobs.js';

export const cullReviewRoutes = createOpenApiApp<LibraryEnv>();

cullReviewRoutes.use('/cull/*', libraryDb({ write: true }));
redirectToTrailingSlash(cullReviewRoutes, '/cull');

/** Not catalog image keys — must not match `/cull/photos/{image_key}`. */
const RESERVED_CULL_PHOTO_KEYS = new Set(['send']);

function thumbnailUrl(imageKey: string): string {
  return `/api/images/catalog/${encodeURIComponent(imageKey)}/thumbnail`;
}

function pipelineFallbackProfile(db: import('../db/connection.js').Db): string {
  const { config: pipe } = getCurrentPipelineSetting(db);
  return pipe.culling_profiles[0]?.profile_slug ?? 'recipe-culling';
}

function shapeReviewRow(
  db: import('../db/connection.js').Db,
  row: {
    image_key: string;
    filename: string;
    date_taken: string | null;
    filtered_by: import('../cull/types.js').StageKind;
    filtered_by_stage_key: string | null;
    score_forecast_p8: number | null;
  },
  answersByStage: Record<string, Record<string, number[]>>,
  completionByKey: Map<string, import('../db/library/cull-completion.js').DescribeScoreCompletion>,
  sendWorkKeys: Set<string>,
) {
  const profile = resolveFilteringProfile(db, row.filtered_by_stage_key, pipelineFallbackProfile(db));
  const profileBlock = profile
    ? buildProfileRowReadout(profile, profile.definition, profile.rule, answersByStage)
    : { slug: '', name: '', level_sets: [] };
  return {
    image_key: row.image_key,
    filename: row.filename,
    date_taken: row.date_taken,
    filtered_by: row.filtered_by as 'culling_profile' | 'score_forecast',
    score_forecast_p8: row.score_forecast_p8,
    profile: profileBlock,
    completion: completionByKey.get(row.image_key) ?? 'none',
    needs_send_work: sendWorkKeys.has(row.image_key),
    thumbnail_url: thumbnailUrl(row.image_key),
  };
}

const summaryRoute = createRoute({
  method: 'get',
  path: '/cull/summary',
  tags: ['cull'],
  responses: withValidationError({
    200: { description: 'Cull review header stats', content: jsonBody(CullReviewSummaryResponse) },
  }),
});

cullReviewRoutes.openapi(summaryRoute, (c) => {
  const db = c.get('libraryDb');
  return c.json(getCullReviewSummary(db), 200);
});

const listRoute = createRoute({
  method: 'get',
  path: '/cull/photos/',
  tags: ['cull'],
  request: {
    query: z.object({
      tab: z.enum(['all', 'culling_profile', 'score_forecast']).optional(),
      limit: z.string().optional(),
      offset: z.string().optional(),
    }),
  },
  responses: withValidationError({
    200: { description: 'Filtered photos for review', content: jsonBody(CullReviewListResponse) },
  }),
});

cullReviewRoutes.openapi(listRoute, (c) => {
  const db = c.get('libraryDb');
  const tab = (c.req.query('tab') ?? 'all') as 'all' | 'culling_profile' | 'score_forecast';
  const { limit, offset } = clampPagination(c.req.query('limit'), c.req.query('offset'), 50);
  const { rows, total } = listCullReviewPhotos(db, tab, limit, offset);
  const modelIds = readStoredLayaModelIds(db);
  const pipe = getCurrentPipelineSetting(db);
  const stages = modelIds ? resolveCurrentStages(db, pipe.config, modelIds) : [];
  const keys = rows.map((r) => r.image_key);
  const answers = loadCurrentStageAnswers(db, stages, keys);
  const completionByKey = batchDescribeScoreCompletion(db, keys);
  const sendWorkKeys = batchKeysWithSendWork(db, keys);
  const data = rows.map((r) =>
    shapeReviewRow(db, r, answers.get(r.image_key) ?? {}, completionByKey, sendWorkKeys),
  );
  return c.json({ data, total, limit, offset }, 200);
});

const sendRoute = createRoute({
  method: 'post',
  path: '/cull/photos/send',
  tags: ['cull'],
  request: {
    body: { content: jsonBody(z.object({ image_keys: z.array(z.string()).min(1) }).strict()) },
  },
  responses: withValidationError({
    200: {
      description: 'Send by hand',
      content: jsonBody(
        z.object({
          sent_by_hand: z.array(z.string()),
          job_id: z.string().nullable(),
          skipped_complete: z.number().int(),
        }),
      ),
    },
  }),
});

cullReviewRoutes.openapi(sendRoute, async (c) => {
  const db = c.get('libraryDb');
  const { image_keys: keys } = c.req.valid('json');
  const sendWorkKeys = batchKeysWithSendWork(db, keys);
  const sent: string[] = [];
  for (const key of keys) {
    if (!sendWorkKeys.has(key)) continue;
    recordCullUserAction(db, key, 'sent_by_hand');
    sent.push(key);
  }
  if (sent.length > 0) {
    try {
      const { enqueueLrWritebackIfEnabled } = await import('../jobs/handlers/lr-writeback.js');
      enqueueLrWritebackIfEnabled(db, { imageKeys: sent });
    } catch (e) {
      process.stderr.write(
        `lightroom write-back after send-by-hand: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
  const skippedComplete = keys.length - sent.length;
  const workKeys = [...sendWorkKeys];
  let jobId: string | null = null;
  if (workKeys.length > 0) {
    const jobsDb = initJobsDb(config.VISUALIZER_DB);
    try {
      jobId = createJob(jobsDb, 'batch_analyze', {
        image_type: 'catalog',
        image_keys: workKeys,
        force_describe: false,
        force_score: false,
      });
      const job = getJob(jobsDb, jobId);
      if (job) emitJobEvent('job_created', compactJobPayload(job as unknown as Record<string, unknown>) as never);
    } finally {
      jobsDb.close();
    }
  }
  return c.json({ sent_by_hand: sent, job_id: jobId, skipped_complete: skippedComplete }, 200);
});

const detailRoute = createRoute({
  method: 'get',
  path: '/cull/photos/{image_key}',
  tags: ['cull'],
  request: { params: z.object({ image_key: z.string() }) },
  responses: withValidationError({
    200: { description: 'One filtered or passed photo', content: jsonBody(CullReviewDetail) },
    404: { description: 'Not found', content: jsonBody(ErrorBody) },
  }),
});

cullReviewRoutes.openapi(detailRoute, (c) => {
  const db = c.get('libraryDb');
  const imageKey = c.req.param('image_key');
  if (RESERVED_CULL_PHOTO_KEYS.has(imageKey)) return errorNotFound(c, 'image');
  const v = getCullVerdict(db, imageKey);
  if (!v || (v.verdict !== 'filtered' && v.verdict !== 'passed')) {
    return errorNotFound(c, 'image');
  }
  const image = db.prepare('SELECT filename FROM images WHERE key = ?').get(imageKey) as { filename: string } | undefined;
  const modelIds = readStoredLayaModelIds(db);
  const pipe = getCurrentPipelineSetting(db);
  const stages = modelIds ? resolveCurrentStages(db, pipe.config, modelIds) : [];
  const answers = loadCurrentStageAnswers(db, stages, [imageKey]).get(imageKey) ?? {};
  const profile = resolveFilteringProfile(db, v.filtered_by_stage_key, pipelineFallbackProfile(db));
  const profileBlock = profile
    ? buildProfileRowReadout(profile, profile.definition, profile.rule, answers)
    : { slug: '', name: '', level_sets: [] };
  const sfAnswers = answers[SCORE_FORECAST_STAGE_KEY] ?? {};
  const actions = listCullUserActions(db, imageKey).map((a) => ({ action: a.action, acted_at: a.acted_at }));
  const sentByHand = v.sent_by_hand || actions.some((a) => a.action === 'sent_by_hand');
  const needs_send_work = batchKeysWithSendWork(db, [imageKey]).has(imageKey);
  return c.json(
    {
      image_key: imageKey,
      filename: image?.filename ?? imageKey,
      filtered_by: v.filtered_by,
      score_forecast_p8: v.score_forecast_p8,
      profile: profileBlock,
      score_forecast: scoreForecastByPerspective(sfAnswers, pipe.config.score_forecast),
      user_actions: actions,
      completion: describeScoreCompletion(db, imageKey),
      needs_send_work,
      sent_by_hand: sentByHand,
      verdict: v.verdict,
    },
    200,
  );
});

const actionRoute = createRoute({
  method: 'post',
  path: '/cull/photos/{image_key}/actions',
  tags: ['cull'],
  request: {
    params: z.object({ image_key: z.string() }),
    body: { content: jsonBody(z.object({ action: CullUserActionSchema }).strict()) },
  },
  responses: withValidationError({
    200: {
      description: 'Recorded',
      content: jsonBody(z.object({ ok: z.literal(true), verdict: z.string(), user_action: CullUserActionSchema })),
    },
  }),
});

cullReviewRoutes.openapi(actionRoute, async (c) => {
  const db = c.get('libraryDb');
  const imageKey = c.req.param('image_key');
  const { action } = c.req.valid('json');
  recordCullUserAction(db, imageKey, action);
  const v = getCullVerdict(db, imageKey);
  return c.json({ ok: true as const, verdict: v?.verdict ?? 'none', user_action: action }, 200);
});

const withdrawActionRoute = createRoute({
  method: 'delete',
  path: '/cull/photos/{image_key}/actions/{action}',
  tags: ['cull'],
  request: {
    params: z.object({ image_key: z.string(), action: z.enum(['should_have_been_filtered']) }),
  },
  responses: withValidationError({
    200: {
      description: 'Withdrawn',
      content: jsonBody(z.object({ ok: z.literal(true), removed: z.number().int() })),
    },
  }),
});

cullReviewRoutes.openapi(withdrawActionRoute, async (c) => {
  const db = c.get('libraryDb');
  const { image_key: imageKey } = c.req.valid('param');
  const removed = withdrawShouldHaveBeenFiltered(db, imageKey);
  return c.json({ ok: true as const, removed }, 200);
});
