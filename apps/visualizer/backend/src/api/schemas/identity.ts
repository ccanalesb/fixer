/**
 * Identity API response models.
 *
 * `IdentityBestPhotoItem` includes `ranking_percentile`, `corroboration_revoked`
 * and `corroboration_revoked_by` — fields the ranking function returns that
 * must be declared or response validation rejects the payload.
 */
import { z } from '@hono/zod-openapi';
import { IdentityPerPerspectiveScore } from './catalog.js';

export const IdentityBestPhotoItem = z
  .object({
    image_key: z.string(),
    image_type: z.literal('catalog').nullish(),
    peak_percentile: z.number(),
    ranking_percentile: z.number(),
    corroboration_revoked: z.boolean(),
    corroboration_revoked_by: z.string(),
    perspectives_covered: z.int(),
    eligible: z.boolean().nullish(),
    per_perspective: z.array(IdentityPerPerspectiveScore),
    filename: z.string(),
    date_taken: z.string(),
    rating: z.int(),
    instagram_posted: z.boolean(),
    stack_id: z.int().nullish(),
    stack_member_count: z.int().nullish(),
    is_stack_representative: z.boolean().nullish(),
  })
  .strict()
  .openapi('IdentityBestPhotoItem');

export const IdentityBestPhotosMeta = z
  .object({
    active_perspectives: z.array(z.string()).nullish(),
    weighting: z.string().nullish(),
    ranking_key: z.string().nullish(),
    corroboration_rule: z.string().nullish(),
    min_perspectives_used: z.int().nullish(),
    coverage_rule: z.string().nullish(),
    total_catalog_images: z.int().nullish(),
    eligible_count: z.int().nullish(),
    scored_any_count: z.int().nullish(),
    coverage_note: z.string().nullish(),
  })
  .strict()
  .openapi('IdentityBestPhotosMeta');

export const IdentityBestPhotosResponse = z
  .object({
    items: z.array(IdentityBestPhotoItem),
    total: z.int(),
    meta: IdentityBestPhotosMeta,
  })
  .strict()
  .openapi('IdentityBestPhotosResponse');

export const MirrorDescriptor = z
  .object({ token: z.string(), log_odds: z.number(), count: z.int() })
  .strict()
  .openapi('MirrorDescriptor');

export const MirrorExemplarPerPerspective = z
  .object({
    perspective_slug: z.string(),
    display_name: z.string(),
    score: z.int(),
    percentile: z.number(),
  })
  .strict()
  .openapi('MirrorExemplarPerPerspective');

export const MirrorExemplar = z
  .object({
    image_key: z.string(),
    filename: z.string(),
    date_taken: z.string(),
    rating: z.int(),
    instagram_posted: z.boolean(),
    score: z.int(),
    percentile: z.number(),
    purity: z.number(),
    rationale_preview: z.string(),
    per_perspective: z.array(MirrorExemplarPerPerspective),
    stack_id: z.int().nullish(),
    stack_size: z.int().nullish(),
  })
  .strict()
  .openapi('MirrorExemplar');

export const MirrorTechniqueSection = z
  .object({
    perspective_slug: z.string(),
    display_name: z.string(),
    strength_label: z.string(),
    leading_not_distinctive: z.boolean(),
    crowned: z.boolean(),
    win_rate: z.number(),
    chance_rate: z.number(),
    z_score: z.number(),
    votes: z.int(),
    photos_on: z.int(),
    coverage: z.number(),
    low_coverage: z.boolean(),
    descriptors: z.array(MirrorDescriptor),
    exemplars: z.array(MirrorExemplar),
    exemplar_total: z.int(),
  })
  .strict()
  .openapi('MirrorTechniqueSection');

export const MirrorOtherLens = z
  .object({
    perspective_slug: z.string(),
    display_name: z.string(),
    strength_label: z.string(),
    win_rate: z.number(),
    chance_rate: z.number(),
    z_score: z.number(),
    coverage: z.number(),
    low_coverage: z.boolean(),
    votes: z.int(),
    photos_on: z.int(),
    exemplar_total: z.int(),
  })
  .strict()
  .openapi('MirrorOtherLens');

export const MirrorMeta = z
  .object({
    active_perspectives: z.array(z.string()).nullish(),
    total_catalog_images: z.int().nullish(),
    voting_rule: z.string().nullish(),
    crowning_rule: z.string().nullish(),
    low_coverage_threshold: z.number().nullish(),
    exemplar_initial_limit: z.int().nullish(),
    exemplar_page_size: z.int().nullish(),
    descriptor_min_count: z.int().nullish(),
    scores_are_advisory: z.string().nullish(),
    fallback_active: z.boolean().nullish(),
  })
  .strict()
  .openapi('MirrorMeta');

export const MirrorResponse = z
  .object({
    population: z.int(),
    sections: z.array(MirrorTechniqueSection),
    other_lenses: z.array(MirrorOtherLens),
    meta: MirrorMeta,
  })
  .strict()
  .openapi('MirrorResponse');

export const MirrorLensExemplarsResponse = z
  .object({ items: z.array(MirrorExemplar), total: z.int() })
  .strict()
  .openapi('MirrorLensExemplarsResponse');

export const PostNextCandidate = z
  .object({
    image_key: z.string(),
    image_type: z.literal('catalog').nullish(),
    filename: z.string(),
    date_taken: z.string(),
    rating: z.int(),
    peak_percentile: z.number(),
    peak_perspective_slug: z.string(),
    peak_perspective_display_name: z.string(),
    is_signature: z.boolean(),
    perspectives_covered: z.int(),
    per_perspective: z.array(IdentityPerPerspectiveScore),
    reasons: z.array(z.string()),
    reason_codes: z.array(z.string()),
  })
  .strict()
  .openapi('PostNextCandidate');

export const PostNextSuggestionsMeta = z
  .object({
    weighting: z.string().nullish(),
    ranking_key: z.string().nullish(),
    corroboration_rule: z.string().nullish(),
    min_perspectives_used: z.int().nullish(),
    coverage_rule: z.string().nullish(),
    high_score_rule: z.string().nullish(),
  })
  .strict()
  .openapi('PostNextSuggestionsMeta');

export const PostNextSuggestionsResponse = z
  .object({
    candidates: z.array(PostNextCandidate),
    total: z.int(),
    meta: PostNextSuggestionsMeta,
    empty_state: z.string().nullish(),
  })
  .strict()
  .openapi('PostNextSuggestionsResponse');
