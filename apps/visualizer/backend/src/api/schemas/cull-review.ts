import { z } from '@hono/zod-openapi';

export const CullUserActionSchema = z.enum(['sent_by_hand', 'agrees_with_filter', 'should_have_been_filtered']);

export const DimensionHighlight = z
  .object({
    slug: z.string(),
    name: z.string(),
    levels: z.array(z.object({ level: z.number().int(), fails: z.boolean(), strong: z.boolean() })),
  })
  .strict();

export const CullReviewProfileBlock = z
  .object({
    slug: z.string(),
    name: z.string(),
    level_sets: z.array(
      z.object({
        id: z.string(),
        dimensions: z.array(DimensionHighlight),
      }),
    ),
  })
  .strict();

export const CullReviewRow = z
  .object({
    image_key: z.string(),
    filename: z.string(),
    date_taken: z.string().nullable(),
    filtered_by: z.enum(['culling_profile', 'score_forecast']),
    score_forecast_p8: z.number().nullable(),
    profile: CullReviewProfileBlock,
    completion: z.enum(['none', 'some', 'all']),
    needs_send_work: z.boolean(),
    thumbnail_url: z.string(),
  })
  .strict()
  .openapi('CullReviewRow');

export const CullReviewListResponse = z
  .object({
    data: z.array(CullReviewRow),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .strict()
  .openapi('CullReviewListResponse');

export const CullReviewSummaryResponse = z
  .object({
    not_passed_count: z.number().int(),
    sent_manually_count: z.number().int(),
    tab_counts: z.object({
      all: z.number().int(),
      culling_profile: z.number().int(),
      score_forecast: z.number().int(),
    }),
    last_checked_at: z.string().nullable(),
  })
  .strict()
  .openapi('CullReviewSummaryResponse');

export const ForecastByQuestion = z
  .object({
    name: z.string().openapi({ description: "The question's perspective's name, else the question's own" }),
    p8: z.number().nullable().openapi({ description: 'Null when excused' }),
    excused: z.boolean().openapi({ description: 'Its "applies?" question said it does not apply' }),
  })
  .strict();

export const CullReviewDetail = z
  .object({
    image_key: z.string(),
    filename: z.string(),
    filtered_by: z.enum(['culling_profile', 'score_forecast']).nullable(),
    score_forecast_p8: z.number().nullable(),
    profile: CullReviewProfileBlock,
    score_forecast: z.array(ForecastByQuestion),
    user_actions: z.array(
      z.object({
        action: CullUserActionSchema,
        acted_at: z.string(),
      }),
    ),
    completion: z.enum(['none', 'some', 'all']),
    needs_send_work: z.boolean(),
    sent_by_hand: z.boolean(),
    verdict: z.enum(['filtered', 'passed', 'pending']),
  })
  .strict()
  .openapi('CullReviewDetail');
