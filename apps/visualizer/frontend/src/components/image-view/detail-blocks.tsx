import { Children, type ReactNode } from 'react'
import { Spinner } from '../ui/Spinner'

/**
 * The only building blocks of an image detail tab (see "Image detail modal" in CONTEXT.md).
 * Blocks are read-only; every button of a tab lives in its `ActionArea`, which comes last.
 */

export function BlockHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">{children}</h3>
  )
}

type Tone = 'success' | 'warning' | 'error' | 'neutral'

const TONE_TEXT: Record<Tone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-error',
  neutral: 'text-text',
}

const TONE_DOT: Record<Tone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-error',
  neutral: 'bg-text-tertiary',
}

/** A decision about this photo: one coloured line, then what it rests on. */
export function StatusBlock({
  tone,
  title,
  children,
}: {
  tone: Tone
  title: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="rounded-base border border-border px-4 py-3">
      <p className={`flex items-center gap-2 text-sm font-semibold ${TONE_TEXT[tone]}`}>
        <span className={`h-2 w-2 shrink-0 rounded-full ${TONE_DOT[tone]}`} aria-hidden />
        {title}
      </p>
      {children ? <div className="mt-1 space-y-1 text-sm text-text-secondary">{children}</div> : null}
    </section>
  )
}

/** Label/value rows read from the catalog or the file. */
export function FactsBlock({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <section>
      {title ? <BlockHeading>{title}</BlockHeading> : null}
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm">{children}</dl>
    </section>
  )
}

/** One row of a `FactsBlock`; renders nothing without a value. */
export function Fact({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <>
      <dt className="text-text-tertiary">{label}</dt>
      <dd className={`min-w-0 break-words text-text ${mono ? 'font-mono text-xs leading-5' : ''}`}>{value}</dd>
    </>
  )
}

/** What a model wrote about this photo. */
export function GeneratedBlock({
  title,
  busy,
  error,
  children,
}: {
  title: ReactNode
  busy?: ReactNode
  error?: string | null
  children: ReactNode
}) {
  return (
    <section className="rounded-base bg-surface px-4 py-3">
      <BlockHeading>{title}</BlockHeading>
      {error ? (
        <p className="mb-2 text-sm text-error" role="alert">
          {error}
        </p>
      ) : null}
      {busy ? (
        <p className="mb-2 flex items-center gap-2 text-sm text-text-secondary" role="status">
          <Spinner sizeClass="h-4 w-4" />
          {busy}
        </p>
      ) : null}
      {children}
    </section>
  )
}

/** Shows something whose actions reach beyond this photo. */
export function ToolBlock({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-base border border-dashed border-border-strong px-4 py-3">
      <BlockHeading>{title}</BlockHeading>
      {children}
    </section>
  )
}

/** The end of a tab: every action it offers, one row per thing it acts on. */
export function ActionArea({ children }: { children: ReactNode }) {
  if (Children.toArray(children).length === 0) return null
  return <div className="space-y-3 border-t border-border pt-4">{children}</div>
}

/** Names what it acts on, then its controls. */
export function ActionRow({
  label,
  hint,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-text-secondary">{label}</span>
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      </div>
      {hint ? <p className="mt-1 text-xs text-text-tertiary">{hint}</p> : null}
    </div>
  )
}
