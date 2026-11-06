import { useState, useEffect, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../ui/Button'
import { InlineNotice } from '../ui/InlineNotice'
import { PathSummary } from '../processing/SettingRow'
import { CatalogChangeModal } from '../processing/CatalogChangeModal'
import { CatalogManualPath } from '../processing/CatalogManualPath'
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
  PROCESSING_JOB_QUEUE_ROUTE,
  SETTINGS_CATALOG_REMOTE_HINT,
} from '../../constants/strings'
import { catalogCacheBuildOverallPercent } from '../../utils/catalogCacheBuildProgress'
import { forCatalogKind } from '../../utils/catalogKindCopy'
import type { CatalogKind } from '../../types/config'

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

function catalogStatsLine(
  kind: CatalogKind,
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

function SetupChoiceCard({
  title,
  body,
  actionLabel,
  busy,
  onChoose,
}: {
  title: string
  body: string
  actionLabel: string
  busy: boolean
  onChoose: () => void
}) {
  return (
    <div className="flex flex-col gap-2.5 rounded-card border border-border p-4 text-left">
      <h4 className="text-base font-semibold text-text">{title}</h4>
      <p className="flex-1 text-sm text-text-secondary">{body}</p>
      <Button
        type="button"
        variant="primary"
        size="md"
        className="w-full"
        onClick={onChoose}
        disabled={busy}
      >
        {busy ? 'Choosing…' : actionLabel}
      </Button>
    </div>
  )
}

export function FirstRunSetupScreen({
  setup,
  forceCatalogImport = false,
}: {
  setup: SetupState
  forceCatalogImport?: boolean
}) {
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
        : setup.firstCatalogImportCompleted && !forceCatalogImport
          ? 'done'
          : 'active'

  const overall = catalogCacheBuildOverallPercent(importJob)
  const picking = catalog.picking || catalog.pickingFolder || catalog.saving
  const catalogError = catalog.error ?? importError
  const catalogKind = catalog.status?.catalogKind ?? 'lightroom'
  const importLabel = FIRST_RUN_IMPORT_PHOTOS(catalog.status?.photoCount ?? 0)
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
                      <SetupChoiceCard
                        title={FIRST_RUN_FOLDER_CARD_TITLE}
                        body={FIRST_RUN_FOLDER_CARD_BODY}
                        actionLabel={FIRST_RUN_CHOOSE_FOLDER}
                        busy={picking}
                        onChoose={() => void catalog.chooseFolder()}
                      />
                      <SetupChoiceCard
                        title={FIRST_RUN_LRCAT_CARD_TITLE}
                        body={FIRST_RUN_LRCAT_CARD_BODY}
                        actionLabel={FIRST_RUN_CHOOSE_LRCAT}
                        busy={picking}
                        onChoose={() => void catalog.chooseLrcat()}
                      />
                    </div>
                    <CatalogManualPath
                      open={typingManual}
                      onToggle={() => setTypingManual((v) => !v)}
                      busy={picking}
                      value={manualPath}
                      onChange={setManualPath}
                      submitLabel={FIRST_RUN_USE_PATH}
                      onSubmit={() => void catalog.beginChange(manualPath)}
                      buttonSize="md"
                    />
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
                    <p className="text-sm font-semibold text-text">
                      {forCatalogKind(catalogKind, FIRST_RUN_KIND_LRCAT, FIRST_RUN_KIND_FOLDER)}
                    </p>
                    <p className="mt-1 text-sm text-text">
                      <PathSummary path={catalog.status?.resolvedPath ?? catalog.status?.path ?? ''} />
                    </p>
                    {statsLine ? (
                      <p className="mt-1 text-sm text-text-tertiary">{statsLine}</p>
                    ) : null}
                  </div>
                  {readOnly ? (
                    <p className="text-sm text-text-tertiary">{SETTINGS_CATALOG_REMOTE_HINT}</p>
                  ) : null}
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

        {catalog.notice ? <InlineNotice className="mt-4 text-left">{catalog.notice}</InlineNotice> : null}
        {catalogError ? (
          <p className="mt-4 text-left text-sm text-error" role="status">
            {catalogError}
          </p>
        ) : null}
      </div>

      {catalog.pendingChange ? (
        <CatalogChangeModal
          preview={catalog.pendingChange.preview}
          sameChoice={catalog.pendingChange.sameChoice}
          onSameChoice={catalog.setSameChoice}
          saving={catalog.saving}
          onCancel={catalog.cancelChange}
          onConfirm={() => void catalog.confirmChange()}
        />
      ) : null}

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
