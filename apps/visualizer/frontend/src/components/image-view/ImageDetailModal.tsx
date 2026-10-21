import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CatalogImage, ImageView } from '../../services/api'
import { ImagesAPI } from '../../services/api'
import { useBodyScrollLock, useFocusTrap } from '../../hooks'
import {
  IMAGE_DETAILS_TITLE,
  ACTION_CANCEL,
  ACTION_UNDO,
  CATALOG_STACK_SPLIT_OUT,
  CATALOG_STACK_MAKE_REPRESENTATIVE,
  CATALOG_STACK_MERGE_INTO,
  CATALOG_STACK_MERGE_SOURCE_ARIA,
  CATALOG_STACK_MERGE_PLACEHOLDER,
  CATALOG_STACK_MERGE_RUN,
  CATALOG_STACK_CONFIRM_SPLIT_TITLE,
  CATALOG_STACK_CONFIRM_SPLIT_BODY,
  CATALOG_STACK_CONFIRM_REP_TITLE,
  CATALOG_STACK_CONFIRM_REP_BODY,
  CATALOG_STACK_CONFIRM_MERGE_TITLE,
  CATALOG_STACK_CONFIRM_MERGE_BODY,
  CATALOG_STACK_TOAST_REP_UPDATED,
} from '../../constants/strings'
import { Button } from '../ui/Button/Button'
import { ConfirmModalFrame, UndoToastBar, useUndoToast } from '../ui/ConfirmUndoAction'
import { CatalogImageDetailSections } from './CatalogImageDetailSections'
import { CullDetailSectionLoader } from '../cull/CullDetailSectionLoader'
import { CULL_DETAIL_SECTION, CULL_MODAL_NEXT, CULL_MODAL_PREV } from '../../constants/strings'
import { ImageMetadataBadges, type PrimaryScoreSource } from './ImageMetadataBadges'
import { ImageTile } from './ImageTile'
import { fromCatalogListRow } from './adapters'
import { ModalCloseButton } from './ModalCloseButton'
import { ErrorBoundary, ErrorState, invalidate, invalidateAll, useQuery } from '../../data'

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
  /** When set, loads `/api/cull/photos/{key}` and renders the culling section. */
  showCullSection?: boolean
  /** Prev / next within a cull review or catalog list (ticket 17). */
  cullNav?: {
    keys: string[]
    index: number
    onIndexChange: (index: number) => void
  }
  onClose: () => void
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
      <div className="aspect-square overflow-hidden rounded-base bg-surface">
        <img
          src={`/api/images/${imageType}/${encodeURIComponent(imageKey)}/thumbnail`}
          alt={initialImage?.filename ?? imageKey}
          className="h-full w-full object-contain"
        />
      </div>

      <div className="space-y-6">
        {initialImage ? (
          <ImageMetadataBadges image={initialImage} primaryScoreSource={primaryScoreSource} />
        ) : null}

        <p className="text-sm text-text-tertiary" role="status" aria-live="polite">
          Loading image details…
        </p>
      </div>
    </div>
  )
}

type StackConfirmSpec = {
  title: ReactNode
  children: ReactNode
  confirmLabel: string
  confirmVariant: 'danger' | 'primary'
  onConfirm: () => Promise<void>
}

