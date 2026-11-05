import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TopPhotosStrip } from '../TopPhotosStrip'
import { NULLABLE_BEST_PHOTO_FIELDS } from '../../../__test-utils__/identityFixtures'
import type { IdentityBestPhotoItem } from '../../../services/api'
import { deleteMatching } from '../../../data/cache'
import { CULL_MODAL_PREV } from '../../../constants/strings'
import {
  clickModalNav,
  clickTileByKey,
  expectModalFilename,
  mockImageDetailFilenames,
  mockImageDetailModalDeps,
  stepModalPrevNext,
} from '../../image-view/__tests__/modalNavTestUtils'

function stripItem(imageKey: string): IdentityBestPhotoItem {
  return {
    ...NULLABLE_BEST_PHOTO_FIELDS,
    image_key: imageKey,
    peak_percentile: 0.8,
    perspectives_covered: 1,
    eligible: null,
    per_perspective: [
      {
        perspective_slug: 'street',
        display_name: 'Street',
        score: 9,
        percentile: 0.8,
        prompt_version: 'v1',
        model_used: 'm',
        scored_at: 't',
        rationale_preview: '',
      },
    ],
    filename: `${imageKey}.jpg`,
    date_taken: '2024-01-01',
    rating: 0,
    instagram_posted: false,
  }
}

const item = stripItem('k-dash')

describe('TopPhotosStrip', () => {
  beforeEach(() => {
    deleteMatching(() => true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders dominant perspective label and score in the tile footer', () => {
    render(
      <TopPhotosStrip items={[item]} loading={false} error={null} emptyMessage={null} />,
    )
    expect(screen.getByText('Street 9')).toBeInTheDocument()
  })

  it('steps through strip photos with Prev / Next', async () => {
    const keys = ['top-a', 'top-b', 'top-c']
    mockImageDetailModalDeps()
    mockImageDetailFilenames(keys)

    render(
      <TopPhotosStrip
        items={keys.map(stripItem)}
        loading={false}
        error={null}
        emptyMessage={null}
      />,
    )

    clickTileByKey('top-b')
    await stepModalPrevNext('top-a.jpg', 'top-b.jpg', 'top-c.jpg')
  })

  it('stays on the photo stepped to when the strip reloads in a new order', async () => {
    const keys = ['top-a', 'top-b', 'top-c']
    mockImageDetailModalDeps()
    mockImageDetailFilenames(keys)

    const { rerender } = render(
      <TopPhotosStrip
        items={keys.map(stripItem)}
        loading={false}
        error={null}
        emptyMessage={null}
      />,
    )

    clickTileByKey('top-b')
    await expectModalFilename('top-b.jpg')
    clickModalNav('next')
    await expectModalFilename('top-c.jpg')

    rerender(
      <TopPhotosStrip
        items={['top-c', 'top-a', 'top-b'].map(stripItem)}
        loading={false}
        error={null}
        emptyMessage={null}
      />,
    )

    await expectModalFilename('top-c.jpg')
    expect(screen.getByRole('button', { name: new RegExp(CULL_MODAL_PREV) })).toBeDisabled()
  })
})
