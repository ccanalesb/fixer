import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ImageView } from '../../services/api'
import { CullAPI, ImagesAPI } from '../../services/api'
import { useBodyScrollLock, useFocusTrap } from '../../hooks'
import {
  CULL_FILTERED,
  CULL_MODAL_NEXT,
  CULL_MODAL_PREV,
  CULL_PASSED,
  CULL_SENT_BY_HAND,
  FRAME_SUBSTANCE_CHIP,
  IMAGE_DETAILS_TAB_AI,
  IMAGE_DETAILS_TAB_CULLING,
  IMAGE_DETAILS_TAB_FILE,
  IMAGE_DETAILS_TAB_LIGHTROOM,
  IMAGE_DETAILS_TAB_STACK,
} from '../../constants/strings'
import { Button } from '../ui/Button/Button'
import { Badge } from '../ui/badges'
import { TabNav, type TabNavItem } from '../ui/Tabs'
import { ImageMetadataBadges, type PrimaryScoreSource } from './ImageMetadataBadges'
import { ModalCloseButton } from './ModalCloseButton'
import { AiTab } from './tabs/AiTab'
import { CullingTab } from './tabs/CullingTab'
import { FileTab } from './tabs/FileTab'
import { LightroomTab } from './tabs/LightroomTab'
import { StackTab } from './tabs/StackTab'
import { frameHeldBack, frameSaysNothing, frameSubstanceQuery } from './tabs/frameSubstance'
import { ErrorBoundary, ErrorState, keys, retryImageDetail, stacksChanged, useQuery } from '../../data'

export type ImageDetailTab = 'culling' | 'ai' | 'lightroom' | 'file' | 'stack'

interface ImageDetailModalProps {
  imageKey: string
  /** Header primary-score source (CONTEXT Q3). */
  primaryScoreSource: PrimaryScoreSource
  /** When set, catalog detail calls request `?score_perspective=<slug>`
   *  so the header pill shows the same slug the tile used. */
  scorePerspectiveSlug?: string
  /** Optional content rendered above the detail body (e.g. Mirror standout). */
  contextSlot?: ReactNode
  /** When set, the Culling tab loads `/api/cull/photos/{key}` and shows the verdict. */
  showCullSection?: boolean
  /** Tab to open on; falls back to the first tab the photo has. Defaults to Culling in culling views, else AI. */
  initialTab?: ImageDetailTab
  /** Prev / next within a cull review or catalog list. */
  nav?: {
    keys: string[]
    index: number
    onIndexChange: (index: number) => void
  }
  onClose: () => void
}

type DetailSource = Pick<ImageDetailModalProps, 'imageKey' | 'scorePerspectiveSlug'>

const detailKeyOf = ({ imageKey, scorePerspectiveSlug }: DetailSource) =>
  keys.images.detail('catalog', imageKey, scorePerspectiveSlug)

function useImageDetail({ imageKey, scorePerspectiveSlug }: DetailSource) {
  return useQuery(detailKeyOf({ imageKey, scorePerspectiveSlug }), () =>
    ImagesAPI.getImageDetail(
      'catalog',
      imageKey,
      scorePerspectiveSlug ? { score_perspective: scorePerspectiveSlug } : undefined,
    ),
  )
}

function TitleText({ image, imageKey }: { image?: ImageView; imageKey: string }) {
  return (
    <>
      {image?.filename ?? imageKey}
      {image?.date_taken ? (
        <span className="ml-2 text-xs font-normal text-text-tertiary">
          {new Date(image.date_taken).toLocaleString()}
        </span>
      ) : null}
    </>
  )
}

function LoadedTitle(props: DetailSource) {
  const image = useImageDetail(props)
  return <TitleText image={image} imageKey={props.imageKey} />
}

function PhotoView({ imageKey, alt }: { imageKey: string; alt: string }) {
  return (
    <div className="h-[34dvh] overflow-hidden rounded-base bg-surface md:h-auto md:min-h-0 md:flex-1">
      <img
        src={`/api/images/catalog/${encodeURIComponent(imageKey)}/thumbnail`}
        alt={alt}
        className="h-full w-full object-contain"
      />
    </div>
  )
}

/**
 * Photo column and tab column. On mobile the photo stays pinned on top and the
 * tabs scroll under it; from `md` the two sit side by side at the dialog's full
 * height and only the tab content scrolls.
 */
