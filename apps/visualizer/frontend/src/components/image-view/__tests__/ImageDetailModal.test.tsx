import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type {
  CatalogImageInput,
  FrameSubstanceResponse,
  ImageDetailResponse,
  ImageView,
} from '../../../services/api'
import { deleteMatching } from '../../../data/cache'
import {
  CATALOG_STACK_CONFIRM_REP_TITLE,
  CATALOG_STACK_MAKE_REPRESENTATIVE,
  CULL_FILTERED,
  IMAGE_DETAILS_STACK_MEMBER_ARIA,
} from '../../../constants/strings'

vi.mock('../tabs/AiTab', () => ({
  AiTab: ({ imageKey }: { imageKey: string }) => (
    <div data-testid="ai-tab" data-key={imageKey} />
  ),
}))
vi.mock('../tabs/FileTab', () => ({
  FileTab: ({ onPostedChange }: { onPostedChange?: (posted: boolean) => void }) => (
    <div data-testid="file-tab">
      <button type="button" onClick={() => onPostedChange?.(true)}>mark-posted</button>
    </div>
  ),
}))
vi.mock('../tabs/LightroomTab', () => ({
  LightroomTab: () => <div data-testid="lightroom-tab" />,
}))
vi.mock('../tabs/CullingTab', () => ({
  CullingTab: () => <div data-testid="culling-tab" />,
}))

import { ImageDetailModal } from '../ImageDetailModal'
import { modalPropsFor } from '../modalView'
import { CullAPI, FrameSubstanceAPI, ImagesAPI } from '../../../services/api'

function buildDetail(overrides: Partial<ImageView> = {}): ImageDetailResponse {
  return {
    image_type: 'catalog',
    key: 'k1',
    filename: 'one.jpg',
    rating: 3,
    identity_aggregate_score: 7.2,
    identity_per_perspective: [],
    ...overrides,
  } as ImageDetailResponse
}

function buildCatalogImage(overrides: Partial<CatalogImageInput> = {}): CatalogImageInput {
  return {
    id: 1,
    key: 'k1',
    filename: 'one.jpg',
    filepath: '/one.jpg',
    date_taken: '2026-01-01',
    rating: 0,
    pick: false,
    color_label: '',
    keywords: [],
    title: '',
    caption: '',
    copyright: '',
    width: 100,
    height: 100,
    instagram_posted: false,
    ...overrides,
  }
}

function frame(overrides: Partial<FrameSubstanceResponse> = {}): FrameSubstanceResponse {
  return {
    image_key: 'k1',
    has_detection_run: true,
    verdict: 'ok',
    unknown_reason: null,
    detector_version: 'v1',
    judged_at: '2026-01-01T00:00:00Z',
    is_stale: false,
    has_override: false,
    flagged: false,
    instrument: null,
    restore_tier: null,
    ...overrides,
  }
}

const tabNames = () => screen.getAllByRole('tab').map((t) => t.textContent)

function renderModal(props: Partial<Parameters<typeof ImageDetailModal>[0]> = {}) {
  return render(
    <ImageDetailModal
      imageKey="k1"
      {...modalPropsFor('identity')}
      onClose={() => {}}
      {...props}
    />,
  )
}

