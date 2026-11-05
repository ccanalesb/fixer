import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MirrorPanel } from '../MirrorPanel'
import { IdentityAPI, type MirrorExemplar, type MirrorResponse } from '../../../services/api'
import { deleteMatching } from '../../../data/cache'
import { EMPTY_MIRROR_META } from '../../../__test-utils__/identityFixtures'
import {
  clickModalNav,
  expectModalFilename,
  mockImageDetailFilenames,
  mockImageDetailModalDeps,
} from '../../image-view/__tests__/modalNavTestUtils'

function exemplar(imageKey: string, percentile: number): MirrorExemplar {
  return {
    image_key: imageKey,
    filename: `${imageKey}.jpg`,
    date_taken: '2024-01-01',
    rating: 3,
    instagram_posted: false,
    score: 9,
    percentile,
    purity: 1,
    rationale_preview: '',
    per_perspective: [],
    stack_id: null,
    stack_size: null,
  }
}

function mirrorPayload(): MirrorResponse {
  return {
    population: 100,
    sections: [
      {
        perspective_slug: 'street',
        display_name: 'Street',
        win_rate: 0.5,
        chance_rate: 0.2,
        z_score: 2,
        strength_label: 'Leading',
        leading_not_distinctive: false,
        crowned: true,
        votes: 10,
        photos_on: 50,
        low_coverage: false,
        coverage: 0.8,
        descriptors: [],
        exemplars: [exemplar('mir-a', 95), exemplar('mir-b', 90), exemplar('mir-c', 85)],
        exemplar_total: 3,
      },
      {
        perspective_slug: 'land',
        display_name: 'Landscape',
        win_rate: 0.4,
        chance_rate: 0.2,
        z_score: 1,
        strength_label: 'Strong',
        leading_not_distinctive: true,
        crowned: false,
        votes: 5,
        photos_on: 40,
        low_coverage: false,
        coverage: 0.7,
        descriptors: [],
        exemplars: [exemplar('other-a', 80), exemplar('other-b', 75)],
        exemplar_total: 2,
      },
    ],
    other_lenses: [],
    meta: EMPTY_MIRROR_META,
  }
}

describe('MirrorPanel', () => {
  beforeEach(() => {
    deleteMatching(() => true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('steps through exemplars in the opened section only', async () => {
    vi.spyOn(IdentityAPI, 'getMirror').mockResolvedValue(mirrorPayload())
    mockImageDetailModalDeps()
    mockImageDetailFilenames(['mir-a', 'mir-b', 'mir-c', 'other-a', 'other-b'])

    render(<MirrorPanel />)

    await waitFor(() => {
      expect(screen.getByText('Street')).toBeInTheDocument()
    })

    const streetSection = screen.getByRole('heading', { level: 3, name: 'Street' }).closest('section')
    if (!streetSection) throw new Error('street section missing')
    const rank = within(streetSection).getByText('#2')
    const streetRail = rank.closest('button')
    if (!streetRail) throw new Error('exemplar button missing')
    fireEvent.click(streetRail)

    await expectModalFilename('mir-b.jpg')
    clickModalNav('next')
    await expectModalFilename('mir-c.jpg')
    clickModalNav('prev')
    clickModalNav('prev')
    await expectModalFilename('mir-a.jpg')

    clickModalNav('next')
    clickModalNav('next')
    await expectModalFilename('mir-c.jpg')
    expect(screen.queryByRole('heading', { level: 2, name: /other-a\.jpg/ })).toBeNull()
  })
})