function DetailLayout({ photo, panel }: { photo: ReactNode; panel: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col md:grid md:grid-cols-[3fr_2fr] md:grid-rows-[minmax(0,1fr)] md:gap-6 md:p-6">
      <div className="flex flex-none flex-col gap-3 px-4 pb-3 pt-4 md:min-h-0 md:p-0">{photo}</div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col px-4 pb-4 md:p-0">{panel}</div>
    </div>
  )
}

function CullVerdictBadge({ imageKey }: { imageKey: string }) {
  const detail = useQuery(keys.cull.detail(imageKey), () => CullAPI.photoDetail(imageKey))
  if (detail.sent_by_hand) return <Badge variant="accent">{CULL_SENT_BY_HAND}</Badge>
  if (detail.verdict === 'passed') return <Badge variant="success">{CULL_PASSED}</Badge>
  return <Badge variant="warning">{CULL_FILTERED}</Badge>
}

function ImageDetailModalFallback({ imageKey }: { imageKey: string }) {
  return (
    <DetailLayout
      photo={<PhotoView imageKey={imageKey} alt={imageKey} />}
      panel={
        <p className="text-sm text-text-tertiary" role="status" aria-live="polite">
          Loading image details…
        </p>
      }
    />
  )
}

function ImageDetailModalBody({
  imageKey,
  primaryScoreSource,
  scorePerspectiveSlug,
  showCullSection = false,
  tab,
  onTabChange,
}: DetailSource & {
  primaryScoreSource: PrimaryScoreSource
  showCullSection?: boolean
  tab: ImageDetailTab
  onTabChange: (tab: ImageDetailTab) => void
}) {
  const image = useImageDetail({ imageKey, scorePerspectiveSlug })
  const frame = useQuery(...frameSubstanceQuery(imageKey))

  const [postedOverride, setPostedOverride] = useState<boolean | null>(null)
  useEffect(() => {
    setPostedOverride(null)
  }, [imageKey])
  const displayImage = postedOverride !== null ? { ...image, instagram_posted: postedOverride } : image

  const stackId = image.stack_id != null ? Number(image.stack_id) : null
  const stackSize = image.stack_member_count ?? 0
  const hasStack = stackId != null && !Number.isNaN(stackId) && stackSize >= 2

  const tabs: (TabNavItem & { id: ImageDetailTab })[] = [
    ...(showCullSection || !frameSaysNothing(frame)
      ? [{ id: 'culling' as const, label: IMAGE_DETAILS_TAB_CULLING }]
      : []),
    { id: 'ai', label: IMAGE_DETAILS_TAB_AI },
    { id: 'lightroom', label: IMAGE_DETAILS_TAB_LIGHTROOM },
    { id: 'file', label: IMAGE_DETAILS_TAB_FILE },
    ...(hasStack ? [{ id: 'stack' as const, label: IMAGE_DETAILS_TAB_STACK(stackSize) }] : []),
  ]
  const active = tabs.some((t) => t.id === tab) ? tab : tabs[0]!.id

  const panel: Record<ImageDetailTab, () => ReactNode> = {
    culling: () => (
      <CullingTab imageKey={imageKey} showVerdict={showCullSection} />
    ),
    ai: () => <AiTab imageKey={imageKey} />,
    lightroom: () => <LightroomTab image={displayImage} />,
    file: () => <FileTab image={displayImage} onPostedChange={setPostedOverride} />,
    stack: () => (hasStack ? <StackTab stackId={stackId} imageKey={imageKey} /> : null),
  }

  return (
    <DetailLayout
      photo={
        <>
          <PhotoView imageKey={imageKey} alt={image.filename ?? imageKey} />
          <div className="flex flex-none flex-wrap items-center gap-2">
            {showCullSection ? (
              <ErrorBoundary resetKeys={[imageKey]} fallback={() => null}>
                <Suspense fallback={null}>
                  <CullVerdictBadge imageKey={imageKey} />
                </Suspense>
              </ErrorBoundary>
            ) : null}
            {frameHeldBack(frame) ? <Badge variant="warning">{FRAME_SUBSTANCE_CHIP(frame.verdict)}</Badge> : null}
            <ImageMetadataBadges image={displayImage} primaryScoreSource={primaryScoreSource} />
          </div>
        </>
      }
      panel={
        <>
          <TabNav tabs={tabs} activeTab={active} onTabChange={(id) => onTabChange(id as ImageDetailTab)} />
          <div
            role="tabpanel"
            aria-labelledby={`tab-${active}`}
            className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto"
          >
            <ErrorBoundary
              resetKeys={[active, imageKey]}
              fallback={({ error, reset }) => (
                <ErrorState
                  error={error}
                  reset={() => {
                    if (active === 'stack') stacksChanged()
                    reset()
                  }}
                />
              )}
            >
              <Suspense fallback={<p className="text-sm text-text-tertiary">Loading…</p>}>{panel[active]()}</Suspense>
            </ErrorBoundary>
          </div>
        </>
      }
    />
  )
}

