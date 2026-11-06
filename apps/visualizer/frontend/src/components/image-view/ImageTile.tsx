import type { CatalogKind } from '../../types/config'
import type { ReactNode, RefObject } from 'react'
import { ScrollContainerLazyImage } from '../ui/ScrollContainerLazyImage'
import type { ImageView } from '../../services/api'
import { Badge } from '../ui/badges'
import { formatStackCountBadge } from '../../constants/strings'
import { ImageMetadataBadges, type PrimaryScoreSource } from './ImageMetadataBadges'
import { imageTileVariantClasses, type ImageTileVariant } from './imageTileVariants'

export type { ImageTileVariant } from './imageTileVariants'

interface ImageTileProps {
  image: ImageView
  variant: ImageTileVariant
  primaryScoreSource: PrimaryScoreSource
  onClick: () => void
  /** Secondary line beneath filename (e.g. folder, "Estimated 2024/05"). */
  subtitle?: string
  /** Caller-supplied overlays rendered top-right on the thumbnail. The
   *  stack-representative badge is derived from `image.stack_*` fields and
   *  rendered automatically beneath any caller-supplied overlays — that
   *  derivation is intentionally centralized here so every surface stays
   *  consistent. */
  overlayBadges?: ReactNode
  /** Content rendered below the metadata row (e.g. post-next reason bullets). */
  footer?: ReactNode
  /** When true, hides the metadata-row "Posted" chip (e.g. when using overlayBadges). */
  hidePostedMetadataBadge?: boolean
  /** Pass the horizontal scroll container ref for strip tiles so thumbnails
   *  load via IntersectionObserver instead of native lazy loading. */
  scrollContainerRef?: RefObject<HTMLElement | null>
  /** Folder vs Lightroom catalog — labels the missing-from-catalog chip. */
  catalogKind?: CatalogKind
  className?: string
}

function deriveStackOverlay(image: ImageView): ReactNode {
  const count = image.stack_member_count ?? 0
  const isStackRep =
    image.stack_id != null && image.is_stack_representative === true && count > 1
  if (!isStackRep) return null
  return <Badge variant="default">{formatStackCountBadge(count)}</Badge>
}

/**
 * Single tile component for every image surface. Aspect ratio and body
 * density change per variant; badge markup and primary-score logic come
 * from the shared `ImageMetadataBadges` to avoid drift.
 *
 * Thumbnail path is `/api/images/<image_type>/<key>/thumbnail` (matches
 * existing backend route).
 */
export function ImageTile({
  image,
  variant,
  primaryScoreSource,
  onClick,
  subtitle,
  overlayBadges,
  footer,
  hidePostedMetadataBadge = false,
  scrollContainerRef,
  catalogKind = 'lightroom',
  className = '',
}: ImageTileProps) {
  const classes = imageTileVariantClasses(variant)
  const imageType = image.image_type
  const catalogMissing = Boolean(image.catalog_missing_since)
  // A gone photo greys only its preview; the chip and text stay readable.
  const imageClassName = `absolute inset-0 h-full w-full object-cover${
    catalogMissing ? ' grayscale opacity-[.55]' : ''
  }`
  const dateDisplay = image.date_taken
    ? new Date(image.date_taken).toLocaleDateString()
    : image.created_at
      ? new Date(image.created_at).toLocaleDateString()
      : '—'

  const thumbnailSrc = `/api/images/${imageType}/${encodeURIComponent(image.key)}/thumbnail`
  const thumbnailAlt = image.filename ?? image.key

  const stackOverlay = deriveStackOverlay(image)
  const composedOverlays =
    overlayBadges || stackOverlay ? (
      <>
        {overlayBadges}
        {stackOverlay}
      </>
    ) : null

  return (
    <div
      className={`group overflow-hidden rounded-card border border-border bg-bg shadow-card transition-all hover:border-border-strong hover:shadow-deep ${classes.root} ${className}`.trim()}
      data-testid="image-tile"
      data-image-key={image.key}
      data-image-type={imageType}
      data-variant={variant}
    >
      <button
        type="button"
        onClick={onClick}
        className={`block w-full text-left focus:outline-none focus:ring-2 focus:ring-accent focus:ring-inset ${classes.button}`}
      >
        <div className={`relative bg-surface ${classes.thumb}`}>
          {scrollContainerRef ? (
            <ScrollContainerLazyImage
              scrollContainerRef={scrollContainerRef}
              src={thumbnailSrc}
              alt={thumbnailAlt}
              className={imageClassName}
            />
          ) : (
            <img
              src={thumbnailSrc}
              alt={thumbnailAlt}
              className={imageClassName}
              loading="lazy"
            />
          )}
          {composedOverlays ? (
            <div className="absolute right-2 top-2 flex flex-col gap-1">
              {composedOverlays}
            </div>
          ) : null}
        </div>
      </button>
      <div className={`space-y-1 ${classes.body}`}>
        <p className={`truncate font-medium text-text ${classes.title}`}>
          {image.filename ?? image.key}
        </p>
        {subtitle ? (
          <p className={`truncate text-text-secondary ${classes.subtitle}`}>{subtitle}</p>
        ) : image.title ? (
          <p className={`truncate text-text-secondary ${classes.subtitle}`}>{image.title}</p>
        ) : null}
        <p className={`text-text-tertiary ${classes.meta}`}>{dateDisplay}</p>
        <ImageMetadataBadges
          image={image}
          primaryScoreSource={primaryScoreSource}
          hidePostedBadge={hidePostedMetadataBadge}
          catalogKind={catalogKind}
        />
        {footer}
      </div>
    </div>
  )
}
