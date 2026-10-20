import { z } from '@hono/zod-openapi';

export const CullUserActionSchema = z.enum(['sent_by_hand', 'agrees_with_cut', 'should_have_been_cut']);

export const DimensionHighlight = z
  .object({
    slug: z.string(),
    name: z.string(),
    levels: z.array(z.object({ level: z.number().int(), fails: z.boolean(), strong: z.boolean() })),
  })
  .strict();

export const CullReviewRecipeBlock = z
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
    cut_by: z.enum(['culling_recipe', 'score_forecast']),
    score_forecast_p8: z.number().nullable(),
    recipe: CullReviewRecipeBlock,
    completion: z.enum(['none', 'some', 'all']),
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
      culling_recipe: z.number().int(),
      score_forecast: z.number().int(),
    }),
    last_checked_at: z.string().nullable(),
  })
  .strict()
  .openapi('CullReviewSummaryResponse');

export const ForecastPerspective = z
  .object({
    name: z.string(),
    p8: z.number(),
  })
  .strict();

export const CullReviewDetail = z
  .object({
    image_key: z.string(),
    filename: z.string(),
    cut_by: z.enum(['culling_recipe', 'score_forecast']).nullable(),
    score_forecast_p8: z.number().nullable(),
    recipe: CullReviewRecipeBlock,
    score_forecast: z.array(ForecastPerspective),
    user_actions: z.array(
      z.object({
        action: CullUserActionSchema,
        acted_at: z.string(),
      }),
    ),
    completion: z.enum(['none', 'some', 'all']),
    sent_by_hand: z.boolean(),
    verdict: z.string(),
  })
  .strict()
  .openapi('CullReviewDetail');
