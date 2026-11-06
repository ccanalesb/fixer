import { useState } from 'react'
import type { ReactNode } from 'react'
import { LrWritebackAPI, ImagesAPI, type FolderXmpDetailResponse, type ImageView, type LrWritebackPhotoDetailResponse } from '../../../services/api'
import { keys, useQuery } from '../../../data'
import { Button } from '../../ui/Button/Button'
import {
  LABEL_CAPTION,
  LABEL_COLOR,
  LABEL_COPYRIGHT,
  LABEL_KEYWORDS,
  LABEL_TITLE,
  LR_WRITEBACK_APP_KEYWORDS,
  LR_WRITEBACK_BEFORE_NO_RATING,
  LR_WRITEBACK_RATING,
  LR_WRITEBACK_UNDO,
  LR_WRITEBACK_UNDO_REJECT_ROW,
  LR_WRITEBACK_UNDO_STARS_ROW,
  FOLDER_WRITEBACK_WRITTEN_DETAIL,
  XMP_DETAIL_SECTION,
  XMP_FILE_MISSING,
  XMP_NO_METADATA_HINT,
  XMP_REJECT_LABEL,
  XMP_SECONDARY_SIDECAR,
  XMP_WRITEBACK_LOAD_ERROR,
} from '../../../constants/strings'
import { formatDateTime } from '../../../utils/date'
import { ActionArea, ActionRow, Fact, FactsBlock, StatusBlock } from '../detail-blocks'

function ValueWithSource({ value, source }: { value: ReactNode; source?: string | null }) {
  return (
    <>
      {value}
      {source ? <span className="mt-0.5 block text-xs text-text-tertiary">{source}</span> : null}
    </>
  )
}

function ratingLine(
  detail: FolderXmpDetailResponse,
  writeback: LrWritebackPhotoDetailResponse | null,
): ReactNode {
  let display = detail.rating.display
  if (writeback?.rating.live != null && writeback.rating.live > 0) {
    display = `${writeback.rating.live}★`
  }
  const extras: ReactNode[] = []
  if (writeback?.rating.app_wrote) {
    extras.push(
      <span key="app" className="ml-2 text-text-tertiary">
        written by the app
      </span>,
    )
  }
  if (writeback?.written_file_label && writeback.written_at) {
    const when = formatDateTime(writeback.written_at)
    if (when) {
      extras.push(
        <span key="written" className="ml-2 block text-text-tertiary">
          {FOLDER_WRITEBACK_WRITTEN_DETAIL(writeback.written_file_label, when)}
        </span>,
      )
    }
  }
  const before =
    writeback?.rating.before_label ??
    (writeback?.rating.app_wrote && writeback.rating.live === null ? LR_WRITEBACK_BEFORE_NO_RATING : null)
  if (before) {
    extras.push(
      <span key="before" className="ml-2 text-text-tertiary">
        {before}
      </span>,
    )
  }
  return (
    <ValueWithSource
      source={detail.rating.source}
      value={
        <>
          {display}
          {extras}
        </>
      }
    />
  )
}

function rejectLine(
  detail: FolderXmpDetailResponse,
  writeback: LrWritebackPhotoDetailResponse | null,
): ReactNode | null {
  if (!detail.reject.display) return null
  return (
    <ValueWithSource
      source={detail.reject.source}
      value={
        <>
          {detail.reject.display}
          {writeback?.flag.app_wrote_reject ? (
            <span className="ml-2 text-text-tertiary">written by the app</span>
          ) : null}
        </>
      }
    />
  )
}

type WritebackReadout =
  | { detail: LrWritebackPhotoDetailResponse; error: null }
  | { detail: null; error: string }

