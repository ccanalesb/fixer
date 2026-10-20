import type { ImageView } from '../../services/api'
import { ImagesAPI } from '../../services/api'
import { invalidateAll } from '../../data'
import { AIDescriptionSection } from '../DescriptionPanel'
import { AIPerspectiveSection } from '../catalog/AIPerspectiveSection'
import { FrameSubstanceSection } from '../catalog/FrameSubstanceSection'
import { LightroomWritebackDetailSection } from '../catalog/LightroomWritebackDetailSection'
import { Badge } from '../ui/badges'
import { MetadataRow } from '../ui/MetadataRow'
import {
  DATE_NO_DATE,
  IMAGE_DETAILS_DESCRIPTIVE_TECHNICAL,
  IMAGE_DETAIL_POSTED_ARIA,
  IMAGE_DETAIL_POSTED_LABEL,
  LABEL_CAPTION,
  LABEL_DATE,
  LABEL_DIMENSIONS,
  LABEL_FILENAME,
  LABEL_KEYWORDS,
  LABEL_PATH,
  LABEL_TITLE,
} from '../../constants/strings'
import { useEffect, useState } from 'react'

interface CatalogImageDetailSectionsProps {
  image: ImageView
  /** Called when the caller should re-fetch detail (after description
   *  jobs complete) so the modal header / breakdown stay in sync. */
  onDataChanged?: () => void
  /** Optimistic posted-flag sync for modal header badges. */
  onPostedChange?: (posted: boolean) => void
}

/**
 * Catalog-specific body sections for the consolidated ImageDetailModal.
 * Descriptive/technical content comes from `image_descriptions`; per-perspective
 * scores come from `image_scores` in a separate section with its own regenerate control.
 */
export function CatalogImageDetailSections({
  image,
  onDataChanged,
  onPostedChange,
}: CatalogImageDetailSectionsProps) {
  const dateDisplay = image.date_taken
    ? new Date(image.date_taken).toLocaleString()
    : DATE_NO_DATE
  const keywords = Array.isArray(image.keywords) ? image.keywords : []
  const dimensions =
    image.width && image.height ? `${image.width} × ${image.height}` : null

  const [posted, setPosted] = useState(image.instagram_posted ?? false)
  const [togglingPosted, setTogglingPosted] = useState(false)
  const [postedError, setPostedError] = useState<string | null>(null)

  useEffect(() => {
    setPosted(image.instagram_posted ?? false)
    setPostedError(null)
  }, [image.key, image.instagram_posted])

  async function handlePostedToggle(next: boolean) {
    const prev = posted
    setPosted(next)
    onPostedChange?.(next)
    setPostedError(null)
    setTogglingPosted(true)
    try {
      await ImagesAPI.setInstagramPosted(image.key, next)
      // Drop every cached catalog page: the Images grid can be filtered by
      // `posted`, so a toggle changes which rows belong in the result set,
      // not just how one row renders.
      invalidateAll(['images.catalog', 'list'])
    } catch (e) {
      setPosted(prev)
      onPostedChange?.(prev)
      setPostedError(e instanceof Error ? e.message : 'Failed to update posted flag')
    } finally {
      setTogglingPosted(false)
    }
  }

  return (
    <div className="space-y-6">
      <label
        className="flex items-center gap-3 rounded-base border border-border bg-surface p-4 text-sm text-text"
        onClick={(ev) => ev.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={posted}
          disabled={togglingPosted}
          aria-label={IMAGE_DETAIL_POSTED_ARIA}
          onChange={(ev) => void handlePostedToggle(ev.target.checked)}
          className="h-4 w-4 rounded border-border text-accent focus:ring-accent focus:ring-offset-0"
        />
        <span className="font-medium">{IMAGE_DETAIL_POSTED_LABEL}</span>
      </label>
      {postedError ? (
        <p className="text-sm text-error" role="alert">{postedError}</p>
      ) : null}

      <div className="space-y-3">
        <MetadataRow label={LABEL_FILENAME} value={image.filename ?? image.key} />
        <MetadataRow label={LABEL_TITLE} value={image.title} />
        <MetadataRow label={LABEL_DATE} value={dateDisplay} />
        <MetadataRow label={LABEL_PATH} value={image.filepath} mono />
        <MetadataRow label={LABEL_DIMENSIONS} value={dimensions} />
      </div>

      {image.caption ? (
        <div className="p-4 bg-surface rounded-base border border-border">
          <h3 className="text-sm font-medium text-text mb-2">{LABEL_CAPTION}</h3>
          <p className="text-sm text-text-secondary">{image.caption}</p>
        </div>
      ) : null}

      {keywords.length > 0 ? (
        <div className="p-4 bg-surface rounded-base border border-border">
          <h3 className="text-sm font-medium text-text mb-2">{LABEL_KEYWORDS}</h3>
          <div className="flex flex-wrap gap-2">
            {keywords.map((keyword, idx) => (
              <Badge key={idx} variant="default">
                {keyword}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      <LightroomWritebackDetailSection imageKey={image.key} />

      <FrameSubstanceSection imageKey={image.key} onDataChanged={onDataChanged} />

      <AIDescriptionSection
        imageKey={image.key}
        imageType="catalog"
        titleOverride={IMAGE_DETAILS_DESCRIPTIVE_TECHNICAL}
        onDataChanged={onDataChanged}
      />
      <AIPerspectiveSection
        imageKey={image.key}
        imageType="catalog"
        onDataChanged={onDataChanged}
      />
    </div>
  )
}
