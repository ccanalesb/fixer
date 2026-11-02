import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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
import { ErrorBoundary, ErrorState, invalidate, invalidateAll, useQuery } from '../../data'

export type ImageDetailTab = 'culling' | 'ai' | 'lightroom' | 'file' | 'stack'

interface ImageDetailModalProps {
  imageType: 'catalog'
  imageKey: string
  /** Optional list-row data shown instantly while the detail call is in
   *  flight; once the detail payload arrives it overrides this. */
  initialImage?: ImageView
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
  cullNav?: {
    keys: string[]
    index: number
    onIndexChange: (index: number) => void
  }
  onClose: () => void
}

type DetailSource = Pick<ImageDetailModalProps, 'imageType' | 'imageKey' | 'scorePerspectiveSlug' | 'initialImage'>

const detailKeyOf = ({ imageType, imageKey, scorePerspectiveSlug }: DetailSource) =>
  ['images.detail', imageType, imageKey, scorePerspectiveSlug ?? ''] as const

function useImageDetail({ imageType, imageKey, scorePerspectiveSlug, initialImage }: DetailSource) {
  return useQuery(detailKeyOf({ imageType, imageKey, scorePerspectiveSlug }), () => {
    if (imageType !== 'catalog') {
      if (!initialImage) throw new Error('Instagram image detail is no longer available')
      return Promise.resolve(initialImage)
    }
    return ImagesAPI.getImageDetail(
      imageType,
      imageKey,
      scorePerspectiveSlug ? { score_perspective: scorePerspectiveSlug } : undefined,
    )
  })
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

function PhotoView({ imageType, imageKey, alt }: { imageType: 'catalog'; imageKey: string; alt: string }) {
  return (
    <div className="aspect-square overflow-hidden rounded-base bg-surface">
      <img
        src={`/api/images/${imageType}/${encodeURIComponent(imageKey)}/thumbnail`}
        alt={alt}
        className="h-full w-full object-contain"
      />
    </div>
  )
}

function CullVerdictBadge({ imageKey }: { imageKey: string }) {
  const detail = useQuery(['cull.detail', imageKey] as const, () => CullAPI.photoDetail(imageKey))
  if (detail.sent_by_hand) return <Badge variant="accent">{CULL_SENT_BY_HAND}</Badge>
  if (detail.verdict === 'passed') return <Badge variant="success">{CULL_PASSED}</Badge>
  return <Badge variant="warning">{CULL_FILTERED}</Badge>
}

function ImageDetailModalFallback({
  initialImage,
  imageKey,
  imageType,
  primaryScoreSource,
}: {
  initialImage?: ImageView
  imageKey: string
  imageType: 'catalog'
  primaryScoreSource: PrimaryScoreSource
}) {
  return (
    <div className="grid gap-6 p-6 md:grid-cols-2">
      <div className="space-y-4">
        <PhotoView imageType={imageType} imageKey={imageKey} alt={initialImage?.filename ?? imageKey} />
        {initialImage ? (
          <ImageMetadataBadges image={initialImage} primaryScoreSource={primaryScoreSource} />
        ) : null}
      </div>
      <p className="text-sm text-text-tertiary" role="status" aria-live="polite">
        Loading image details…
      </p>
    </div>
  )
}

function ImageDetailModalBody({
  imageType,
  imageKey,
  primaryScoreSource,
  scorePerspectiveSlug,
  initialImage,
  showCullSection = false,
  tab,
  onTabChange,
}: DetailSource & {
  primaryScoreSource: PrimaryScoreSource
  showCullSection?: boolean
  tab: ImageDetailTab
  onTabChange: (tab: ImageDetailTab) => void
}) {
  const image = useImageDetail({ imageType, imageKey, scorePerspectiveSlug, initialImage })
  const frame = useQuery(...frameSubstanceQuery(imageKey))

  const [postedOverride, setPostedOverride] = useState<boolean | null>(null)
  useEffect(() => {
    setPostedOverride(null)
  }, [imageKey])
  const displayImage = postedOverride !== null ? { ...image, instagram_posted: postedOverride } : image

  const handleDataChanged = useCallback(
    () => invalidate(detailKeyOf({ imageType, imageKey, scorePerspectiveSlug })),
    [imageType, imageKey, scorePerspectiveSlug],
  )

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
      <CullingTab imageKey={imageKey} showVerdict={showCullSection} onDataChanged={handleDataChanged} />
    ),
    ai: () => <AiTab imageKey={imageKey} onDataChanged={handleDataChanged} />,
    lightroom: () => <LightroomTab image={displayImage} />,
    file: () => <FileTab image={displayImage} onPostedChange={setPostedOverride} />,
    stack: () =>
      hasStack ? <StackTab stackId={stackId} imageKey={imageKey} onDataChanged={handleDataChanged} /> : null,
  }

  return (
    <div className="grid gap-6 p-6 md:grid-cols-2">
      <div className="space-y-4">
        <PhotoView imageType={imageType} imageKey={imageKey} alt={image.filename ?? imageKey} />
        <div className="flex flex-wrap items-center gap-2">
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
      </div>

      <div className="min-w-0">
        <TabNav tabs={tabs} activeTab={active} onTabChange={(id) => onTabChange(id as ImageDetailTab)} />
        <div role="tabpanel" aria-labelledby={`tab-${active}`} className="mt-4 space-y-4">
          <ErrorBoundary
            resetKeys={[active, imageKey]}
            fallback={({ error, reset }) => <ErrorState error={error} reset={reset} />}
          >
            <Suspense fallback={<p className="text-sm text-text-tertiary">Loading…</p>}>{panel[active]()}</Suspense>
          </ErrorBoundary>
        </div>
      </div>
    </div>
  )
}

