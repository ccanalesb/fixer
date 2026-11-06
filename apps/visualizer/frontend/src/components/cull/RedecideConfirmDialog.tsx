import { useEffect, useId } from 'react'
import { Button } from '../ui/Button'
import {
  CULL_REDECIDE_CONFIRM_BODY,
  CULL_REDECIDE_CONFIRM_BODY_FOLDER,
  CULLING_CANCEL,
} from '../../constants/strings'
import { useCatalogKind } from '../../hooks/useCatalogKind'
import { forCatalogKind } from '../../utils/catalogKindCopy'

/** Before a change that queues a re-decide job. */
export function RedecideConfirmDialog({
  title,
  body = CULL_REDECIDE_CONFIRM_BODY,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string
  body?: string
  confirmLabel: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const titleId = useId()
  const catalogKind = useCatalogKind()
  const resolvedBody =
    body ??
    forCatalogKind(catalogKind, CULL_REDECIDE_CONFIRM_BODY, CULL_REDECIDE_CONFIRM_BODY_FOLDER)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/35 p-4" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-[480px] rounded-card border border-border-strong bg-bg p-6 shadow-deep"
        onClick={(e) => e.stopPropagation()}
      >
        <h5 id={titleId} className="mb-2 text-lg font-bold tracking-tight text-text">
          {title}
        </h5>
        <p className="text-sm text-text-secondary">{resolvedBody}</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {CULLING_CANCEL}
          </Button>
          <Button type="button" variant="primary" size="sm" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
