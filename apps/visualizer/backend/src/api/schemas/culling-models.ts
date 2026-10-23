/** Culling models API models (`/api/culling-models*`): each culling stage's System One endpoint and model. */
import { z } from '@hono/zod-openapi';

export const CullingStageParam = z.object({
  stage: z.enum(['culling_profile', 'score_forecast']).openapi({ param: { name: 'stage', in: 'path' } }),
});

export const CullingStageModel = z
  .object({
    /** `this_app`, or the URL of another System One endpoint. */
    endpoint: z.string(),
    /** `null` until one is chosen. */
    model: z.string().nullable(),
    /** The key itself never leaves the backend. */
    has_api_key: z.boolean(),
    /** Photos with answers under the stage's current versions, and the model those versions were made with. */
    answered: z.object({ photos: z.number().int(), model: z.string().nullable() }).strict(),
  })
  .strict()
  .openapi('CullingStageModel');

export const CullingModelsResponse = z
  .object({
    culling_profile: CullingStageModel,
    score_forecast: CullingStageModel,
    /** Photos a culling job over the whole catalog would take. */
    total_photos: z.number().int(),
  })
  .strict()
  .openapi('CullingModelsResponse');

export const CullingStageModelPutRequest = z
  .object({
    /** `this_app` or an http(s) URL. Another endpoint than the saved one clears the model and the API key. */
    endpoint: z.string().optional(),
    /** `null` for none. */
    model: z.string().nullable().optional(),
    /** Omitted keeps the saved key; `''` removes it. Ignored for `this_app`. */
    api_key: z.string().optional(),
  })
  .strict()
  .openapi('CullingStageModelPutRequest');

export const CullingStageModelsList = z
  .object({
    /** Whether the stage's saved endpoint answered `GET /v1/models`. */
    answers: z.boolean(),
    models: z.array(z.string()),
    /** Why it did not answer. */
    error: z.string().nullable(),
  })
  .strict()
  .openapi('CullingStageModelsList');

export const CullingStageUsability = z
  .object({
    on: z.boolean(),
    /** Why a stage that is on cannot run; `null` when it can, or is off. */
    problem: z.enum(['no_model', 'converting', 'down', 'refused', 'not_listed', 'no_questions']).nullable(),
    model: z.string().nullable(),
    endpoint: z.string(),
    /** The conversion job of a model still converting in this app. */
    job_id: z.string().nullable(),
    /** What the endpoint said, when it did not answer or refused. */
    detail: z.string().nullable(),
  })
  .strict()
  .openapi('CullingStageUsability');

export const CullingModelsUsableResponse = z
  .object({
    culling_profile: CullingStageUsability,
    score_forecast: CullingStageUsability,
    /** Whether the culling profile's rule filters photos (`culling_profiles_filter_enabled`). */
    culling_profile_filter: z.boolean(),
  })
  .strict()
  .openapi('CullingModelsUsableResponse');
