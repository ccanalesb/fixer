import type { Job } from '../../types/job'
import {
  CATALOG_CACHE_BUILD_STAGE_LABELS,
  CATALOG_CACHE_BUILD_STAGE_ORDER,
  catalogCacheBuildStageState,
  parseEmbedProgressDetail,
} from '../../utils/catalogCacheBuildProgress'

function StageDot({ state }: { state: 'pending' | 'current' | 'done' }) {
  if (state === 'done') {
    return (
      <span
        className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full border-2 border-success bg-success text-[11px] font-bold text-white"
        aria-hidden
      >
        ✓
      </span>
    )
  }
  if (state === 'current') {
    return (
      <span
        className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full border-2 border-accent border-t-transparent animate-spin"
        aria-hidden
      />
    )
  }
  return (
    <span
      className="h-[18px] w-[18px] flex-none rounded-full border-2 border-border-strong"
      aria-hidden
    />
  )
}

export function CatalogImportStageChecklist({ job }: { job: Job | null }) {
  const embedDetail =
    job && catalogCacheBuildStageState('embed', job) === 'current'
      ? parseEmbedProgressDetail(job.current_step)
      : null

  return (
    <ol className="list-none space-y-1 p-0 m-0">
      {CATALOG_CACHE_BUILD_STAGE_ORDER.map((key) => {
        const state = catalogCacheBuildStageState(key, job)
        const label = CATALOG_CACHE_BUILD_STAGE_LABELS[key]
        const rowClass =
          state === 'done'
            ? 'text-text-secondary'
            : state === 'current'
              ? 'text-text font-semibold'
              : 'text-text-tertiary'

        return (
          <li key={key}>
            <div className={`flex items-center gap-2.5 py-1 text-sm ${rowClass}`}>
              <StageDot state={state} />
              <span>{label}</span>
              {key === 'embed' && embedDetail ? (
                <span className="text-xs text-text-tertiary tabular-nums">{embedDetail}</span>
              ) : null}
            </div>
            {key === 'sync' ? (
              <div
                className="h-3"
                aria-hidden
                data-testid="catalog-import-clip-slot"
                title=""
              />
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
