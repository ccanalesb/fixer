import { z } from '@hono/zod-openapi';

export const ScoreForecastQuestionSchema = z
  .object({
    id: z.string().openapi({ description: 'Fixed when the question is made; its answers are stored under it' }),
    name: z.string(),
    perspective_slug: z.string().nullable(),
    instructions: z.string(),
    levels: z.array(z.string()).openapi({ description: 'Lowest first; 10 of them' }),
    optional: z.boolean().openapi({ description: 'Asked "applies?" first; left out when it does not apply' }),
    applies: z.string().nullable().openapi({ description: 'The "applies?" question; null unless optional' }),
  })
  .strict()
  .openapi('ScoreForecastQuestion');

export const ScoreForecastQuestionsResponse = z
  .object({
    questions: z.array(ScoreForecastQuestionSchema),
    version: z.number().int().openapi({ description: '0 before any is saved' }),
    perspectives: z.array(z.object({ slug: z.string(), name: z.string(), active: z.boolean() })),
  })
  .openapi('ScoreForecastQuestionsResponse');

export const SaveScoreForecastQuestionsBody = z
  .object({
    questions: z.array(ScoreForecastQuestionSchema),
    mode: z.enum(['save_only', 'save_and_queue_cull']),
  })
  .strict();

export const SaveScoreForecastQuestionsResponse = ScoreForecastQuestionsResponse.extend({
  created: z.boolean(),
  impact: z.object({ photos: z.number().int(), hours_estimate: z.number() }),
  cull_job_id: z.string().nullable(),
}).openapi('SaveScoreForecastQuestionsResponse');

export const FromPerspectivesResponse = ScoreForecastQuestionsResponse.extend({
  skipped: z.array(z.string()).openapi({ description: 'Perspectives whose scoring bands could not be read' }),
}).openapi('ScoreForecastQuestionsFromPerspectivesResponse');

export const ValidationFailedBody = z.object({
  error: z.string(),
  validation_errors: z.array(z.object({ field: z.string(), message: z.string() })),
});
