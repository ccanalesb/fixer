/**
 * Catalog browse, similarity, and image-detail API models.
 *
 * Every model here is `.strict()`. The catalog row is built from `SELECT i.*`, so
 * `.strict()` prevents new DB columns from leaking into the API unnoticed.
 */
import { z } from '@hono/zod-openapi';

export const IdentityPerPerspectiveScore = z
  .object({
    perspective_slug: z.string(),
    display_name: z.string(),
    score: z.int(),
    percentile: z.number().nullish(),
    prompt_version: z.string(),
    model_used: z.string(),
    scored_at: z.string(),
    rationale_preview: z.string(),
  })
  .strict()
  .openapi('IdentityPerPerspectiveScore');

/** Catalog list / search row shape (`queryCatalogImages` plus API transforms). */
export const CatalogImage = z
  .object({
    key: z.string(),
    id: z.int().nullish(),
    filename: z.string().nullish(),
    filepath: z.string().nullish(),
    date_taken: z.string().nullish(),
    rating: z.int().nullish(),
    pick: z.boolean().nullish(),
    color_label: z.string().nullish(),
    keywords: z.array(z.string()).default([]),
    title: z.string().nullish(),
    caption: z.string().nullish(),
    description: z.string().nullish(),
    copyright: z.string().nullish(),
    width: z.int().nullish(),
    height: z.int().nullish(),
    instagram_posted: z.boolean().nullish(),
    image_hash: z.string().nullish(),
    image_type: z.literal('catalog').nullish(),
    ai_analyzed: z.boolean().nullish(),
    description_summary: z.string().nullish(),
    description_best_perspective: z.string().nullish(),
    catalog_perspective_score: z.int().nullish(),
    catalog_score_perspective: z.string().nullish(),
    stack_id: z.int().nullish(),
    stack_member_count: z.int().nullish(),
    is_stack_representative: z.boolean().nullish(),
    analyzed_at: z.string().nullish(),
    aperture: z.string().nullish(),
    camera_make: z.string().nullish(),
    camera_model: z.string().nullish(),
    catalog_path: z.string().nullish(),
    exif: z.string().nullish(),
    file_size: z.int().nullish(),
    focal_length: z.string().nullish(),
    gps_latitude: z.number().nullish(),
    gps_longitude: z.number().nullish(),
    iso: z.string().nullish(),
    lens: z.string().nullish(),
    phash: z.string().nullish(),
    shutter_speed: z.string().nullish(),
    similarity: z.number().nullish(),
    why_matched: z.string().nullish(),
    thumbnail_url: z.string().nullish(),
    score: z.number().nullish(),
    cull_manually_sent: z.boolean().nullish(),
  })
  .strict()
  .openapi('CatalogImage');

export const InstagramPostedRequest = z
  .object({ posted: z.boolean() })
  .strict()
  .openapi('InstagramPostedRequest');

export const InstagramPostedResponse = z
  .object({ key: z.string(), instagram_posted: z.boolean() })
  .strict()
  .openapi('InstagramPostedResponse');

export const CatalogListResponse = z
  .object({ total: z.int(), images: z.array(CatalogImage) })
  .strict()
  .openapi('CatalogListResponse');

export const CatalogMonthsResponse = z
  .object({ months: z.array(z.string()) })
  .strict()
  .openapi('CatalogMonthsResponse');

export const ClipSimilarMeta = z
  .object({
    clip_model_id: z.string(),
    clip_embed_dim: z.int(),
    knn_fetched: z.int(),
    knn_k_used: z.int().nullish(),
  })
  .strict()
  .openapi('ClipSimilarMeta');

export const CatalogSimilarResponse = z
  .object({
    images: z.array(CatalogImage),
    total: z.int(),
    meta: ClipSimilarMeta,
  })
  .strict()
  .openapi('CatalogSimilarResponse');

export const CatalogSimilarityGroup = z
  .object({
    group_id: z.int(),
    seed: CatalogImage,
    candidates: z.array(CatalogImage),
    candidate_count: z.int(),
    best_similarity: z.number(),
    job_id: z.string().nullish(),
    created_at: z.string().nullish(),
  })
  .strict()
  .openapi('CatalogSimilarityGroup');

export const CatalogSimilarityGroupsResponse = z
  .object({ items: z.array(CatalogSimilarityGroup), total: z.int() })
  .strict()
  .openapi('CatalogSimilarityGroupsResponse');

/**
 * `GET /api/images/catalog/{image_key}` consolidated detail shape.
 *
 * Wider than `CatalogImage` and not a superset of it: the detail payload adds the
 * identity block and the raw `images` columns the grid does not need, and it drops
 * the similarity fields the grid adds. Several fields (`instagram_folder`,
 * `media_key`, `vision_result`) are vestiges of the retired Instagram scope, kept
 * because the frontend's generated types still reference the shape.
 */
export const ImageView = z
  .object({
    image_type: z.literal('catalog'),
    key: z.string(),
    id: z.int().nullish(),
    filename: z.string().nullish(),
    filepath: z.string().nullish(),
    local_path: z.string().nullish(),
    date_taken: z.string().nullish(),
    created_at: z.string().nullish(),
    rating: z.int().nullish(),
    pick: z.boolean().nullish(),
    color_label: z.string().nullish(),
    keywords: z.array(z.string()).nullish(),
    title: z.string().nullish(),
    caption: z.string().nullish(),
    copyright: z.string().nullish(),
    width: z.int().nullish(),
    height: z.int().nullish(),
    instagram_posted: z.boolean().nullish(),
    post_url: z.string().nullish(),
    image_hash: z.string().nullish(),
    stack_id: z.int().nullish(),
    stack_member_count: z.int().nullish(),
    is_stack_representative: z.boolean().nullish(),
    instagram_folder: z.string().nullish(),
    date_folder: z.string().nullish(),
    source_folder: z.string().nullish(),
    matched_catalog_key: z.string().nullish(),
    processed: z.boolean().nullish(),
    ai_analyzed: z.boolean().nullish(),
    description_summary: z.string().nullish(),
    description_best_perspective: z.string().nullish(),
    catalog_perspective_score: z.int().nullish(),
    catalog_score_perspective: z.string().nullish(),
    available_score_perspectives: z.array(z.string()).nullish(),
    identity_aggregate_score: z.number().nullish(),
    identity_peak_percentile: z.number().nullish(),
    identity_perspectives_covered: z.int().nullish(),
    identity_eligible: z.boolean().nullish(),
    identity_per_perspective: z.array(IdentityPerPerspectiveScore).default([]),
    analyzed_at: z.string().nullish(),
    aperture: z.string().nullish(),
    camera_make: z.string().nullish(),
    camera_model: z.string().nullish(),
    catalog_path: z.string().nullish(),
    description: z.string().nullish(),
    exif: z.string().nullish(),
    exif_data: z.unknown().nullish(),
    file_size: z.int().nullish(),
    focal_length: z.string().nullish(),
    gps_latitude: z.number().nullish(),
    gps_longitude: z.number().nullish(),
    iso: z.string().nullish(),
    lens: z.string().nullish(),
    phash: z.string().nullish(),
    shutter_speed: z.string().nullish(),
    added_at: z.string().nullish(),
    file_path: z.string().nullish(),
    last_attempted_at: z.string().nullish(),
    media_key: z.string().nullish(),
    processed_at: z.string().nullish(),
    vision_result: z.string().nullish(),
    vision_score: z.number().nullish(),
  })
  .strict()
  .openapi('ImageView');

export type CatalogImage = z.infer<typeof CatalogImage>;
export type ImageView = z.infer<typeof ImageView>;
