import type { ReactNode } from 'react'

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  asTabs = false,
}: {
  options: { id: T; label: ReactNode }[]
  value: T
  onChange: (id: T) => void
  label: string
  /** Sub-tabs get tab semantics; plain choices get pressed buttons. */
  asTabs?: boolean
}) {
  return (
    <div
      className="inline-flex rounded-base border border-border p-0.5"
      role={asTabs ? 'tablist' : 'group'}
      aria-label={label}
    >
      {options.map((o) => {
        const on = o.id === value
        return (
          <button
            key={o.id}
            type="button"
            role={asTabs ? 'tab' : undefined}
            aria-selected={asTabs ? on : undefined}
            aria-pressed={asTabs ? undefined : on}
            className={`px-3 py-1 rounded-base text-xs inline-flex items-center gap-1.5 whitespace-nowrap ${
              on ? 'bg-surface font-semibold text-text' : 'text-text-secondary hover:text-text'
            }`}
            onClick={() => onChange(o.id)}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function EmptyDot({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-warning text-white text-[10.5px] font-bold leading-4 px-1.5">{children}</span>
  )
}
