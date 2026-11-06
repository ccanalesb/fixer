import { useState, useEffect, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input/Input'
import { PathSummary } from '../processing/SettingRow'
import { CatalogImportStageChecklist } from './CatalogImportStageChecklist'
import { ClipModelDownloadConfirm } from './ClipModelDownloadConfirm'
import type { useFirstRunSetup } from '../../hooks/useFirstRunSetup'
import { useClipModelStatus } from '../../hooks/useClipModelStatus'
import {
  FIRST_RUN_CHANGE_CATALOG,
  FIRST_RUN_CHOOSE_FOLDER,
  FIRST_RUN_CHOOSE_LRCAT,
  FIRST_RUN_FOLDER_CARD_BODY,
  FIRST_RUN_FOLDER_CARD_TITLE,
  FIRST_RUN_FOLDER_STATS,
  FIRST_RUN_IMPORT_PHOTOS,
  FIRST_RUN_IMPORT_KEEP_USING,
  FIRST_RUN_IMPORT_WHILE_BUSY,
  FIRST_RUN_KIND_FOLDER,
  FIRST_RUN_KIND_LRCAT,
  FIRST_RUN_LRCAT_CARD_BODY,
  FIRST_RUN_LRCAT_CARD_TITLE,
  FIRST_RUN_LRCAT_STATS,
  FIRST_RUN_MANUAL_PATH_DISCLOSURE,
  FIRST_RUN_MANUAL_PATH_LABEL,
  FIRST_RUN_PHOTOS_KEPT_IN_IMAGES,
  FIRST_RUN_REMOTE_CATALOG_HINT,
  FIRST_RUN_RETRY_IMPORT,
  FIRST_RUN_SEE_JOB_LOG,
  FIRST_RUN_STEP_CATALOG_TITLE,
  FIRST_RUN_STEP_IMPORT_HINT_FOLDER,
  FIRST_RUN_STEP_IMPORT_HINT_LRCAT,
  FIRST_RUN_STEP_IMPORT_STOPPED,
  FIRST_RUN_STEP_IMPORT_TITLE,
  FIRST_RUN_USE_PATH,
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

function kindHeading(kind: 'lightroom' | 'folder'): string {
  return kind === 'folder' ? FIRST_RUN_KIND_FOLDER : FIRST_RUN_KIND_LRCAT
}

function catalogStatsLine(
  kind: 'lightroom' | 'folder',
  photoCount: number | null,
  folderCount: number | null,
): string | null {
  if (photoCount == null) return null
  if (kind === 'folder' && folderCount != null) {
    return FIRST_RUN_FOLDER_STATS(photoCount, folderCount)
  }
  if (kind === 'lightroom' && photoCount != null) {
    return FIRST_RUN_LRCAT_STATS(photoCount)
  }
  return `${photoCount.toLocaleString('en-US')} photos`
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
    pickAndSaveFolder,
    pickAndSaveLrcat,
    saveCatalogPath,
    startImport,
  } = setup

  const clipStatus = useClipModelStatus()
  const modelOnDisk = clipStatus.model_on_disk
  const [importConfirmOpen, setImportConfirmOpen] = useState(false)
  const [typingManual, setTypingManual] = useState(false)
  const [manualPath, setManualPath] = useState('')
  const [changingCatalog, setChangingCatalog] = useState(false)

  useEffect(() => {
    setChangingCatalog(false)
  }, [catalog.status?.path])

  const showCatalogPickers = !catalogConfigured || changingCatalog
  const readOnly = catalog.status?.readOnly ?? false
  const step1Variant = showCatalogPickers ? 'active' : 'done'
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
  const picking = catalog.picking || catalog.pickingFolder
  const catalogError = catalog.error ?? importError
  const catalogKind = catalog.status?.catalogKind ?? 'lightroom'
  const previewPhotos = catalog.status?.photoCount ?? 0
  const importLabel =
    previewPhotos > 0 ? FIRST_RUN_IMPORT_PHOTOS(previewPhotos) : FIRST_RUN_IMPORT_PHOTOS(0)
  const importHint =
    catalogKind === 'folder' ? FIRST_RUN_STEP_IMPORT_HINT_FOLDER : FIRST_RUN_STEP_IMPORT_HINT_LRCAT

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

  const statsLine = catalog.status
    ? catalogStatsLine(catalogKind, catalog.status.photoCount, catalog.status.folderCount)
    : null

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
              {showCatalogPickers ? (
                readOnly ? (
                  <>
                    <p className="font-semibold text-text">{FIRST_RUN_STEP_CATALOG_TITLE}</p>
                    <p className="text-sm text-text-secondary">{FIRST_RUN_REMOTE_CATALOG_HINT}</p>
                  </>
                ) : (
                <>
                  <p className="font-semibold text-text">{FIRST_RUN_STEP_CATALOG_TITLE}</p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="flex flex-col gap-2.5 rounded-card border border-border p-4 text-left">
                      <h4 className="text-base font-semibold text-text">{FIRST_RUN_FOLDER_CARD_TITLE}</h4>
                      <p className="flex-1 text-sm text-text-secondary">{FIRST_RUN_FOLDER_CARD_BODY}</p>
                      <Button
                        type="button"
                        variant="primary"
                        size="md"
                        className="w-full"
                        onClick={() => void pickAndSaveFolder()}
                        disabled={picking}
                      >
                        {picking ? 'Choosing…' : FIRST_RUN_CHOOSE_FOLDER}
                      </Button>
                    </div>
                    <div className="flex flex-col gap-2.5 rounded-card border border-border p-4 text-left">
                      <h4 className="text-base font-semibold text-text">{FIRST_RUN_LRCAT_CARD_TITLE}</h4>
                      <p className="flex-1 text-sm text-text-secondary">{FIRST_RUN_LRCAT_CARD_BODY}</p>
                      <Button
                        type="button"
                        variant="primary"
                        size="md"
                        className="w-full"
                        onClick={() => void pickAndSaveLrcat()}
                        disabled={picking}
                      >
                        {picking ? 'Choosing…' : FIRST_RUN_CHOOSE_LRCAT}
                      </Button>
                    </div>
                  </div>
                  <div>
                    <button
                      type="button"
                      className="text-sm font-medium text-accent hover:underline"
                      onClick={() => setTypingManual((v) => !v)}
                    >
                      {typingManual ? '⌄' : '›'} {FIRST_RUN_MANUAL_PATH_DISCLOSURE}
                    </button>
                    {typingManual ? (
                      <div className="mt-3 space-y-2">
                        <label className="block text-sm font-medium text-text-secondary">
                          {FIRST_RUN_MANUAL_PATH_LABEL}
                          <Input
                            className="mt-1.5"
                            value={manualPath}
                            onChange={(e) => setManualPath(e.target.value)}
                            disabled={picking}
                          />
                        </label>
                        {manualPath.trim() ? (
                          <p className="text-xs text-text-tertiary">
                            {manualPath.trim().toLowerCase().endsWith('.lrcat')
                              ? 'Ends in .lrcat, so this is a Lightroom catalog.'
                              : 'Not a .lrcat file, so this is a folder catalog.'}
                          </p>
                        ) : null}
                        <Button
                          type="button"
                          variant="primary"
                          size="md"
                          disabled={!manualPath.trim() || picking}
                          onClick={() => void saveCatalogPath(manualPath)}
                        >
                          {FIRST_RUN_USE_PATH}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </>
                )
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="font-semibold text-text">{FIRST_RUN_STEP_CATALOG_TITLE}</p>
                    {!readOnly && !importRunning && !importClipDownloadFailed ? (
                      <button
                        type="button"
                        className="shrink-0 text-sm font-medium text-accent hover:underline"
                        onClick={() => setChangingCatalog(true)}
                        disabled={picking}
                      >
                        {FIRST_RUN_CHANGE_CATALOG}
                      </button>
                    ) : null}
                  </div>
                  <div className="rounded-lg border border-border bg-surface px-3.5 py-3 text-left">
                    <p className="text-sm font-semibold text-text">{kindHeading(catalogKind)}</p>
                    <p className="mt-1 text-sm text-text">
                      <PathSummary path={catalog.status?.resolvedPath ?? catalog.status?.path ?? ''} />
                    </p>
                    {statsLine ? (
                      <p className="mt-1 text-sm text-text-tertiary">{statsLine}</p>
                    ) : null}
                  </div>
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
                    catalogKind={catalogKind}
                  />
                  <p className="text-xs text-text-tertiary">{FIRST_RUN_IMPORT_KEEP_USING}</p>
                </>
              ) : importClipDownloadFailed ? (
                <>
                  <CatalogImportStageChecklist
                    job={importJob}
                    expectClipDownloadInRun={expectClipDownloadInRun}
                    catalogKind={catalogKind}
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
                  <p className="text-sm text-text-secondary">{importHint}</p>
                  <Button
                    type="button"
                    variant="primary"
                    size="md"
                    onClick={handleImportClick}
                    disabled={!catalogSavedAndValid || importStarting}
                  >
                    {importStarting ? FIRST_RUN_IMPORT_WHILE_BUSY : importLabel}
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
