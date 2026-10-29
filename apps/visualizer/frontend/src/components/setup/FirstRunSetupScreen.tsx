import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../ui/Button'
import { PathSummary } from '../processing/SettingRow'
import { CatalogImportStageChecklist } from './CatalogImportStageChecklist'
import { ClipModelDownloadConfirm } from './ClipModelDownloadConfirm'
import type { useFirstRunSetup } from '../../hooks/useFirstRunSetup'
import { useClipModelStatus } from '../../hooks/useClipModelStatus'
import {
  FIRST_RUN_CHANGE_CATALOG,
  FIRST_RUN_CHOOSE_CATALOG,
  FIRST_RUN_IMPORT_CATALOG,
  FIRST_RUN_IMPORT_KEEP_USING,
  FIRST_RUN_IMPORT_WHILE_BUSY,
  FIRST_RUN_PHOTOS_KEPT_IN_IMAGES,
  FIRST_RUN_RETRY_IMPORT,
  FIRST_RUN_SEE_JOB_LOG,
  FIRST_RUN_STEP_CATALOG_HINT,
  FIRST_RUN_STEP_CATALOG_TITLE,
  FIRST_RUN_STEP_IMPORT_HINT,
  FIRST_RUN_STEP_IMPORT_STOPPED,
  FIRST_RUN_STEP_IMPORT_TITLE,
  FIRST_RUN_WELCOME_SUBTITLE,
  FIRST_RUN_WELCOME_TITLE,
  MSG_FAILED_START_JOB,
  PROCESSING_JOB_QUEUE_ROUTE,
} from '../../constants/strings'
import { catalogCacheBuildOverallPercent } from '../../utils/catalogCacheBuildProgress'

type SetupState = ReturnType<typeof useFirstRunSetup>

function stepShell(
  step: 1 | 2,
  variant: 'active' | 'done' | 'locked' | 'error',
  body: ReactNode,
) {
  const num =
    variant === 'done' ? (
      <span className="text-white">✓</span>
    ) : variant === 'error' ? (
      <span className="text-white">!</span>
    ) : (
      step
    )
  return (
    <div
      className={`flex gap-4 rounded-card border p-5 ${
        variant === 'active'
          ? 'border-accent shadow-[0_0_0_3px_var(--color-accent-light)]'
          : variant === 'error'
            ? 'border-error shadow-[0_0_0_3px_rgba(224,62,62,0.10)]'
            : variant === 'locked'
              ? 'border-border opacity-50'
              : 'border-border'
      }`}
    >
      <div
        className={`flex h-7 w-7 flex-none items-center justify-center rounded-full text-sm font-bold ${
          variant === 'active'
            ? 'bg-accent text-white'
            : variant === 'error'
              ? 'bg-error text-white'
              : variant === 'done'
                ? 'bg-success text-white'
                : 'bg-surface text-text'
        }`}
      >
        {num}
      </div>
      <div className="min-w-0 flex-1 space-y-3">{body}</div>
    </div>
  )
}