/**
 * The single entry point for viewing any image in detail. Callers pass the
 * `imageKey` and spread `modalPropsFor(view)`; the modal fetches the photo
 * from the detail endpoint.
 *
 * The photo and its badges stay on the left; everything else is a tab built
 * from the blocks in `detail-blocks.tsx` (see "Image detail modal" in CONTEXT.md).
 *
 * Responsive (CONTEXT Q4):
 *   - `<md` (<768px): full-screen sheet at `100dvh`.
 *   - `>=md`: centered card at a fixed `92vh` × `min(1400px, 94vw)`, so switching
 *     tabs never resizes it.
 *   - Only the tab content scrolls; the header and the photo stay in place.
 *
 * Accessibility (CONTEXT):
 *   - `role="dialog" aria-modal="true"` + `aria-labelledby`.
 *   - Focus trap via `useFocusTrap` (in-repo, no new dependency).
 *   - Scroll lock via `useBodyScrollLock`.
 *   - ESC closes; backdrop click closes.
 */
export function ImageDetailModal({
  imageKey,
  primaryScoreSource,
  scorePerspectiveSlug,
  contextSlot,
  showCullSection = false,
  initialTab,
  nav,
  onClose,
}: ImageDetailModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = `image-detail-modal-title-${imageKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  const [tab, setTab] = useState<ImageDetailTab>(initialTab ?? (showCullSection ? 'culling' : 'ai'))
  const source = { imageKey, scorePerspectiveSlug }

  useBodyScrollLock(true)
  useFocusTrap(dialogRef, true)

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-50 backdrop-blur-sm md:flex md:items-center md:justify-center md:p-4"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.75)' }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex h-[100dvh] w-full flex-col overflow-hidden bg-bg shadow-deep md:h-[92vh] md:w-[min(1400px,94vw)] md:rounded-card"
        style={{ backgroundColor: 'var(--color-background)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-none items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-6 md:py-4">
          <h2 id={titleId} className="text-card-title text-text truncate">
            <ErrorBoundary resetKeys={[imageKey]} fallback={() => <TitleText imageKey={imageKey} />}>
              <Suspense fallback={<TitleText imageKey={imageKey} />}>
                <LoadedTitle {...source} />
              </Suspense>
            </ErrorBoundary>
          </h2>
          <div className="flex items-center gap-2 shrink-0">
            {nav && nav.keys.length > 1 ? (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={nav.index <= 0}
                  onClick={() => nav.onIndexChange(nav.index - 1)}
                >
                  ‹ {CULL_MODAL_PREV}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={nav.index >= nav.keys.length - 1}
                  onClick={() => nav.onIndexChange(nav.index + 1)}
                >
                  {CULL_MODAL_NEXT} ›
                </Button>
              </>
            ) : null}
            <ModalCloseButton onClick={onClose} />
          </div>
        </div>

        {contextSlot ? (
          <div className="flex-none border-b border-border px-4 py-3 md:px-6 md:py-4">{contextSlot}</div>
        ) : null}

        <ErrorBoundary
          resetKeys={[imageKey, scorePerspectiveSlug ?? '']}
          fallback={({ error, reset }) => (
            <div className="p-6">
              <ErrorState
                error={error}
                reset={() => {
                  retryImageDetail('catalog', imageKey, scorePerspectiveSlug)
                  reset()
                }}
              />
            </div>
          )}
        >
          <Suspense fallback={<ImageDetailModalFallback imageKey={imageKey} />}>
            <ImageDetailModalBody
              {...source}
              primaryScoreSource={primaryScoreSource}
              showCullSection={showCullSection}
              tab={tab}
              onTabChange={setTab}
            />
          </Suspense>
        </ErrorBoundary>
      </div>
    </div>,
    document.body,
  )
}
