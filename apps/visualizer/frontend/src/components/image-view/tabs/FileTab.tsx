import { useEffect, useState } from 'react'
import type { ImageView } from '../../../services/api'
import { ConfigAPI, ImagesAPI } from '../../../services/api'
import {
  DATE_NO_DATE,
  FILE_MISSING_STATUS_BODY,
  FILE_MISSING_STATUS_TITLE,
  IMAGE_DETAILS_FILE,
  IMAGE_DETAILS_NO,
  IMAGE_DETAILS_POSTED,
  IMAGE_DETAILS_YES,
  IMAGE_DETAIL_POSTED_ARIA,
  IMAGE_DETAIL_POSTED_LABEL,
  LABEL_CAPTION,
  LABEL_DATE,
  LABEL_DIMENSIONS,
  LABEL_FILENAME,
  LABEL_PATH,
  LABEL_TITLE,
  LR_MISSING_STATUS_BODY,
  LR_MISSING_STATUS_TITLE,
} from '../../../constants/strings'
import { ActionArea, ActionRow, Fact, FactsBlock, StatusBlock } from '../detail-blocks'

function formatMissingSince(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return iso
  }
}

export function FileTab({
  image,
  onPostedChange,
}: {
  image: ImageView
  /** Optimistic posted flag for the badges under the photo. */
  onPostedChange?: (posted: boolean) => void
}) {
  const [posted, setPosted] = useState(image.instagram_posted ?? false)
  const [toggling, setToggling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [catalogKind, setCatalogKind] = useState<'lightroom' | 'folder'>('lightroom')

  useEffect(() => {
    setPosted(image.instagram_posted ?? false)
    setError(null)
  }, [image.key, image.instagram_posted])

  useEffect(() => {
    let cancelled = false
    void ConfigAPI.getCatalog().then((cfg) => {
      if (!cancelled) setCatalogKind(cfg.catalog_kind)
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function togglePosted(next: boolean) {
    const prev = posted
    setPosted(next)
    onPostedChange?.(next)
    setError(null)
    setToggling(true)
    try {
      await ImagesAPI.setInstagramPosted(image.key, next)
    } catch (e) {
      setPosted(prev)
      onPostedChange?.(prev)
      setError(e instanceof Error ? e.message : 'Failed to update posted flag')
    } finally {
      setToggling(false)
    }
  }

  const dimensions = image.width && image.height ? `${image.width} × ${image.height}` : null
  const missingSince = image.catalog_missing_since
  const missingBlock =
    missingSince != null ? (
      <StatusBlock
        tone="warning"
        title={catalogKind === 'folder' ? FILE_MISSING_STATUS_TITLE : LR_MISSING_STATUS_TITLE}
      >
        {catalogKind === 'folder'
          ? FILE_MISSING_STATUS_BODY(image.filepath ?? image.key, formatMissingSince(missingSince))
          : LR_MISSING_STATUS_BODY(formatMissingSince(missingSince))}
      </StatusBlock>
    ) : null

  return (
    <>
      {missingBlock}
      <FactsBlock title={IMAGE_DETAILS_FILE}>
        <Fact label={LABEL_FILENAME} value={image.filename ?? image.key} />
        {catalogKind === 'lightroom' ? <Fact label={LABEL_TITLE} value={image.title} /> : null}
        <Fact
          label={LABEL_DATE}
          value={image.date_taken ? new Date(image.date_taken).toLocaleString() : DATE_NO_DATE}
        />
        <Fact label={LABEL_PATH} value={image.filepath} mono />
        <Fact label={LABEL_DIMENSIONS} value={dimensions} />
        {catalogKind === 'lightroom' ? <Fact label={LABEL_CAPTION} value={image.caption} /> : null}
        <Fact label={IMAGE_DETAILS_POSTED} value={posted ? IMAGE_DETAILS_YES : IMAGE_DETAILS_NO} />
      </FactsBlock>

      <ActionArea>
        <ActionRow label={IMAGE_DETAIL_POSTED_LABEL}>
          <input
            type="checkbox"
            checked={posted}
            disabled={toggling}
            aria-label={IMAGE_DETAIL_POSTED_ARIA}
            onChange={(ev) => void togglePosted(ev.target.checked)}
            className="h-4 w-4 rounded border-border text-accent focus:ring-accent focus:ring-offset-0"
          />
        </ActionRow>
        {error ? (
          <p className="text-sm text-error" role="alert">
            {error}
          </p>
        ) : null}
      </ActionArea>
    </>
  )
}
