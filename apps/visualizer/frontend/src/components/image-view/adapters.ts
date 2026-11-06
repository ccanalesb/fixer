/**
 * Adapters that normalize API row shapes into the canonical `ImageView`
 * superset used by the consolidated image-view module.
 *
 * Rules (consolidate-image-metadata plan):
 *   - Pure shape mapping, never invent data.
 *   - **Never zero out scores** for list rows that don't carry them —
 *     leave those fields `undefined` so tiles can render the right pill
 *     (or none) and the modal can authoritatively fill them via the
 *     detail endpoint.
 *   - The `GET /api/images/<type>/<key>` detail endpoint already returns
 *     the `ImageView` superset (`ImageDetailResponse = ImageView`), so no
 *     adapter is needed for that path — consumers assign the response
 *     directly. List adapters below omit identity fields.
 */

import type { CatalogImageInput, ImageView, IdentityBestPhotoItem } from '../../services/api'

export function fromCatalogListRow(row: CatalogImageInput): ImageView {
  return {
    image_type: 'catalog',
    key: row.key,
    id: row.id,
    filename: row.filename,
    filepath: row.filepath,
    date_taken: row.date_taken,
    rating: row.rating,
    pick: row.pick,
    color_label: row.color_label,
    keywords: row.keywords,
    title: row.title,
    caption: row.caption,
    copyright: row.copyright,
    width: row.width,
    height: row.height,
    instagram_posted: row.instagram_posted,
    image_hash: row.image_hash,
    ai_analyzed: row.ai_analyzed,
    description_summary: row.description_summary,
    description_best_perspective: row.description_best_perspective,
    catalog_perspective_score: row.catalog_perspective_score,
    catalog_score_perspective: row.catalog_score_perspective ?? null,
    stack_id: row.stack_id,
    stack_member_count: row.stack_member_count,
    is_stack_representative: row.is_stack_representative,
    catalog_missing_since: row.catalog_missing_since ?? null,
    // Identity fields intentionally omitted — list does not carry them.
  }
}

export function fromBestPhotoRow(row: IdentityBestPhotoItem): ImageView {
  return {
    image_type: 'catalog',
    key: row.image_key,
    filename: row.filename,
    date_taken: row.date_taken,
    rating: row.rating,
    instagram_posted: row.instagram_posted,
    stack_id: row.stack_id,
    stack_member_count: row.stack_member_count,
    is_stack_representative: row.is_stack_representative,
    // Identity fields are authoritative on this endpoint.
    identity_peak_percentile: row.peak_percentile,
    identity_perspectives_covered: row.perspectives_covered,
    identity_eligible: row.eligible,
    identity_per_perspective: row.per_perspective,
  }
}

