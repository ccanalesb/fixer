/**
 * This app's System One endpoint (ADR-0021): the models installed in it, for culling and for any other
 * System One client. Mounted at the root (`/v1/*`), outside `/api` and its CORS: callable from another
 * machine only when the backend already listens beyond localhost (ADR-0019).
 *
 * Culling reaches it in-process through `systemOneRoutes.request`, the same requests without a socket.
 */
import { createRoute } from '@hono/zod-openapi';
import {
  AppModelAnswerFailed,
  AppModelNotListed,
  AppModelsUnavailable,
  appModels,
  type AppModels,
} from '../app-models/app-models.js';
import type { SystemOneQuestion } from '../systemone/question.js';
import { HttpError } from '../utils/responses.js';
import { createOpenApiApp } from './openapi.js';
import { jsonBody, withValidationError } from './route-helpers.js';
import { SystemOneModels, SystemOneRequest, SystemOneResponse, type SystemOneAnswer } from './schemas/systemone.js';
import type { z } from '@hono/zod-openapi';

const modelsRoute = createRoute({
  method: 'get',
  path: '/v1/models',
  tags: ['systemone'],
  responses: withValidationError({
    200: { description: 'Models this app serves', content: jsonBody(SystemOneModels) },
  }),
});

const answerRoute = createRoute({
  method: 'post',
  path: '/v1/systemone',
  tags: ['systemone'],
  request: { body: { content: jsonBody(SystemOneRequest) } },
  responses: withValidationError({
    200: { description: 'Answers by question id', content: jsonBody(SystemOneResponse) },
  }),
});

const DATA_URL = /^data:[^;,]*;base64,/;

/** 1 − normalized entropy: 1 when one level holds everything. */
function confidence(p: readonly number[]): number {
  if (p.length < 2) return 1;
  const h = -p.reduce((s, v) => (v > 0 ? s + v * Math.log(v) : s), 0);
  return 1 - h / Math.log(p.length);
}

function toAnswer(q: SystemOneQuestion, p: number[]): z.infer<typeof SystemOneAnswer> {
  if (q.type === 'noul') return { type: 'noul', noul: p[1]!, probabilities: { false: p[0]!, true: p[1]! } };
  if (q.type === 'score') {
    const criteria = q.criteria as string[];
    return {
      type: 'score',
      score: p.reduce((s, v, i) => s + v * i, 0),
      confidence: confidence(p),
      legend: Object.fromEntries(criteria.map((c, i) => [String(i), c])),
      probabilities: Object.fromEntries(p.map((v, i) => [String(i), v])),
    };
  }
  const keys = Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria ?? {});
  const best = p.indexOf(Math.max(...p));
  return {
    type: 'choice',
    choice: keys[best]!,
    confidence: confidence(p),
    probabilities: Object.fromEntries(keys.map((k, i) => [k, p[i]!])),
  };
}

/** The endpoint over a set of this app's models; the CLI serves its own. */
export function systemOneApp(models: () => AppModels) {
  const app = createOpenApiApp();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  });

  app.openapi(modelsRoute, async (c) => c.json({ models: await models().list() }, 200));

  app.openapi(answerRoute, async (c) => {
    const body = c.req.valid('json');
    const image = new Uint8Array(Buffer.from(body.images[0]!.replace(DATA_URL, ''), 'base64'));
    const questions = body.questions as Record<string, SystemOneQuestion>;
    let result;
    try {
      result = await models().answer(body.model, image, questions);
    } catch (e) {
      if (e instanceof AppModelNotListed) throw new HttpError(404, e.message);
      if (e instanceof AppModelsUnavailable) throw new HttpError(503, e.message);
      if (e instanceof AppModelAnswerFailed) return c.json([{ loc: ['body'], msg: e.message, type: 'answer_failed' }], 422);
      throw e;
    }
    const answers = Object.fromEntries(Object.entries(questions).map(([qid, q]) => [qid, toAnswer(q, result.answers[qid]!)]));
    return c.json({ model: body.model, answers, usage: { input_tokens: result.inputTokens, output_tokens: 0 } }, 200);
  });

  return app;
}

export const systemOneRoutes = systemOneApp(appModels);
