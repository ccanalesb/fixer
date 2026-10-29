import type { Job } from '../../types/job'
import {
  CATALOG_CACHE_BUILD_STAGE_LABELS,
  CATALOG_CACHE_BUILD_STAGE_ORDER,
  catalogCacheBuildStageState,
  parseEmbedProgressDetail,
} from '../../utils/catalogCacheBuildProgress'
import {
  CLIP_DOWNLOAD_ROW_LABEL,
  clipDownloadFailureRightLabel,
  clipDownloadProgressLabel,
  clipDownloadRowState,
  isJobClipDownloading,
} from '../../utils/clipModelDownload'

function StageDot({ state }: { state: 'pending' | 'current' | 'done' | 'failed' }) {
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
  if (state === 'failed') {
    return (
      <span
        className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full border-2 border-error bg-error text-[11px] font-bold text-white"
        aria-hidden
      >
        !
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

function stageDotFromChecklistState(
  state: 'pending' | 'current' | 'done',
): 'pending' | 'current' | 'done' | 'failed' {
  return state
}

type CatalogImportStageChecklistProps = {
  job: Job | null
  expectClipDownloadInRun?: boolean
}

export function CatalogImportStageChecklist({
  job,
  expectClipDownloadInRun = false,
}: CatalogImportStageChecklistProps) {
  const clipRow = clipDownloadRowState(job, expectClipDownloadInRun)
  const clipSuppressEmbed =
    clipRow === 'current' || clipRow === 'failed' || isJobClipDownloading(job)

  return (
    <ol className="list-none space-y-1 p-0 m-0" data-testid="catalog-import-stage-checklist">
      {CATALOG_CACHE_BUILD_STAGE_ORDER.map((key) => {
        let state = catalogCacheBuildStageState(key, job)
        if (key === 'embed' && clipSuppressEmbed && state === 'current') {
          state = 'pending'
        }

        const label = CATALOG_CACHE_BUILD_STAGE_LABELS[key]
        const rowClass =
          state === 'done'
            ? 'text-text-secondary'
            : state === 'current'
              ? 'text-text font-semibold'
              : 'text-text-tertiary'

        const embedDetail =
          key === 'embed' && state === 'current'
            ? parseEmbedProgressDetail(job?.current_step)
            : null

        const clipSlot =
          key === 'sync' ? (
            clipRow !== 'hidden' ? (
              <li key="clip-download" data-testid="catalog-import-clip-download-row">
                <div
                  className={`flex items-center gap-2.5 py-1 text-sm ${
                    clipRow === 'failed'
                      ? 'font-semibold text-error'
                      : clipRow === 'current'
                        ? 'font-semibold text-text'
                        : clipRow === 'done'
                          ? 'text-text-secondary'
                          : 'text-text-tertiary'
                  }`}
                >
                  <StageDot
                    state={
                      clipRow === 'failed'
                        ? 'failed'
                        : clipRow === 'done'
                          ? 'done'
                          : clipRow === 'current'
                            ? 'current'
                            : 'pending'
                    }
                  />
                  <span className="flex-1">{CLIP_DOWNLOAD_ROW_LABEL}</span>
                  {clipRow === 'current' ? (
                    <span className="text-xs text-text-tertiary tabular-nums">
                      {clipDownloadProgressLabel(job)}
                    </span>
                  ) : null}
                  {clipRow === 'done' ? (
                    <span className="text-xs text-text-tertiary tabular-nums">352 MB</span>
                  ) : null}
                  {clipRow === 'failed' ? (
                    <span className="text-xs text-text-tertiary tabular-nums">
                      {clipDownloadFailureRightLabel(job)}
                    </span>
                  ) : null}
                </div>
                {clipRow === 'failed' && job?.error ? (
                  <p
                    className="pb-2 pl-7 text-sm text-text-secondary"
                    data-testid="catalog-import-clip-download-error"
                  >
                    {job.error}
                  </p>
                ) : null}
              </li>
            ) : (
              <div
                className="h-3"
                aria-hidden
                data-testid="catalog-import-clip-slot"
                title=""
              />
            )
          ) : null

        return (
          <li key={key}>
            <div className={`flex items-center gap-2.5 py-1 text-sm ${rowClass}`}>
              <StageDot state={stageDotFromChecklistState(state)} />
              <span>{label}</span>
              {embedDetail ? (
                <span className="text-xs text-text-tertiary tabular-nums">{embedDetail}</span>
              ) : null}
            </div>
            {clipSlot}
          </li>
        )
      })}
    </ol>
  )
}
