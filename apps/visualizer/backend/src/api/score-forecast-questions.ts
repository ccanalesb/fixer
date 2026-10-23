/**
 * Score forecast questions API: read and save the set, like a culling profile's text, and
 * "Create questions from my perspectives" — a script, no model involved.
 */
import { createRoute } from '@hono/zod-openapi';
import { config } from '../config.js';
import { questionsFromPerspectives, validateForecastQuestions } from '../cull/forecast-questions.js';
import type { Db } from '../db/connection.js';
import { createJob, getJob, initJobsDb } from '../db/jobs/jobs.js';
import { countCatalogPhotosForCullEstimate } from '../db/library/cull-profiles-mutations.js';
import { getForecastQuestions, saveForecastQuestions } from '../db/library/score-forecast-questions.js';
import { listPerspectives } from '../db/library/scores.js';
import { BATCH_CULL_JOB_TYPE } from '../jobs/handlers/cull.js';
import { errorBadRequest } from '../utils/responses.js';
import { emitJobEvent } from '../websocket/events.js';
import { libraryDb, type LibraryEnv } from './library-db.js';
import { createOpenApiApp } from './openapi.js';
import { jsonBody, withValidationError } from './route-helpers.js';
import { ErrorBody } from './schemas/errors.js';
import { compactJobPayload } from './schemas/jobs.js';
import {
  FromPerspectivesResponse,
  SaveScoreForecastQuestionsBody,
  SaveScoreForecastQuestionsResponse,
  ScoreForecastQuestionsResponse,
  ValidationFailedBody,
} from './schemas/score-forecast-questions.js';

export const scoreForecastQuestionsRoutes = createOpenApiApp<LibraryEnv>();

scoreForecastQuestionsRoutes.use('/score-forecast-questions', libraryDb({ write: true }));
scoreForecastQuestionsRoutes.use('/score-forecast-questions/*', libraryDb({ write: true }));

function current(db: Db) {
  const { questions, version } = getForecastQuestions(db);
  return {
    questions,
    version,
    perspectives: listPerspectives(db).map((p) => ({ slug: p.slug, name: p.display_name, active: p.active === 1 })),
  };
}

const getRoute = createRoute({
  method: 'get',
  path: '/score-forecast-questions',
  tags: ['score-forecast-questions'],
  responses: withValidationError({
    200: { description: 'The current Score forecast questions', content: jsonBody(ScoreForecastQuestionsResponse) },
  }),
});

scoreForecastQuestionsRoutes.openapi(getRoute, (c) => c.json(current(c.get('libraryDb')), 200));

const saveRoute = createRoute({
  method: 'put',
  path: '/score-forecast-questions',
  tags: ['score-forecast-questions'],
  request: { body: { content: jsonBody(SaveScoreForecastQuestionsBody) } },
  responses: withValidationError({
    200: { description: 'Saved', content: jsonBody(SaveScoreForecastQuestionsResponse) },
    400: { description: 'Validation failed', content: jsonBody(ValidationFailedBody) },
  }),
});

scoreForecastQuestionsRoutes.openapi(saveRoute, (c) => {
  const db = c.get('libraryDb');
  const { questions, mode } = c.req.valid('json');
  const slugs = new Set(listPerspectives(db).map((p) => p.slug));
  const errors = [
    ...validateForecastQuestions(questions),
    ...questions
      .filter((q) => q.perspective_slug !== null && !slugs.has(q.perspective_slug))
      .map((q) => ({ field: `${q.id}.perspective_slug`, message: `There is no perspective ${q.perspective_slug}` })),
  ];
  if (errors.length) {
    return c.json({ error: errors.map((e) => e.message).join('; '), validation_errors: errors }, 400);
  }
  const saved = saveForecastQuestions(db, questions);
  const photos = countCatalogPhotosForCullEstimate(db);
  let jobId: string | null = null;
  if (mode === 'save_and_queue_cull') {
    const jobs = initJobsDb(config.VISUALIZER_DB);
    try {
      jobId = createJob(jobs, BATCH_CULL_JOB_TYPE, {});
      const job = getJob(jobs, jobId);
      if (job) emitJobEvent('job_created', compactJobPayload(job as unknown as Record<string, unknown>) as never);
    } finally {
      jobs.close();
    }
  }
  return c.json(
    {
      ...current(db),
      created: saved.created,
      impact: { photos, hours_estimate: (photos * 2) / 3600 },
      cull_job_id: jobId,
    },
    200,
  );
});

const fromPerspectivesRoute = createRoute({
  method: 'post',
  path: '/score-forecast-questions/from-perspectives',
  tags: ['score-forecast-questions'],
  responses: withValidationError({
    200: { description: 'Questions created', content: jsonBody(FromPerspectivesResponse) },
    400: { description: 'There are questions already', content: jsonBody(ErrorBody) },
  }),
});

scoreForecastQuestionsRoutes.openapi(fromPerspectivesRoute, (c) => {
  const db = c.get('libraryDb');
  if (getForecastQuestions(db).questions.length > 0) {
    return errorBadRequest(c, 'There are Score forecast questions already');
  }
  const { questions, skipped } = questionsFromPerspectives(listPerspectives(db, { activeOnly: true }));
  saveForecastQuestions(db, questions);
  return c.json({ ...current(db), skipped }, 200);
});