/**
 * The single entry point for viewing any image in detail. Every tile in
 * the app opens this modal with just `{ imageType, imageKey }` so the
 * modal can re-fetch from the authoritative detail endpoint.
 *
 * The photo and its badges stay on the left; everything else is a tab built
 * from the blocks in `detail-blocks.tsx` (see "Image detail modal" in CONTEXT.md).
 *
 * Responsive (CONTEXT Q4):
 *   - `<md` (<768px): full-screen sheet at `100dvh`.
 *   - `>=md`: centered card, `max-h-[min(90vh,900px)]`.
 *
 * Accessibility (CONTEXT):
 *   - `role="dialog" aria-modal="true"` + `aria-labelledby`.
 *   - Focus trap via `useFocusTrap` (in-repo, no new dependency).
 *   - Scroll lock via `useBodyScrollLock`.
 *   - ESC closes; backdrop click closes.
 */
export function ImageDetailModal({
  imageType,
  imageKey,
  initialImage,
  primaryScoreSource,
  scorePerspectiveSlug,
  contextSlot,
  showCullSection = false,
  initialTab,
  cullNav,
  onClose,
}: ImageDetailModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = `image-detail-modal-title-${imageKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  const [tab, setTab] = useState<ImageDetailTab>(initialTab ?? (showCullSection ? 'culling' : 'ai'))
  const source = { imageType, imageKey, scorePerspectiveSlug, initialImage }

  useBodyScrollLock(true)
  useFocusTrap(dialogRef, true)

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [onClose])

  return (
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
        className="relative flex h-[100dvh] max-h-[100dvh] w-full flex-col overflow-hidden bg-bg shadow-deep md:h-auto md:max-h-[min(90vh,900px)] md:max-w-4xl md:rounded-card"
        style={{ backgroundColor: 'var(--color-background)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div
            className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-bg px-6 py-4 md:rounded-t-card"
            style={{ backgroundColor: 'var(--color-background)' }}
          >
            <h2 id={titleId} className="text-card-title text-text truncate">
              <ErrorBoundary
                resetKeys={[imageKey]}
                fallback={() => <TitleText image={initialImage} imageKey={imageKey} />}
              >
                <Suspense fallback={<TitleText image={initialImage} imageKey={imageKey} />}>
                  <LoadedTitle {...source} />
                </Suspense>
              </ErrorBoundary>
            </h2>
            <div className="flex items-center gap-2 shrink-0">
              {cullNav && cullNav.keys.length > 1 ? (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={cullNav.index <= 0}
                    onClick={() => cullNav.onIndexChange(cullNav.index - 1)}
                  >
                    ‹ {CULL_MODAL_PREV}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={cullNav.index >= cullNav.keys.length - 1}
                    onClick={() => cullNav.onIndexChange(cullNav.index + 1)}
                  >
                    {CULL_MODAL_NEXT} ›
                  </Button>
                </>
              ) : null}
              <ModalCloseButton onClick={onClose} />
            </div>
          </div>

          {contextSlot ? <div className="border-b border-border px-6 py-4">{contextSlot}</div> : null}

          <ErrorBoundary
            resetKeys={[imageType, imageKey, scorePerspectiveSlug ?? '']}
            fallback={({ error, reset }) => (
              <div className="p-6">
                <ErrorState
                  error={error}
                  reset={() => {
                    invalidateAll(['images.detail', imageType, imageKey])
                    reset()
                  }}
                />
              </div>
            )}
          >
            <Suspense
              fallback={
                <ImageDetailModalFallback
                  initialImage={initialImage}
                  imageKey={imageKey}
                  imageType={imageType}
                  primaryScoreSource={primaryScoreSource}
                />
              }
            >
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
      </div>
    </div>
  )
}
