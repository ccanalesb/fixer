import { z } from '@hono/zod-openapi';

export const CutRuleSchema = z.union([
  z.object({ type: z.literal('all_fail'), dimensions: z.array(z.string()) }).strict(),
  z.object({ type: z.literal('n_fail_unless_strong'), n: z.number().int() }).strict(),
  z.object({ type: z.literal('mean_fail') }).strict(),
]);

export const RecipeRuleSchema = z
  .object({
    level_sets: z.record(z.string(), z.object({ fails_at_most: z.number().int(), strong_at_least: z.number().int() })),
    combine: z.enum(['every', 'any']),
    cut_rule: CutRuleSchema,
  })
  .strict();

export const RecipeDefinitionSchema = z
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

export const CullRecipeSummary = z
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
  .openapi('CullRecipeSummary');

export const CullRecipeDetail = CullRecipeSummary.extend({
  definition: RecipeDefinitionSchema,
  rule: RecipeRuleSchema,
})
  .strict()
  .openapi('CullRecipeDetail');

export const CullRecipeListResponse = z
  .object({ recipes: z.array(CullRecipeSummary) })
  .strict()
  .openapi('CullRecipeListResponse');

export const ScoreForecastSettingSchema = z
  .object({
    enabled: z.boolean(),
    threshold: z.number(),
    high_from_level: z.number().int(),
    excused_at: z.number(),
    run_after_cut: z.boolean(),
  })
  .strict();

export const PipelineSettingResponse = z
  .object({
    version: z.number().int(),
    config: z.object({
      culling_recipes: z.array(
        z.object({
          recipe_slug: z.string(),
          rule: RecipeRuleSchema,
          run_after_cut: z.boolean(),
        }),
      ),
      score_forecast: ScoreForecastSettingSchema,
    }),
  })
  .strict()
  .openapi('PipelineSettingResponse');