/** Stack split / merge / representative (catalog detail). Loads members to validate multi-key stack. */
function CatalogDetailStackEditing({
  stackId,
  onDataChanged,
}: {
  stackId: number
  onDataChanged: () => void
}) {
  const filmstripRef = useRef<HTMLDivElement>(null)
  const [members, setMembers] = useState<CatalogImage[] | null>(null)
  const [mutating, setMutating] = useState(false)
  const [mergeSourceId, setMergeSourceId] = useState('')
  const [confirm, setConfirm] = useState<StackConfirmSpec | null>(null)
  const { toast, offerUndo, runUndo } = useUndoToast()

  useEffect(() => {
    let cancelled = false
    void ImagesAPI.getStackMembers(stackId)
      .then((r) => {
        if (!cancelled) setMembers(r.items)
      })
      .catch(() => {
        if (!cancelled) setMembers([])
      })
    return () => {
      cancelled = true
    }
  }, [stackId])

  async function refreshMembers() {
    try {
      const r = await ImagesAPI.getStackMembers(stackId)
      setMembers(r.items)
    } catch {
      setMembers([])
    }
    onDataChanged()
  }

  async function runConfirmed(spec: StackConfirmSpec) {
    setMutating(true)
    try {
      await spec.onConfirm()
    } finally {
      setMutating(false)
      setConfirm(null)
    }
  }

  if (!members || members.length < 2) return null

  const hasRep = members.some((m) => m.is_stack_representative)

  const openSplitConfirm = (memberKey: string) => {
    setConfirm({
      title: CATALOG_STACK_CONFIRM_SPLIT_TITLE,
      children: <p className="text-sm text-text-secondary">{CATALOG_STACK_CONFIRM_SPLIT_BODY}</p>,
      confirmLabel: CATALOG_STACK_SPLIT_OUT,
      confirmVariant: 'danger',
      onConfirm: async () => {
        await ImagesAPI.splitStackMember(stackId, memberKey)
        await refreshMembers()
      },
    })
  }

  const openRepConfirm = (memberKey: string) => {
    const prevRep = members.find((m) => m.is_stack_representative)?.key
    if (!prevRep || prevRep === memberKey) return
    setConfirm({
      title: CATALOG_STACK_CONFIRM_REP_TITLE,
      children: <p className="text-sm text-text-secondary">{CATALOG_STACK_CONFIRM_REP_BODY}</p>,
      confirmLabel: CATALOG_STACK_MAKE_REPRESENTATIVE,
      confirmVariant: 'primary',
      onConfirm: async () => {
        await ImagesAPI.setStackRepresentative(stackId, memberKey)
        await refreshMembers()
        offerUndo(CATALOG_STACK_TOAST_REP_UPDATED, async () => {
          await ImagesAPI.setStackRepresentative(stackId, prevRep)
          await refreshMembers()
        })
      },
    })
  }

  const openMergeConfirm = () => {
    const sid = parseInt(mergeSourceId.trim(), 10)
    if (!Number.isFinite(sid) || sid < 1 || sid === stackId) return
    setConfirm({
      title: CATALOG_STACK_CONFIRM_MERGE_TITLE,
      children: <p className="text-sm text-text-secondary">{CATALOG_STACK_CONFIRM_MERGE_BODY}</p>,
      confirmLabel: CATALOG_STACK_MERGE_RUN,
      confirmVariant: 'danger',
      onConfirm: async () => {
        await ImagesAPI.mergeStacks(stackId, sid)
        setMergeSourceId('')
        onDataChanged()
      },
    })
  }

  return (
    <div className="space-y-3 rounded-base border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold text-text">Burst stack</h3>
      <div ref={filmstripRef} className="flex gap-2 overflow-x-auto pb-1">
        {members.map((member) => (
          <div key={member.key} className="w-[7.5rem] shrink-0 min-w-0 space-y-1">
            <ImageTile
              image={fromCatalogListRow(member)}
              variant="strip"
              primaryScoreSource="catalog"
              scrollContainerRef={filmstripRef}
              onClick={() => {}}
              className="!w-full max-w-full"
            />
            <div className="flex flex-col gap-1">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                fullWidth
                className="min-h-9 text-xs"
                disabled={mutating}
                onClick={() => openSplitConfirm(member.key)}
              >
                {CATALOG_STACK_SPLIT_OUT}
              </Button>
              {!member.is_stack_representative ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  fullWidth
                  className="min-h-9 text-xs"
                  disabled={mutating}
                  onClick={() => openRepConfirm(member.key)}
                >
                  {CATALOG_STACK_MAKE_REPRESENTATIVE}
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {hasRep ? (
        <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <span className="w-full text-xs font-medium text-text-secondary">{CATALOG_STACK_MERGE_INTO}</span>
          <input
            type="text"
            inputMode="numeric"
            aria-label={CATALOG_STACK_MERGE_SOURCE_ARIA}
            placeholder={CATALOG_STACK_MERGE_PLACEHOLDER}
            value={mergeSourceId}
            disabled={mutating}
            onChange={(e) => setMergeSourceId(e.target.value)}
            className="h-9 min-w-[6rem] rounded-base border border-border bg-bg px-2 text-sm text-text"
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="min-h-9"
            disabled={mutating || !mergeSourceId.trim()}
            onClick={openMergeConfirm}
          >
            {CATALOG_STACK_MERGE_RUN}
          </Button>
        </div>
      ) : null}

      {confirm ? (
        <ConfirmModalFrame
          zIndexClass="z-[80]"
          title={confirm.title}
          confirmLabel={confirm.confirmLabel}
          cancelLabel={ACTION_CANCEL}
          confirmVariant={confirm.confirmVariant}
          onConfirm={() => void runConfirmed(confirm)}
          onCancel={() => setConfirm(null)}
          busy={mutating}
        >
          {confirm.children}
        </ConfirmModalFrame>
      ) : null}

      <UndoToastBar toast={toast} undoLabel={ACTION_UNDO} onUndo={() => void runUndo()} />
    </div>
  )
}

function ImageDetailModalBody({
  imageType,
  imageKey,
  primaryScoreSource,
  scorePerspectiveSlug,
  initialImage,
  showCullSection,
}: Omit<ImageDetailModalProps, 'onClose' | 'cullNav' | 'contextSlot'>) {
  const detailKey = useMemo(
    () =>
      [
        'images.detail',
        imageType,
        imageKey,
        scorePerspectiveSlug ?? '',
      ] as const,
    [imageType, imageKey, scorePerspectiveSlug],
  )

  const image = useQuery(detailKey, () => {
    if (imageType !== 'catalog') {
      if (!initialImage) {
        throw new Error('Instagram image detail is no longer available')
      }
      return Promise.resolve(initialImage)
    }
    return ImagesAPI.getImageDetail(
      imageType,
      imageKey,
      scorePerspectiveSlug ? { score_perspective: scorePerspectiveSlug } : undefined,
    )
  })

  const [postedOverride, setPostedOverride] = useState<boolean | null>(null)
  useEffect(() => {
    setPostedOverride(null)
  }, [imageKey])

  const displayImage =
    postedOverride !== null && image
      ? { ...image, instagram_posted: postedOverride }
      : image

  const [, bump] = useState(0)
  const handleDataChanged = useCallback(() => {
    invalidate(detailKey)
    bump((n) => n + 1)
  }, [detailKey])

  const stackIdRaw = image.stack_id ?? initialImage?.stack_id
  const stackId = stackIdRaw != null ? Number(stackIdRaw) : null

  return (
    <>
      <div className="grid gap-6 p-6 md:grid-cols-2">
        <div className="aspect-square overflow-hidden rounded-base bg-surface">
          <img
            src={`/api/images/${imageType}/${encodeURIComponent(imageKey)}/thumbnail`}
            alt={image?.filename ?? imageKey}
            className="h-full w-full object-contain"
          />
        </div>

        <div className="space-y-6">
          <ImageMetadataBadges image={displayImage} primaryScoreSource={primaryScoreSource} />

          {image.image_type === 'catalog' ? (
            <CatalogImageDetailSections
              image={displayImage}
              onDataChanged={handleDataChanged}
              onPostedChange={setPostedOverride}
            />
          ) : null}
          {image.image_type === 'catalog' && stackId != null && !Number.isNaN(stackId) ? (
            <CatalogDetailStackEditing
              stackId={stackId}
              onDataChanged={handleDataChanged}
            />
          ) : null}
          {showCullSection && image.image_type === 'catalog' ? (
            <Suspense
              fallback={
                <p className="mt-6 pt-6 border-t border-border text-sm text-text-secondary">
                  {CULL_DETAIL_SECTION}
                </p>
              }
            >
              <CullDetailSectionLoader imageKey={imageKey} onMutated={handleDataChanged} />
            </Suspense>
          ) : null}
        </div>
      </div>
    </>
  )
}

/**
 * The single entry point for viewing any image in detail. Every tile in
 * the app opens this modal with just `{ imageType, imageKey }` so the
 * modal can re-fetch from the authoritative detail endpoint and avoid
 * the zero-score stubs the legacy modals relied on.
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
  cullNav,
  onClose,
}: ImageDetailModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = `image-detail-modal-title-${imageKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`

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
              {IMAGE_DETAILS_TITLE}
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
                imageType={imageType}
                imageKey={imageKey}
                initialImage={initialImage}
                primaryScoreSource={primaryScoreSource}
                scorePerspectiveSlug={scorePerspectiveSlug}
                showCullSection={showCullSection}
              />
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>
    </div>
  )
}
