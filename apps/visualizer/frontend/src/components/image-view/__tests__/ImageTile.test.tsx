import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useRef } from 'react'
import type { ImageView } from '../../../services/api'
import { CATALOG_CHIP_FILE_MISSING } from '../../../constants/strings'
import { ImageTile } from '../ImageTile'
import { Badge } from '../../ui/badges'

type IoCallback = IntersectionObserverCallback

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = []
  callback: IoCallback
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()

  constructor(callback: IoCallback) {
    this.callback = callback
    MockIntersectionObserver.instances.push(this)
  }

  trigger(isIntersecting: boolean, target: Element) {
    this.callback(
      [{ isIntersecting, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
}

function StripInScroller() {
  const scrollRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={scrollRef} data-testid="scroll-root" className="overflow-x-auto">
      <ImageTile
        image={baseImage()}
        variant="strip"
        primaryScoreSource="identity"
        scrollContainerRef={scrollRef}
        onClick={() => {}}
      />
    </div>
  )
}

function baseImage(overrides: Partial<ImageView> = {}): ImageView {
  return {
    image_type: 'catalog',
    key: 'abc',
    filename: 'img.jpg',
    date_taken: '2024-05-01T00:00:00Z',
    ...overrides,
  }
}

describe('ImageTile', () => {
  beforeEach(() => {
    MockIntersectionObserver.instances = []
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defers strip thumbnail src until intersection when scrollContainerRef is set', () => {
    render(<StripInScroller />)

    const img = screen.getByRole('img', { name: 'img.jpg' })
    expect(img).not.toHaveAttribute('src')
    expect(img).not.toHaveAttribute('loading')

    const observer = MockIntersectionObserver.instances[0]
    act(() => {
      observer.trigger(true, img)
    })
    expect(img).toHaveAttribute('src', '/api/images/catalog/abc/thumbnail')
  })

  it('renders filename, falling back to key', () => {
    render(
      <ImageTile
        image={baseImage({ filename: undefined })}
        variant="grid"
        primaryScoreSource="none"
        onClick={() => {}}
      />,
    )
    expect(screen.getByText('abc')).toBeInTheDocument()
  })

  it('invokes onClick when the thumbnail button is clicked', () => {
    const onClick = vi.fn()
    render(
      <ImageTile
        image={baseImage()}
        variant="grid"
        primaryScoreSource="none"
        onClick={onClick}
      />,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders subtitle prop over image.title when both present', () => {
    render(
      <ImageTile
        image={baseImage({ title: 'Img title' })}
        subtitle="explicit subtitle"
        variant="grid"
        primaryScoreSource="none"
        onClick={() => {}}
      />,
    )
    expect(screen.getByText('explicit subtitle')).toBeInTheDocument()
    expect(screen.queryByText('Img title')).toBeNull()
  })

  it('renders identity aggregate pill when source=identity', () => {
    render(
      <ImageTile
        image={baseImage({ identity_aggregate_score: 8.2 })}
        variant="compact"
        primaryScoreSource="identity"
        onClick={() => {}}
      />,
    )
    expect(screen.getByLabelText('Aggregate score 8.2')).toBeInTheDocument()
  })

  it('overlayBadges slot renders on top-right of thumbnail', () => {
    render(
      <ImageTile
        image={{ ...baseImage(), image_type: 'instagram' } as unknown as ImageView}
        variant="grid"
        primaryScoreSource="none"
        overlayBadges={<Badge variant="success">Matched</Badge>}
        onClick={() => {}}
      />,
    )
    expect(screen.getByText('Matched')).toBeInTheDocument()
  })

  it('auto-renders the stack-count badge when image is a stack representative with members', () => {
    render(
      <ImageTile
        image={baseImage({
          stack_id: 7,
          stack_member_count: 4,
          is_stack_representative: true,
        })}
        variant="grid"
        primaryScoreSource="none"
        onClick={() => {}}
      />,
    )
    expect(screen.getByText('4 in stack')).toBeInTheDocument()
  })

  it('does not render the stack badge for non-representative members', () => {
    render(
      <ImageTile
        image={baseImage({
          stack_id: 7,
          stack_member_count: 4,
          is_stack_representative: false,
        })}
        variant="grid"
        primaryScoreSource="none"
        onClick={() => {}}
      />,
    )
    expect(screen.queryByText(/in stack$/)).toBeNull()
  })

  it('does not render the stack badge for solo stacks (count <= 1)', () => {
    render(
      <ImageTile
        image={baseImage({
          stack_id: 7,
          stack_member_count: 1,
          is_stack_representative: true,
        })}
        variant="grid"
        primaryScoreSource="none"
        onClick={() => {}}
      />,
    )
    expect(screen.queryByText(/in stack$/)).toBeNull()
  })

  it('renders caller overlay alongside the auto stack badge', () => {
    render(
      <ImageTile
        image={baseImage({
          stack_id: 7,
          stack_member_count: 3,
          is_stack_representative: true,
        })}
        variant="grid"
        primaryScoreSource="none"
        overlayBadges={<Badge variant="success">Posted</Badge>}
        onClick={() => {}}
      />,
    )
    expect(screen.getByText('Posted')).toBeInTheDocument()
    expect(screen.getByText('3 in stack')).toBeInTheDocument()
  })

  it('footer slot renders beneath metadata badges', () => {
    render(
      <ImageTile
        image={baseImage()}
        variant="list"
        primaryScoreSource="identity"
        footer={<div data-testid="reasons">reason bullets</div>}
        onClick={() => {}}
      />,
    )
    expect(screen.getByTestId('reasons')).toBeInTheDocument()
  })

  it('strip variant applies fixed width root class', () => {
    const { container } = render(
      <ImageTile
        image={baseImage()}
        variant="strip"
        primaryScoreSource="identity"
        onClick={() => {}}
      />,
    )
    expect((container.firstChild as HTMLElement).className).toContain('w-[200px]')
  })

  it('grid variant uses aspect-square thumb', () => {
    const { container } = render(
      <ImageTile
        image={baseImage()}
        variant="grid"
        primaryScoreSource="none"
        onClick={() => {}}
      />,
    )
    const thumb = container.querySelector('.aspect-square')
    expect(thumb).not.toBeNull()
  })

  it('falls back to created_at for date display when date_taken missing', () => {
    render(
      <ImageTile
        image={baseImage({
          date_taken: undefined,
          created_at: '2024-06-15T00:00:00Z',
        })}
        variant="grid"
        primaryScoreSource="none"
        onClick={() => {}}
      />,
    )
    const expected = new Date('2024-06-15T00:00:00Z').toLocaleDateString()
    expect(screen.getByText(expected)).toBeInTheDocument()
  })

  it('greys a tile and shows a file-missing chip when catalog_missing_since is set', () => {
    const { container } = render(
      <ImageTile
        image={baseImage({ catalog_missing_since: '2026-11-01T00:00:00Z' })}
        variant="grid"
        primaryScoreSource="none"
        catalogKind="folder"
        onClick={() => {}}
      />,
    )
    expect(screen.getByText(CATALOG_CHIP_FILE_MISSING)).toBeInTheDocument()
    expect(container.querySelector('.grayscale')).not.toBeNull()
  })
})
