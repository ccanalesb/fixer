import { useRef } from 'react'
import type { IdentityBestPhotoItem } from '../../services/api'
import { ImageDetailModal, ImageTile, fromBestPhotoRow, modalPropsFor, useListNav } from '../image-view'
import { PerspectiveBadge } from '../ui/badges'
import { pickDominantPerspective } from '../identity/pickDominantPerspective'
import { MSG_LOADING } from '../../constants/strings'

export type TopPhotosStripProps = {
  items: IdentityBestPhotoItem[]
  loading: boolean
  error: string | null
  emptyMessage: string | null
}

export function TopPhotosStrip({ items, loading, error, emptyMessage }: TopPhotosStripProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const listNav = useListNav(items.map((r) => r.image_key))

  if (loading) {
    return (
      <p className="text-sm text-text-secondary" role="status" aria-live="polite">
        {MSG_LOADING}
      </p>
    )
  }

  if (error) {
    return (
      <p className="text-sm text-error" role="alert">
        {error}
      </p>
    )
  }

  if (emptyMessage) {
    return (
      <p className="text-sm text-text-secondary" role="status">
        {emptyMessage}
      </p>
    )
  }

  if (items.length === 0) {
    return null
  }

  return (
    <>
      <div ref={scrollRef} className="-mx-1 flex gap-3 overflow-x-auto pb-2 pt-1">
        {items.map((row) => {
          const dom = pickDominantPerspective(row.per_perspective)
          return (
            <ImageTile
              key={row.image_key}
              image={fromBestPhotoRow(row)}
              variant="strip"
              primaryScoreSource="identity"
              scrollContainerRef={scrollRef}
              onClick={() => listNav.open(row.image_key)}
              footer={
                dom ? (
                  <PerspectiveBadge
                    perspectiveSlug={dom.perspective_slug}
                    score={dom.score}
                    displayName={dom.display_name}
                  />
                ) : null
              }
            />
          )
        })}
      </div>
      {listNav.openKey ? (
        <ImageDetailModal
          imageKey={listNav.openKey}
          {...modalPropsFor('identity')}
          nav={listNav.nav}
          onClose={listNav.close}
        />
      ) : null}
    </>
  )
}
