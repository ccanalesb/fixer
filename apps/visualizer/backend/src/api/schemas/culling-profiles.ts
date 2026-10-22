import { z } from '@hono/zod-openapi';

export const FilterRuleSchema = z.union([
  z.object({ type: z.literal('all_fail'), dimensions: z.array(z.string()) }).strict(),
  z.object({ type: z.literal('n_fail_unless_strong'), n: z.number().int() }).strict(),
  z.object({ type: z.literal('mean_fail') }).strict(),
]);

export const ProfileRuleSchema = z
  .object({
    level_sets: z.record(z.string(), z.object({ fails_at_most: z.number().int(), strong_at_least: z.number().int() })),
    combine: z.enum(['every', 'any']),
    filter_rule: FilterRuleSchema,
    stars_strong_from: z.enum(['7', '10', 'every', 'any']).optional(),
  })
  .strict();

export const ProfileDefinitionSchema = z
  .object({
    dimensions: z.array(z.object({ slug: z.string(), name: z.string(), question: z.string() })),
    level_sets: z.array(
      z.object({
        id: z.string(),
        levels: z.record(z.string(), z.array(z.string())),
      }),
    ),
  })
  .strict();

export const CullProfileSummary = z
  .object({
    slug: z.string(),
    name: z.string(),
    model: z.string(),
    active: z.boolean(),
    measured: z.boolean(),
    version: z.number().int(),
    in_pipeline: z.boolean(),
    pipeline_order: z.number().int().nullable(),
  })
  .strict()
  .openapi('CullProfileSummary');

export const CullProfileDetail = CullProfileSummary.extend({
  definition: ProfileDefinitionSchema,
  rule: ProfileRuleSchema,
})
  .strict()
  .openapi('CullProfileDetail');

export const CullProfileListResponse = z
  .object({ profiles: z.array(CullProfileSummary) })
  .strict()
  .openapi('CullProfileListResponse');

export const ScoreForecastSettingSchema = z
  .object({
    enabled: z.boolean(),
    threshold: z.number(),
    high_from_level: z.number().int(),
    excused_at: z.number(),
  })
  .strict();

export const PipelineSettingResponse = z
  .object({
    version: z.number().int(),
    config: z.object({
      culling_profiles_enabled: z.boolean(),
      culling_profiles_filter_enabled: z.boolean(),
      culling_profiles: z.array(
        z.object({
          profile_slug: z.string(),
          rule: ProfileRuleSchema,
        }),
      ),
      score_forecast: ScoreForecastSettingSchema,
    }),
  })
  .strict()
  .openapi('PipelineSettingResponse');
