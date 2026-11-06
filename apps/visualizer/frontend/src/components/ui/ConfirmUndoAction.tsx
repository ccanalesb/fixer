import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button } from './Button/Button'

export const DEFAULT_UNDO_TIMEOUT_MS = 8000

export type ConfirmModalFrameProps = {
  /** Backdrop + card z-index (default above main modal). */
  zIndexClass?: string
  title: ReactNode
  children: ReactNode
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  onCancel: () => void
  busy?: boolean
  /** Disables only the confirm button, e.g. until a required choice is made. */
  confirmDisabled?: boolean
  confirmVariant?: 'danger' | 'primary'
}

/**
 * Shared destructive-confirm shell (backdrop, card, footer actions).
 * Used by match reject and stack mutations.
 */
export function ConfirmModalFrame({
  zIndexClass = 'z-[60]',
  title,
  children,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  busy = false,
  confirmDisabled = false,
  confirmVariant = 'danger',
}: ConfirmModalFrameProps) {
  const titleId = useId()

  return (
    <div
      className={`fixed inset-0 bg-black/70 flex items-center justify-center ${zIndexClass} p-4`}
      onClick={onCancel}
      onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-lg max-w-lg w-full shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b">
          <h3 id={titleId} className="text-lg font-bold text-text">{title}</h3>
        </div>

        <div className="p-4 space-y-4">{children}</div>

        <div className="flex justify-end gap-2 p-4 border-t bg-gray-50 rounded-b-lg">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 rounded text-sm font-medium text-gray-700 hover:bg-gray-200 transition-colors"
          >
            {cancelLabel}
          </button>
          {confirmVariant === 'danger' ? (
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy || confirmDisabled}
              className="px-4 py-2 rounded text-sm font-medium bg-red-600 text-white hover:bg-red-700 transition-colors"
            >
              {busy ? '…' : confirmLabel}
            </button>
          ) : (
            <Button
              type="button"
              variant="primary"
              size="md"
              disabled={busy || confirmDisabled}
              onClick={onConfirm}
            >
              {busy ? '…' : confirmLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

type UndoToastState =
  | { kind: 'hidden' }
  | { kind: 'visible'; message: string; onUndo?: () => Promise<void> }

export type UseUndoToastResult = {
  toast: UndoToastState
  /** After a successful mutation: show a timed bar. Omit *onUndo* to skip the Undo control. */
  offerUndo: (message: string, onUndo?: () => Promise<void>) => void
  dismissToast: () => void
  runUndo: () => Promise<void>
}

/**
 * Timed undo affordance after destructive success. Works with optional *onUndo*
 * when server rollback exists (e.g. revert stack representative).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useUndoToast(options?: { timeoutMs?: number }): UseUndoToastResult {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_UNDO_TIMEOUT_MS
  const [toast, setToast] = useState<UndoToastState>({ kind: 'hidden' })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const dismissToast = useCallback(() => {
    clearTimer()
    setToast({ kind: 'hidden' })
  }, [clearTimer])

  const offerUndo = useCallback(
    (message: string, onUndo?: () => Promise<void>) => {
      clearTimer()
      if (onUndo != null) {
        setToast({ kind: 'visible', message, onUndo })
      } else {
        setToast({ kind: 'visible', message })
      }
      timerRef.current = setTimeout(() => {
        setToast({ kind: 'hidden' })
        timerRef.current = null
      }, timeoutMs)
    },
    [clearTimer, timeoutMs],
  )

  const runUndo = useCallback(async () => {
    if (toast.kind !== 'visible' || !toast.onUndo) return
    const fn = toast.onUndo
    dismissToast()
    await fn()
  }, [toast, dismissToast])

  useEffect(() => () => clearTimer(), [clearTimer])

  return { toast, offerUndo, dismissToast, runUndo }
}

export type UndoToastBarProps = {
  toast: UndoToastState
  undoLabel: string
  onUndo?: () => void
  /** Accessibility label for the live region */
  politeness?: 'polite' | 'assertive'
}

export function UndoToastBar({ toast, undoLabel, onUndo, politeness = 'polite' }: UndoToastBarProps) {
  if (toast.kind !== 'visible') return null

  return (
    <div
      className="fixed bottom-4 left-1/2 z-[70] flex max-w-md -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-bg px-4 py-3 shadow-deep"
      style={{ backgroundColor: 'var(--color-background)' }}
      role="status"
      aria-live={politeness}
    >
      <p className="text-sm text-text">{toast.message}</p>
      {toast.onUndo != null ? (
        <button
          type="button"
          className="shrink-0 text-sm font-semibold text-accent underline"
          onClick={onUndo}
        >
          {undoLabel}
        </button>
      ) : null}
    </div>
  )
}
