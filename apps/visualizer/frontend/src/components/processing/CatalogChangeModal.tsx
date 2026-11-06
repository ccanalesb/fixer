import { ConfirmModalFrame } from '../ui/ConfirmUndoAction'
import { STATUS_LABELS } from '../../constants/strings'
import { jobTypeLabel } from '../../utils/jobTypeLabel'
import {
  catalogChangeMode,
  type SameCatalogChoice,
} from '../../hooks/useCatalogPicker'
import type { ConfigCatalogChangePreviewResponse } from '../../types/config'

export function CatalogChangeModal({
  preview,
  sameChoice,
  onSameChoice,
  saving,
  onCancel,
  onConfirm,
}: {
  preview: ConfigCatalogChangePreviewResponse
  sameChoice: SameCatalogChoice | null
  onSameChoice: (choice: SameCatalogChoice) => void
  saving: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const { current, next, ask_same_or_different: askSame, jobs_to_cancel: jobs } = preview
  const mode = catalogChangeMode(preview, sameChoice)

  return (
    <ConfirmModalFrame
      title={askSame ? `Change the catalog to ${next.display_name}?` : `Switch to ${next.display_name}?`}
      confirmLabel={mode === 'update_path' ? 'Update the path' : 'Switch catalog'}
      cancelLabel="Cancel"
      confirmVariant="primary"
      busy={saving}
      confirmDisabled={!mode}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <div className="max-h-[60vh] space-y-4 overflow-y-auto text-sm text-text-secondary">
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
        {mode === 'switch' ? <Consequences current={current} next={next} jobs={jobs} /> : null}
        {mode === 'update_path' ? <p>The library stays. No jobs are cancelled.</p> : null}
      </div>
    </ConfirmModalFrame>
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
                {jobTypeLabel(job.type)} — {STATUS_LABELS[job.status] ?? job.status}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
