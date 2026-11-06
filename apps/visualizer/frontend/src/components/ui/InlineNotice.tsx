import type { ReactNode } from 'react'

type InlineNoticeTone = 'success' | 'error'

const TONE_CLASS: Record<InlineNoticeTone, string> = {
  success: 'border-success/25 bg-success/[0.06] text-text',
  error: 'border-error/25 bg-error/[0.06] text-text',
}

/** Inline success or notice banner (Settings catalog notice, etc.). */
export function InlineNotice({
  tone = 'success',
  children,
  className = '',
}: {
  tone?: InlineNoticeTone
  children: ReactNode
  className?: string
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-tone={tone}
      className={`rounded-base border px-3.5 py-2.5 text-sm ${TONE_CLASS[tone]} ${className}`.trim()}
    >
      {children}
    </div>
  )
}
