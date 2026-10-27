import { ConfirmModalFrame } from '../ui/ConfirmUndoAction'
import {
  CLIP_CONFIRM_CANCEL,
  CLIP_CONFIRM_CREDIT,
  CLIP_CONFIRM_DOWNLOAD_IMPORT,
  CLIP_CONFIRM_DOWNLOAD_START,
  CLIP_CONFIRM_IMPORT_DOWNLOADS_MODEL,
  CLIP_CONFIRM_IMPORT_NEEDS_INTERNET,
  CLIP_CONFIRM_IMPORT_READS_CATALOG,
  CLIP_CONFIRM_JOB_IF_EMBED,
  CLIP_CONFIRM_JOB_NEEDS_INTERNET,
  CLIP_CONFIRM_TITLE_IMPORT,
  CLIP_CONFIRM_TITLE_JOB,
} from '../../constants/strings'

export type ClipModelDownloadConfirmVariant = 'import' | 'job'

type Props = {
  variant: ClipModelDownloadConfirmVariant
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ClipModelDownloadConfirm({ variant, busy, onConfirm, onCancel }: Props) {
  const title = variant === 'import' ? CLIP_CONFIRM_TITLE_IMPORT : CLIP_CONFIRM_TITLE_JOB
  const confirmLabel =
    variant === 'import' ? CLIP_CONFIRM_DOWNLOAD_IMPORT : CLIP_CONFIRM_DOWNLOAD_START

  return (
    <ConfirmModalFrame
      title={title}
      confirmLabel={confirmLabel}
      cancelLabel={CLIP_CONFIRM_CANCEL}
      confirmVariant="primary"
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {variant === 'import' ? (
        <ul className="list-disc space-y-2 pl-5 text-sm text-text-secondary">
          <li>{CLIP_CONFIRM_IMPORT_READS_CATALOG}</li>
          <li>{CLIP_CONFIRM_IMPORT_DOWNLOADS_MODEL}</li>
          <li>{CLIP_CONFIRM_IMPORT_NEEDS_INTERNET}</li>
        </ul>
      ) : (
        <ul className="list-disc space-y-2 pl-5 text-sm text-text-secondary">
          <li>{CLIP_CONFIRM_JOB_IF_EMBED}</li>
          <li>{CLIP_CONFIRM_JOB_NEEDS_INTERNET}</li>
        </ul>
      )}
      <p className="text-xs text-text-tertiary">{CLIP_CONFIRM_CREDIT}</p>
    </ConfirmModalFrame>
  )
}
