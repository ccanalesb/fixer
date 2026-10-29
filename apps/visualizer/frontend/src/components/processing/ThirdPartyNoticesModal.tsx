import { useEffect, useId } from 'react'
import { MODAL_CLOSE, MSG_LOADING, SETTINGS_ABOUT_LICENSES_LINK } from '../../constants/strings'
import { Button } from '../ui/Button'
import { Card, CardTitle } from '../ui/Card'

export function ThirdPartyNoticesModal({
  text,
  loading,
  error,
  onClose,
}: {
  text: string | null
  loading: boolean
  error: string | null
  onClose: () => void
}) {
  const titleId = useId()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 overscroll-contain"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-3xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <Card padding="none" className="max-h-[85vh] flex flex-col overflow-hidden shadow-deep">
          <div className="flex justify-between items-center px-4 py-3 border-b border-border shrink-0">
            <CardTitle>
              <span id={titleId}>{SETTINGS_ABOUT_LICENSES_LINK}</span>
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={onClose} type="button">
              {MODAL_CLOSE}
            </Button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-4">
            {loading && <p className="text-sm text-text-secondary">{MSG_LOADING}</p>}
            {error && (
              <p className="text-sm text-error" role="alert">
                {error}
              </p>
            )}
            {!loading && !error && text !== null && (
              <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text leading-relaxed">
                {text}
              </pre>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}
