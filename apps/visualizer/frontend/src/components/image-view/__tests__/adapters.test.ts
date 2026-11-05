import { describe, it, expect } from 'vitest'
import { NULLABLE_BEST_PHOTO_FIELDS } from '../../../__test-utils__/identityFixtures'
import type { CatalogImageInput, IdentityBestPhotoItem } from '../../../services/api'
import {
  fromBestPhotoRow,
  fromCatalogListRow,
} from '../adapters'

describe('image-view adapters', () => {
  it('fromCatalogListRow does NOT zero identity fields when they are absent', () => {
    const row: CatalogImageInput = {
      id: 1,
      key: 'k',
      filename: 'f.jpg',
      filepath: '/tmp/f.jpg',
      date_taken: '2024-01-01',
      rating: 5,
      pick: false,
      color_label: '',
      keywords: ['a'],
      title: 't',
      caption: 'c',
      copyright: '',
      width: 100,
      height: 100,
      instagram_posted: false,
    }
    const out = fromCatalogListRow(row)
    expect(out.image_type).toBe('catalog')
    expect(out.key).toBe('k')
    // Critical: list rows don't carry identity data. Adapter must leave them
    // undefined so the modal can fill them via the detail endpoint rather
    // than rendering them as "0 / not scored".
    expect(out.identity_aggregate_score).toBeUndefined()
    expect(out.identity_per_perspective).toBeUndefined()
    expect(out.identity_perspectives_covered).toBeUndefined()
  })

  it('fromBestPhotoRow carries identity fields authoritatively', () => {
    const row: IdentityBestPhotoItem = {
      ...NULLABLE_BEST_PHOTO_FIELDS,
      image_key: 'bk',
      peak_percentile: 0.825,
      perspectives_covered: 3,
      eligible: true,
      per_perspective: [
        {
          perspective_slug: 'street',
          display_name: 'Street',
          score: 9,
          percentile: 0.825,
          prompt_version: 'v1',
          model_used: 'm',
          scored_at: 't',
          rationale_preview: '',
        },
      ],
      filename: 'bk.jpg',
      date_taken: '2024-02-02',
      rating: 5,
      instagram_posted: false,
    }
    const out = fromBestPhotoRow(row)
    expect(out.image_type).toBe('catalog')
    expect(out.key).toBe('bk')
    expect(out.identity_peak_percentile).toBe(0.825)
    expect(out.identity_perspectives_covered).toBe(3)
    expect(out.identity_eligible).toBe(true)
    expect(out.identity_per_perspective).toHaveLength(1)
  })
})
