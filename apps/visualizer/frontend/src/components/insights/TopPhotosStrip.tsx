import { useRef, useState } from 'react'
import type { IdentityBestPhotoItem } from '../../services/api'
import { ImageDetailModal, ImageTile, fromBestPhotoRow, modalPropsFor } from '../image-view'
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
  const [selected, setSelected] = useState<IdentityBestPhotoItem | null>(null)
  const [navIndex, setNavIndex] = useState(0)

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
        {items.map((row, idx) => {
          const dom = pickDominantPerspective(row.per_perspective)
          return (
            <ImageTile
              key={row.image_key}
              image={fromBestPhotoRow(row)}
              variant="strip"
              primaryScoreSource="identity"
              scrollContainerRef={scrollRef}
              onClick={() => {
                setNavIndex(idx)
                setSelected(row)
              }}
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
      {selected ? (
        <ImageDetailModal
          imageKey={items[navIndex]?.image_key ?? selected.image_key}
          {...modalPropsFor('identity')}
          nav={
            items.length > 1
              ? {
                  keys: items.map((r) => r.image_key),
                  index: navIndex,
                  onIndexChange: setNavIndex,
                }
              : undefined
          }
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  )
}
