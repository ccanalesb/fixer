import { useId } from 'react'
import { Button } from '../ui/Button/Button'
import { Input } from '../ui/Input/Input'
import {
  FIRST_RUN_MANUAL_PATH_DISCLOSURE,
  FIRST_RUN_MANUAL_PATH_LABEL,
  SETTINGS_CATALOG_MANUAL_PATH_HINT,
} from '../../constants/strings'
import { catalogKindOfPath } from '../../utils/catalogPath'

/**
 * "Enter a path manually": a disclosure holding the typed catalog path, the kind
 * it reads as, and its submit. Shared by the setup screen and the Settings row.
 */
export function CatalogManualPath({
  open,
  onToggle,
  busy,
  value,
  onChange,
  submitLabel,
  onSubmit,
  submitDisabled = false,
  onCancel,
  buttonSize = 'sm',
}: {
  open: boolean
  onToggle: () => void
  busy: boolean
  value: string
  onChange: (value: string) => void
  submitLabel: string
  onSubmit: () => void
  submitDisabled?: boolean
  onCancel?: () => void
  buttonSize?: 'sm' | 'md'
}) {
  const inputId = useId()
  const typed = value.trim()

  return (
    <details open={open} className="group">
      <summary
        aria-disabled={busy}
        onClick={(e) => {
          e.preventDefault()
          if (busy) return
          onToggle()
        }}
        className={`inline-flex list-none items-center gap-1 text-sm font-medium [&::-webkit-details-marker]:hidden ${
          busy ? 'cursor-default text-text-tertiary' : 'cursor-pointer text-accent'
        }`}
      >
        <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-90">
          ›
        </span>
        {FIRST_RUN_MANUAL_PATH_DISCLOSURE}
      </summary>
      <div className="mt-3 space-y-3">
        <Input
          id={inputId}
          label={FIRST_RUN_MANUAL_PATH_LABEL}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={busy}
          fullWidth
        />
        {typed ? (
          <p className="text-sm text-text-tertiary">
            {catalogKindOfPath(typed) === 'lightroom'
              ? 'Ends in .lrcat, so this is a Lightroom catalog.'
              : 'Not a .lrcat file, so this is a folder catalog.'}
          </p>
        ) : null}
        <p className="text-sm text-text-tertiary">{SETTINGS_CATALOG_MANUAL_PATH_HINT}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size={buttonSize}
            variant="primary"
            onClick={onSubmit}
            disabled={busy || !typed || submitDisabled}
          >
            {submitLabel}
          </Button>
          {onCancel ? (
            <Button type="button" size={buttonSize} variant="ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          ) : null}
        </div>
      </div>
    </details>
  )
}