export function FirstRunSetupScreen({ setup }: { setup: SetupState }) {
  const {
    catalog,
    catalogConfigured,
    catalogSavedAndValid,
    importRunning,
    importJob,
    importStarting,
    importError,
    importClipDownloadFailed,
    expectClipDownloadInRun,
    catalogPhotoCount,
    pickAndSaveCatalog,
    startImport,
  } = setup

  const clipStatus = useClipModelStatus()
  const modelOnDisk = clipStatus.model_on_disk
  const [importConfirmOpen, setImportConfirmOpen] = useState(false)

  const step1Variant = catalogConfigured ? 'done' : 'active'
  const step2Variant = !catalogConfigured
    ? 'locked'
    : importClipDownloadFailed
      ? 'error'
      : importRunning || importStarting
        ? 'active'
        : setup.firstCatalogImportCompleted
          ? 'done'
          : 'active'

  const overall = catalogCacheBuildOverallPercent(importJob)
  const picking = catalog.picking
  const catalogError = catalog.error ?? importError

  const handleImportClick = () => {
    if (!catalogSavedAndValid || importRunning) return
    if (!modelOnDisk) {
      setImportConfirmOpen(true)
      return
    }
    void startImport()
  }

  const handleConfirmImport = () => {
    setImportConfirmOpen(false)
    void startImport({ expectClipDownload: true })
  }

  const step2Title = importClipDownloadFailed
    ? FIRST_RUN_STEP_IMPORT_STOPPED
    : FIRST_RUN_STEP_IMPORT_TITLE

  return (
    <>
      <div className="mx-auto mt-6 max-w-xl text-center">
        <h1 className="text-[32px] font-bold tracking-tight text-text mb-2">{FIRST_RUN_WELCOME_TITLE}</h1>
        <p className="text-text-secondary">{FIRST_RUN_WELCOME_SUBTITLE}</p>

        <div className="mt-8 space-y-3 text-left">
          {stepShell(
            1,
            step1Variant,
            <>
              <p className="font-semibold text-text">{FIRST_RUN_STEP_CATALOG_TITLE}</p>
              {catalogConfigured ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="min-w-0 text-sm">
                    <PathSummary path={catalog.status?.resolvedPath ?? catalog.status?.path ?? ''} />
                  </span>
                  {!importRunning && !importClipDownloadFailed ? (
                    <button
                      type="button"
                      className="shrink-0 text-sm font-medium text-accent hover:underline"
                      onClick={() => void pickAndSaveCatalog()}
                      disabled={picking}
                    >
                      {FIRST_RUN_CHANGE_CATALOG}
                    </button>
                  ) : null}
                </div>
              ) : (
                <>
                  <p className="text-sm text-text-secondary">{FIRST_RUN_STEP_CATALOG_HINT}</p>
                  <Button
                    type="button"
                    variant="primary"
                    size="md"
                    onClick={() => void pickAndSaveCatalog()}
                    disabled={picking}
                  >
                    {picking ? 'Choosing…' : FIRST_RUN_CHOOSE_CATALOG}
                  </Button>
                </>
              )}
            </>,
          )}

          {stepShell(
            2,
            step2Variant,
            <>
              <p className="font-semibold text-text">{step2Title}</p>
              {importRunning ? (
                <>
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface">
                    <div
                      className="h-full rounded-full bg-accent transition-[width] duration-300"
                      style={{ width: `${overall}%` }}
                    />
                  </div>
                  <CatalogImportStageChecklist
                    job={importJob}
                    expectClipDownloadInRun={expectClipDownloadInRun}
                  />
                  <p className="text-xs text-text-tertiary">{FIRST_RUN_IMPORT_KEEP_USING}</p>
                </>
              ) : importClipDownloadFailed ? (
                <>
                  <CatalogImportStageChecklist
                    job={importJob}
                    expectClipDownloadInRun={expectClipDownloadInRun}
                  />
                  {catalogPhotoCount > 0 ? (
                    <p className="text-sm text-text-secondary">
                      {FIRST_RUN_PHOTOS_KEPT_IN_IMAGES(catalogPhotoCount)}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      type="button"
                      variant="primary"
                      size="md"
                      onClick={() => void startImport({ expectClipDownload: true })}
                      disabled={!catalogSavedAndValid || importStarting}
                    >
                      {FIRST_RUN_RETRY_IMPORT}
                    </Button>
                    <Link
                      to={PROCESSING_JOB_QUEUE_ROUTE}
                      className="text-sm font-medium text-accent hover:underline"
                    >
                      {FIRST_RUN_SEE_JOB_LOG}
                    </Link>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm text-text-secondary">{FIRST_RUN_STEP_IMPORT_HINT}</p>
                  <Button
                    type="button"
                    variant="primary"
                    size="md"
                    onClick={handleImportClick}
                    disabled={!catalogSavedAndValid || importStarting}
                  >
                    {importStarting ? FIRST_RUN_IMPORT_WHILE_BUSY : FIRST_RUN_IMPORT_CATALOG}
                  </Button>
                </>
              )}
            </>,
          )}
        </div>

        {catalogError ? (
          <p className="mt-4 text-left text-sm text-error" role="status">
            {catalogError.startsWith(MSG_FAILED_START_JOB) ? catalogError : catalogError}
          </p>
        ) : null}
      </div>

      {importConfirmOpen ? (
        <ClipModelDownloadConfirm
          variant="import"
          busy={importStarting}
          onCancel={() => setImportConfirmOpen(false)}
          onConfirm={handleConfirmImport}
        />
      ) : null}
    </>
  )
}
