import { useId } from 'react'
import { Button } from '../ui/Button'
import type { ConfigCatalogChangePreviewResponse } from '../../types/config'

type SameChoice = 'same' | 'different'

export function CatalogChangeModal({
  preview,
  sameChoice,
  onSameChoice,
  saving,
  onCancel,
  onConfirm,
}: {
  preview: ConfigCatalogChangePreviewResponse
  sameChoice: SameChoice | null
  onSameChoice: (choice: SameChoice) => void
  saving: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const titleId = useId()
  const { current, next, ask_same_or_different: askSame, jobs_to_cancel: jobs } = preview
  const showConsequences = !askSame || sameChoice === 'different'
  const confirmMode: 'update_path' | 'switch' | null =
    askSame && sameChoice === 'same'
      ? 'update_path'
      : showConsequences && (sameChoice === 'different' || !askSame)
        ? 'switch'
        : null

  const title = askSame
    ? `Change the catalog to ${next.display_name}?`
    : `Switch to ${next.display_name}?`

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-card border border-border-strong bg-bg shadow-deep"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border p-4">
          <h3 id={titleId} className="text-lg font-semibold text-text">
            {title}
          </h3>
        </div>
        <div className="space-y-4 overflow-y-auto p-4 text-sm text-text-secondary">
          {askSame ? (
            <>
              <p>{next.display_name} has no library in Fixer yet.</p>
              <div className="space-y-2">
                <Choice
                  name="same-catalog"
                  checked={sameChoice === 'same'}
                  onSelect={() => onSameChoice('same')}
                  title="The same catalog"
                  description="Moved, or written anew by a Lightroom upgrade. The library stays; only the path changes."
                />
                <Choice
                  name="same-catalog"
                  checked={sameChoice === 'different'}
                  onSelect={() => onSameChoice('different')}
                  title="A different catalog"
                  description="Starts its own empty library. The current one is kept."
                />
              </div>
            </>
          ) : null}
          {showConsequences ? (
            <Consequences current={current} next={next} jobs={jobs} />
          ) : null}
          {sameChoice === 'same' ? (
            <p>The library stays. No jobs are cancelled.</p>
          ) : null}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border p-4">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={onConfirm}
            disabled={saving || !confirmMode}
          >
            {saving
              ? 'Saving…'
              : confirmMode === 'update_path'
                ? 'Update the path'
                : 'Switch catalog'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Choice({
  name,
  checked,
  onSelect,
  title,
  description,
}: {
  name: string
  checked: boolean
  onSelect: () => void
  title: string
  description: string
}) {
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-base border p-3 ${
        checked ? 'border-accent bg-accent-light/30' : 'border-border'
      }`}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onSelect}
        className="mt-1"
      />
      <span>
        <span className="font-medium text-text">{title}</span>
        <br />
        <span className="text-text-secondary">{description}</span>
      </span>
    </label>
  )
}

function Consequences({
  current,
  next,
  jobs,
}: {
  current: ConfigCatalogChangePreviewResponse['current']
  next: ConfigCatalogChangePreviewResponse['next']
  jobs: ConfigCatalogChangePreviewResponse['jobs_to_cancel']
}) {
  return (
    <div className="space-y-3">
      <p>
        {next.has_library && next.library_photo_count != null ? (
          <>
            <span className="font-medium text-text">{next.display_name}</span> reopens with the
            library you had for it: {next.library_photo_count.toLocaleString('en-US')} photos,
            their descriptions, scores and culling.
          </>
        ) : (
          <>
            <span className="font-medium text-text">{next.display_name}</span> starts empty. Fixer
            reads it as soon as you switch.
          </>
        )}
      </p>
      <p>
        Everything for <span className="font-medium text-text">{current.display_name}</span> is kept
        and comes back if you choose it again.
      </p>
      {jobs.length > 0 ? (
        <div>
          <p>
            Switching cancels {jobs.length} job{jobs.length === 1 ? '' : 's'} on photos:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {jobs.map((job) => (
              <li key={job.id}>
                {job.type} — {job.status}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
