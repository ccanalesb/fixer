import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ImageView } from '../../../services/api'
import { ImageMetadataBadges } from '../ImageMetadataBadges'

function baseImage(overrides: Partial<ImageView> = {}): ImageView {
  return {
    image_type: 'catalog',
    key: 'k',
    ...overrides,
  }
}

describe('ImageMetadataBadges', () => {
  it('shows a rejected chip for pick -1 and pick only for pick 1', () => {
    const { rerender } = render(
      <ImageMetadataBadges image={baseImage({ pick: -1 as unknown as boolean })} primaryScoreSource="none" />,
    )
    expect(screen.getByText('✕ Rejected')).toBeInTheDocument()
    expect(screen.queryByText('Pick')).not.toBeInTheDocument()

    rerender(<ImageMetadataBadges image={baseImage({ pick: 1 as unknown as boolean })} primaryScoreSource="none" />)
    expect(screen.getByText('Pick')).toBeInTheDocument()
    expect(screen.queryByText('✕ Rejected')).not.toBeInTheDocument()
  })

  it('renders rating, pick, posted, AI chips when flags are set', () => {
    render(
      <ImageMetadataBadges
        image={baseImage({
          rating: 4,
          pick: true,
          instagram_posted: true,
          ai_analyzed: true,
        })}
        primaryScoreSource="none"
      />,
    )
    expect(screen.getByText('Posted')).toBeInTheDocument()
    expect(screen.getByText('4★')).toBeInTheDocument()
    expect(screen.getByText('Pick')).toBeInTheDocument()
    expect(screen.getByText('AI')).toBeInTheDocument()
  })

  it('omits rating chip when rating is 0 or missing', () => {
    render(
      <ImageMetadataBadges
        image={baseImage({ rating: 0 })}
        primaryScoreSource="none"
      />,
    )
    expect(screen.queryByText(/★/)).toBeNull()
  })

  it('identity source shows aggregate pill when identity score is present', () => {
    render(
      <ImageMetadataBadges
        image={baseImage({ identity_aggregate_score: 7.3 })}
        primaryScoreSource="identity"
      />,
    )
    expect(screen.getByLabelText('Aggregate score 7.3')).toBeInTheDocument()
  })

  it('identity source omits pill entirely when no identity score', () => {
    const { container } = render(
      <ImageMetadataBadges
        image={baseImage({ identity_aggregate_score: null })}
        primaryScoreSource="identity"
      />,
    )
    expect(container.querySelector('[aria-label^="Aggregate score"]')).toBeNull()
  })

  it('catalog source prefers catalog_perspective_score with slug label', () => {
    render(
      <ImageMetadataBadges
        image={baseImage({
          catalog_perspective_score: 8,
          catalog_score_perspective: 'street',
        })}
        primaryScoreSource="catalog"
      />,
    )
    expect(screen.getByLabelText('street score 8')).toBeInTheDocument()
  })

  it('catalog source does not fall back to description best-perspective score', () => {
    const { container } = render(
      <ImageMetadataBadges
        image={baseImage({
          description_best_perspective: 'street',
        })}
        primaryScoreSource="catalog"
      />,
    )
    expect(container.querySelector('[aria-label^="street score"]')).toBeNull()
    expect(container.querySelector('[aria-label$="score 6"]')).toBeNull()
  })

  it('hidePrimaryScore suppresses the pill even when source would render one', () => {
    render(
      <ImageMetadataBadges
        image={baseImage({ identity_aggregate_score: 9 })}
        primaryScoreSource="identity"
        hidePrimaryScore
      />,
    )
    expect(screen.queryByLabelText(/score/)).toBeNull()
  })
})