describe('ImageDetailModal', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    vi.restoreAllMocks()
    vi.spyOn(FrameSubstanceAPI, 'get').mockResolvedValue(frame())
  })

  it('fetches detail on mount and opens on the AI tab', async () => {
    const spy = vi.spyOn(ImagesAPI, 'getImageDetail').mockResolvedValue(buildDetail())
    renderModal()

    expect(spy).toHaveBeenCalledWith('catalog', 'k1', undefined)
    expect((await screen.findByTestId('ai-tab')).dataset.key).toBe('k1')
    expect(tabNames()).toEqual(['AI', 'Lightroom', 'File'])
  })

  it('titles the modal with the filename', async () => {
    vi.spyOn(ImagesAPI, 'getImageDetail').mockResolvedValue(buildDetail({ filename: 'L1004434.DNG' }))
    renderModal()
    expect(await screen.findByRole('heading', { level: 2, name: /L1004434\.DNG/ })).toBeInTheDocument()
  })

  it('switches the panel when another tab is chosen', async () => {
    vi.spyOn(ImagesAPI, 'getImageDetail').mockResolvedValue(buildDetail())
    renderModal()
    await screen.findByTestId('ai-tab')
    fireEvent.click(screen.getByRole('tab', { name: 'Lightroom' }))
    expect(screen.getByTestId('lightroom-tab')).toBeInTheDocument()
    expect(screen.queryByTestId('ai-tab')).toBeNull()
  })

  it('does not expose on-demand visual similarity from the detail modal', async () => {
    vi.spyOn(ImagesAPI, 'getImageDetail').mockResolvedValue(buildDetail())
    renderModal()
    await screen.findByTestId('ai-tab')
    expect(screen.queryByRole('button', { name: /more like this/i })).toBeNull()
  })

  it('updates the Posted badge under the photo when the File tab toggles posted', async () => {
    vi.spyOn(ImagesAPI, 'getImageDetail').mockResolvedValue(buildDetail({ instagram_posted: false }))
    renderModal({ ...modalPropsFor('catalog'), initialTab: 'file' })
    await screen.findByTestId('file-tab')
    expect(screen.queryByText('Posted')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'mark-posted' }))
    expect(screen.getByText('Posted')).toBeInTheDocument()
  })

  it('shows the Culling tab outside culling views only when frame substance has something to say', async () => {
    vi.spyOn(ImagesAPI, 'getImageDetail').mockResolvedValue(buildDetail())
    vi.mocked(FrameSubstanceAPI.get).mockResolvedValue(
      frame({ verdict: 'void', flagged: true, restore_tier: 'A' }),
    )
    renderModal()
    await screen.findByTestId('ai-tab')
    expect(tabNames()).toEqual(['Culling', 'AI', 'Lightroom', 'File'])
    expect(screen.getByText('Void frame')).toBeInTheDocument()
  })

  it('opens culling views on the Culling tab, with the verdict under the photo', async () => {
    vi.spyOn(ImagesAPI, 'getImageDetail').mockResolvedValue(buildDetail())
    vi.spyOn(CullAPI, 'photoDetail').mockResolvedValue({
      image_key: 'k1',
      filename: 'one.jpg',
      verdict: 'filtered',
      sent_by_hand: false,
      completion: 'none',
      needs_send_work: true,
      score_forecast: [],
      profile: { slug: '', name: '', level_sets: [] },
      user_actions: [],
      filtered_by: 'culling_profile',
      score_forecast_p8: null,
    })
    renderModal({ ...modalPropsFor('culling') })
    expect(await screen.findByTestId('culling-tab')).toBeInTheDocument()
    expect(await screen.findByText(CULL_FILTERED)).toBeInTheDocument()
  })

  it('falls back to the first tab when the photo has no tab to open on', async () => {
    vi.spyOn(ImagesAPI, 'getImageDetail').mockResolvedValue(buildDetail())
    renderModal({ initialTab: 'stack' })
    expect(await screen.findByTestId('ai-tab')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /Stack/ })).toBeNull()
  })

  it('lets you pick another stack member and make it the representative', async () => {
    vi.spyOn(ImagesAPI, 'getImageDetail').mockResolvedValue(
      buildDetail({ stack_id: 42, stack_member_count: 2, is_stack_representative: true }),
    )
    vi.spyOn(ImagesAPI, 'getStackMembers').mockResolvedValue({
      items: [
        buildCatalogImage({ key: 'k1', filename: 'one.jpg', stack_id: 42, stack_member_count: 2, is_stack_representative: true }),
        buildCatalogImage({ id: 2, key: 'k2', filename: 'two.jpg', stack_id: 42, stack_member_count: 2, is_stack_representative: false }),
      ] as import('../../../services/api').CatalogImage[],
    })
    const repSpy = vi.spyOn(ImagesAPI, 'setStackRepresentative').mockResolvedValue({
      stack: { stack_id: 42, representative_key: 'k2', stack_member_count: 2, member_keys: ['k1', 'k2'] },
    })

    renderModal({ ...modalPropsFor('catalog'), initialTab: 'stack' })

    const other = await screen.findByRole('button', { name: IMAGE_DETAILS_STACK_MEMBER_ARIA('two.jpg') })
    expect(screen.queryByRole('button', { name: CATALOG_STACK_MAKE_REPRESENTATIVE })).toBeNull()
    fireEvent.click(other)
    fireEvent.click(screen.getByRole('button', { name: CATALOG_STACK_MAKE_REPRESENTATIVE }))
    expect(await screen.findByText(CATALOG_STACK_CONFIRM_REP_TITLE)).toBeInTheDocument()
    const confirmButtons = screen.getAllByRole('button', { name: CATALOG_STACK_MAKE_REPRESENTATIVE })
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!)

    await waitFor(() => expect(repSpy).toHaveBeenCalledWith(42, 'k2'))
  })

  it('passes score_perspective query when provided', async () => {
    const spy = vi
      .spyOn(ImagesAPI, 'getImageDetail')
      .mockResolvedValue(buildDetail({ catalog_perspective_score: 8 }))
    renderModal({ ...modalPropsFor('catalog'), scorePerspectiveSlug: 'street' })
    expect(spy).toHaveBeenCalledWith('catalog', 'k1', { score_perspective: 'street' })
    await screen.findByTestId('file-tab')
  })

  it('shows loading state while detail is in flight', () => {
    vi.spyOn(ImagesAPI, 'getImageDetail').mockReturnValue(new Promise(() => {}))
    renderModal()
    expect(screen.getByRole('status')).toHaveTextContent('Loading image details')
  })

  it('renders an error message when detail fetch rejects', async () => {
    vi.spyOn(ImagesAPI, 'getImageDetail').mockRejectedValue(new Error('boom'))
    renderModal()
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })

  it('has dialog role with aria-modal and a labelled title', async () => {
    vi.spyOn(ImagesAPI, 'getImageDetail').mockResolvedValue(buildDetail())
    renderModal()
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-labelledby')
  })

  it('ESC closes the modal', async () => {
    vi.spyOn(ImagesAPI, 'getImageDetail').mockResolvedValue(buildDetail())
    const onClose = vi.fn()
    renderModal({ onClose })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('backdrop click closes; inner click does not', async () => {
    vi.spyOn(ImagesAPI, 'getImageDetail').mockResolvedValue(buildDetail())
    const onClose = vi.fn()
    renderModal({ onClose })
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(dialog.parentElement as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(dialog)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders the backdrop on document.body so page layout cannot offset or clip it', async () => {
    vi.spyOn(ImagesAPI, 'getImageDetail').mockResolvedValue(buildDetail())
    const { container } = renderModal()
    const dialog = await screen.findByRole('dialog')
    expect(dialog.parentElement?.parentElement).toBe(document.body)
    expect(container.contains(dialog)).toBe(false)
  })

  it('Close button triggers onClose', async () => {
    vi.spyOn(ImagesAPI, 'getImageDetail').mockResolvedValue(buildDetail())
    const onClose = vi.fn()
    renderModal({ onClose })
    fireEvent.click(await screen.findByLabelText('Close'))
    expect(onClose).toHaveBeenCalled()
  })

  it('locks body scroll while mounted and restores on unmount', async () => {
    vi.spyOn(ImagesAPI, 'getImageDetail').mockResolvedValue(buildDetail())
    document.body.style.overflow = 'auto'
    const { unmount } = renderModal()
    expect(document.body.style.overflow).toBe('hidden')
    unmount()
    expect(document.body.style.overflow).toBe('auto')
  })

  it('dialog is a full-height sheet on mobile and a fixed-size large card from md', async () => {
    vi.spyOn(ImagesAPI, 'getImageDetail').mockResolvedValue(buildDetail())
    renderModal()
    const dialog = await screen.findByRole('dialog')
    expect(dialog.className).toContain('h-[100dvh]')
    expect(dialog.className).toContain('md:h-[92vh]')
    expect(dialog.className).toContain('md:w-[min(1400px,94vw)]')
  })

  it('scrolls the tab content on its own so the photo stays in view', async () => {
    vi.spyOn(ImagesAPI, 'getImageDetail').mockResolvedValue(buildDetail())
    renderModal()
    await screen.findByTestId('ai-tab')
    expect(screen.getByRole('tabpanel').className).toContain('overflow-y-auto')
  })
})
