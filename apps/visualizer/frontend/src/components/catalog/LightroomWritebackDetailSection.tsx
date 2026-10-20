import { useCallback, useEffect, useState } from 'react'
import { LrWritebackAPI, type LrWritebackPhotoDetailResponse } from '../../services/api'
import { Button } from '../ui/Button/Button'
import { MetadataRow } from '../ui/MetadataRow'
import {
  LR_WRITEBACK_DETAIL_SECTION,
  LR_WRITEBACK_FLAG,
  LR_WRITEBACK_KEYWORDS,
  LR_WRITEBACK_RATING,
  LR_WRITEBACK_UNDO,
  LR_WRITEBACK_USER_CHANGED,
} from '../../constants/strings'

export function LightroomWritebackDetailSection({ imageKey }: { imageKey: string }) {
  const [detail, setDetail] = useState<LrWritebackPhotoDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setDetail(await LrWritebackAPI.getPhoto(imageKey))
    } catch {
      setDetail(null)
    } finally {
      setLoading(false)
    }
  }, [imageKey])

  useEffect(() => {
    void load()
  }, [load])

  const undo = async (kind: 'stars' | 'reject') => {
    await LrWritebackAPI.undo(imageKey, kind)
    await load()
  }

  if (loading && !detail) return null
  if (!detail) return null

  const starsDisplay =
    detail.rating.live !== null
      ? `${detail.rating.live}★`
      : detail.rating.app_wrote
        ? 'written by the app'
        : 'no rating'

  return (
    <section className="space-y-2">
      <h4 className="text-sm font-semibold text-text">{LR_WRITEBACK_DETAIL_SECTION}</h4>
      {detail.strong_dimensions_line ? (
        <p className="text-xs text-text-secondary">{detail.strong_dimensions_line}</p>
      ) : null}
      <MetadataRow label={LR_WRITEBACK_RATING} value={starsDisplay} />
      {detail.rating.before_label ? (
        <p className="text-xs text-text-secondary">{detail.rating.before_label}</p>
      ) : detail.rating.app_wrote && detail.rating.live === null ? (
        <p className="text-xs text-text-secondary">before: no rating</p>
      ) : null}
      {detail.rating.user_changed ? (
        <p className="text-xs text-warning">{LR_WRITEBACK_USER_CHANGED}</p>
      ) : null}
      {detail.rating.undo_available ? (
        <Button type="button" size="sm" variant="secondary" onClick={() => void undo('stars')}>
          {LR_WRITEBACK_UNDO}
        </Button>
      ) : null}
      <MetadataRow
        label={LR_WRITEBACK_FLAG}
        value={
          detail.flag.live_pick === -1
            ? 'Reject'
            : detail.flag.app_wrote_reject
              ? 'written by the app'
              : 'not written'
        }
      />
      {detail.flag.user_changed ? (
        <p className="text-xs text-warning">{LR_WRITEBACK_USER_CHANGED}</p>
      ) : null}
      {detail.flag.undo_available ? (
        <Button type="button" size="sm" variant="secondary" onClick={() => void undo('reject')}>
          {LR_WRITEBACK_UNDO}
        </Button>
      ) : null}
      {detail.keywords.length > 0 ? (
        <MetadataRow label={LR_WRITEBACK_KEYWORDS} value={detail.keywords.join(', ')} />
      ) : null}
    </section>
  )
}
