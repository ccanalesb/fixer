import { useCallback, useEffect, useState } from 'react'
import { LrWritebackAPI, type ImageView, type LrWritebackPhotoDetailResponse } from '../../../services/api'
import { Button } from '../../ui/Button/Button'
import {
  LABEL_KEYWORDS,
  LR_WRITEBACK_APP_KEYWORDS,
  LR_WRITEBACK_BEFORE_NO_RATING,
  LR_WRITEBACK_DETAIL_SECTION,
  LR_WRITEBACK_FLAG,
  LR_WRITEBACK_PICK,
  LR_WRITEBACK_RATING,
  LR_WRITEBACK_UNDO,
  LR_WRITEBACK_UNDO_REJECT_ROW,
  LR_WRITEBACK_UNDO_STARS_ROW,
  LR_WRITEBACK_USER_CHANGED,
} from '../../../constants/strings'
import { ActionArea, ActionRow, Fact, FactsBlock } from '../detail-blocks'

function starsValue(image: ImageView, detail: LrWritebackPhotoDetailResponse | null): string {
  if (!detail) return typeof image.rating === 'number' && image.rating > 0 ? `${image.rating}★` : 'no rating'
  if (detail.rating.live !== null) return `${detail.rating.live}★`
  return detail.rating.app_wrote ? 'written by the app' : 'no rating'
}

function flagValue(image: ImageView, detail: LrWritebackPhotoDetailResponse | null): string | null {
  if (!detail) return image.pick ? LR_WRITEBACK_PICK : null
  if (detail.flag.live_pick === -1) return 'Reject'
  return detail.flag.app_wrote_reject ? 'written by the app' : 'not written'
}

/** What Lightroom Classic holds for the photo, including what the app wrote there. */
export function LightroomTab({ image }: { image: ImageView }) {
  const [detail, setDetail] = useState<LrWritebackPhotoDetailResponse | null>(null)

  const load = useCallback(async () => {
    try {
      setDetail(await LrWritebackAPI.getPhoto(image.key))
    } catch {
      setDetail(null)
    }
  }, [image.key])

  useEffect(() => {
    void load()
  }, [load])

  const undo = async (kind: 'stars' | 'reject') => {
    await LrWritebackAPI.undo(image.key, kind)
    await load()
  }

  const keywords = Array.isArray(image.keywords) ? image.keywords : []
  const beforeLabel =
    detail?.rating.before_label ??
    (detail?.rating.app_wrote && detail.rating.live === null ? LR_WRITEBACK_BEFORE_NO_RATING : null)

  return (
    <>
      <FactsBlock title={LR_WRITEBACK_DETAIL_SECTION}>
        <Fact
          label={LR_WRITEBACK_RATING}
          value={
            <>
              {starsValue(image, detail)}
              {beforeLabel ? <span className="ml-2 text-text-tertiary">{beforeLabel}</span> : null}
            </>
          }
        />
        <Fact label={LR_WRITEBACK_FLAG} value={flagValue(image, detail)} />
        <Fact
          label={LABEL_KEYWORDS}
          value={
            keywords.length > 0 ? (
              <span className="flex flex-wrap gap-1">
                {keywords.map((k) => (
                  <span key={k} className="rounded bg-surface px-1.5 text-xs">
                    {k}
                  </span>
                ))}
              </span>
            ) : null
          }
        />
        <Fact
          label={LR_WRITEBACK_APP_KEYWORDS}
          value={detail && detail.keywords.length > 0 ? detail.keywords.join(', ') : null}
        />
      </FactsBlock>
      {detail?.strong_dimensions_line ? (
        <p className="text-xs text-text-secondary">{detail.strong_dimensions_line}</p>
      ) : null}
      {detail?.rating.user_changed || detail?.flag.user_changed ? (
        <p className="text-xs text-warning">{LR_WRITEBACK_USER_CHANGED}</p>
      ) : null}

      <ActionArea>
        {detail?.rating.undo_available ? (
          <ActionRow label={LR_WRITEBACK_UNDO_STARS_ROW}>
            <Button type="button" size="sm" variant="secondary" onClick={() => void undo('stars')}>
              {LR_WRITEBACK_UNDO}
            </Button>
          </ActionRow>
        ) : null}
        {detail?.flag.undo_available ? (
          <ActionRow label={LR_WRITEBACK_UNDO_REJECT_ROW}>
            <Button type="button" size="sm" variant="secondary" onClick={() => void undo('reject')}>
              {LR_WRITEBACK_UNDO}
            </Button>
          </ActionRow>
        ) : null}
      </ActionArea>
    </>
  )
}
