import type { ReactNode } from 'react'
import { Button } from '../ui/Button'
import { PathSummary } from '../processing/SettingRow'
import { CatalogImportStageChecklist } from './CatalogImportStageChecklist'
import type { useFirstRunSetup } from '../../hooks/useFirstRunSetup'
import {
  FIRST_RUN_CHANGE_CATALOG,
  FIRST_RUN_CHOOSE_CATALOG,
  FIRST_RUN_IMPORT_CATALOG,
  FIRST_RUN_IMPORT_KEEP_USING,
  FIRST_RUN_IMPORT_WHILE_BUSY,
  FIRST_RUN_STEP_CATALOG_HINT,
  FIRST_RUN_STEP_CATALOG_TITLE,
  FIRST_RUN_STEP_IMPORT_HINT,
  FIRST_RUN_STEP_IMPORT_TITLE,
  FIRST_RUN_WELCOME_SUBTITLE,
  FIRST_RUN_WELCOME_TITLE,
  MSG_FAILED_START_JOB,
} from '../../constants/strings'
import { catalogCacheBuildOverallPercent } from '../../utils/catalogCacheBuildProgress'

type SetupState = ReturnType<typeof useFirstRunSetup>

function stepShell(
  step: 1 | 2,
  variant: 'active' | 'done' | 'locked',
  body: ReactNode,
) {
  const num =
    variant === 'done' ? (
      <span className="text-white">✓</span>
    ) : (
      step
    )
  return (
    <div
      className={`flex gap-4 rounded-card border p-5 ${
        variant === 'active'
          ? 'border-accent shadow-[0_0_0_3px_var(--color-accent-light)]'
          : variant === 'locked'
            ? 'border-border opacity-50'
            : 'border-border'
      }`}
    >
      <div
        className={`flex h-7 w-7 flex-none items-center justify-center rounded-full text-sm font-bold ${
          variant === 'active'
            ? 'bg-accent text-white'
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
    pickAndSaveCatalog,
    startImport,
  } = setup

  const step1Variant = catalogConfigured ? 'done' : 'active'
  const step2Variant = !catalogConfigured
    ? 'locked'
    : importRunning || importStarting
      ? 'active'
      : setup.firstCatalogImportCompleted
        ? 'done'
        : 'active'

  const overall = catalogCacheBuildOverallPercent(importJob)
  const picking = catalog.picking
  const catalogError = catalog.error ?? importError

  return (
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
                {!importRunning ? (
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
            <p className="font-semibold text-text">{FIRST_RUN_STEP_IMPORT_TITLE}</p>
            {importRunning ? (
              <>
                <div className="h-1.5 overflow-hidden rounded-full bg-surface">
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-300"
                    style={{ width: `${overall}%` }}
                  />
                </div>
                <CatalogImportStageChecklist job={importJob} />
                <p className="text-xs text-text-tertiary">{FIRST_RUN_IMPORT_KEEP_USING}</p>
              </>
            ) : (
              <>
                <p className="text-sm text-text-secondary">{FIRST_RUN_STEP_IMPORT_HINT}</p>
                <Button
                  type="button"
                  variant="primary"
                  size="md"
                  onClick={() => void startImport()}
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
  )
}