/** A failed read stays visible: it must not look like "nothing written". */
async function fetchWritebackReadout(imageKey: string): Promise<WritebackReadout> {
  try {
    return { detail: await LrWritebackAPI.getPhoto(imageKey), error: null }
  } catch (e) {
    return { detail: null, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Folder catalog: ratings, labels and keywords read from XMP/IPTC, with each field's source. */
export function XmpTab({ image }: { image: ImageView }) {
  const detail = useQuery(keys.folderXmp.photo(image.key), () => ImagesAPI.getFolderXmpDetail(image.key))
  const readout = useQuery(keys.lrWriteback.readout(image.key), () =>
    fetchWritebackReadout(image.key),
  )
  const writeback = readout.detail
  const [undoError, setUndoError] = useState<string | null>(null)

  const undo = async (kind: 'stars' | 'reject') => {
    setUndoError(null)
    try {
      const result = await LrWritebackAPI.undo(image.key, kind)
      if (!result.ok) setUndoError(result.reason ?? 'Undo failed.')
    } catch (e) {
      setUndoError(e instanceof Error ? e.message : 'Undo failed.')
    }
  }

  const appKeywords = writeback && writeback.keywords.length > 0 ? writeback.keywords.join(', ') : null

  return (
    <>
      {detail.file_missing ? (
        <StatusBlock tone="warning" title={XMP_FILE_MISSING} />
      ) : null}
      {detail.no_metadata_hint ? (
        <p className="text-sm text-text-secondary">{XMP_NO_METADATA_HINT}</p>
      ) : null}
      <FactsBlock title={XMP_DETAIL_SECTION}>
        <Fact label={LR_WRITEBACK_RATING} value={ratingLine(detail, writeback)} />
        <Fact label={XMP_REJECT_LABEL} value={rejectLine(detail, writeback)} />
        <Fact
          label={LABEL_COLOR}
          value={
            detail.label.value ? (
              <ValueWithSource value={detail.label.value} source={detail.label.source} />
            ) : null
          }
        />
        <Fact
          label={LABEL_KEYWORDS}
          value={
            detail.keywords.values.length > 0 ? (
              <ValueWithSource
                source={detail.keywords.source}
                value={
                  <span className="flex flex-wrap gap-1">
                    {detail.keywords.values.map((k) => (
                      <span key={k} className="rounded bg-surface px-1.5 text-xs">
                        {k}
                      </span>
                    ))}
                  </span>
                }
              />
            ) : null
          }
        />
        <Fact label={LR_WRITEBACK_APP_KEYWORDS} value={appKeywords} />
        <Fact
          label={LABEL_TITLE}
          value={
            detail.title.value ? (
              <ValueWithSource value={detail.title.value} source={detail.title.source} />
            ) : null
          }
        />
        <Fact
          label={LABEL_CAPTION}
          value={
            detail.caption.value ? (
              <ValueWithSource value={detail.caption.value} source={detail.caption.source} />
            ) : null
          }
        />
        <Fact
          label={LABEL_COPYRIGHT}
          value={
            detail.copyright.value ? (
              <ValueWithSource value={detail.copyright.value} source={detail.copyright.source} />
            ) : null
          }
        />
      </FactsBlock>
      {detail.secondary_sidecar_note ? (
        <p className="text-xs text-text-tertiary">
          {XMP_SECONDARY_SIDECAR(
            detail.secondary_sidecar_note.basename,
            detail.secondary_sidecar_note.read_after_basename,
          )}
        </p>
      ) : null}
      {readout.error ? (
        <p className="text-xs text-error" role="alert">
          {XMP_WRITEBACK_LOAD_ERROR} {readout.error}
        </p>
      ) : null}
      {writeback?.strong_dimensions_line ? (
        <p className="text-xs text-text-secondary">{writeback.strong_dimensions_line}</p>
      ) : null}
      {writeback?.user_changed_message ? (
        <p className="text-xs text-warning">{writeback.user_changed_message}</p>
      ) : null}
      {undoError ? <p className="text-xs text-error">{undoError}</p> : null}

      <ActionArea>
        {writeback?.rating.undo_available ? (
          <ActionRow label={LR_WRITEBACK_UNDO_STARS_ROW}>
            <Button type="button" size="sm" variant="secondary" onClick={() => void undo('stars')}>
              {LR_WRITEBACK_UNDO}
            </Button>
          </ActionRow>
        ) : null}
        {writeback?.flag.undo_available ? (
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
