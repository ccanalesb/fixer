import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { FirstRunSetupScreen } from '../FirstRunSetupScreen'
import {
  CLIP_CONFIRM_DOWNLOAD_IMPORT,
  CLIP_CONFIRM_TITLE_IMPORT,
  FIRST_RUN_IMPORT_CATALOG,
  FIRST_RUN_RETRY_IMPORT,
} from '../../../constants/strings'
import type { useFirstRunSetup } from '../../../hooks/useFirstRunSetup'

const mockUseClipModelStatus = vi.fn()

vi.mock('../../../hooks/useClipModelStatus', () => ({
  useClipModelStatus: () => mockUseClipModelStatus(),
}))

type SetupState = ReturnType<typeof useFirstRunSetup>

function baseSetup(overrides: Partial<SetupState> = {}): SetupState {
  return {
    loading: false,
    catalog: {
      loading: false,
      picking: false,
      saving: false,
      draftPath: '',
      setDraftPath: vi.fn(),
      status: {
        path: '/tmp/cat.lrcat',
        resolvedPath: '/tmp/cat.lrcat',
        exists: true,
        pickerUsable: true,
        needsSync: false,
      },
      changesCatalog: false,
      error: null,
      pick: vi.fn(),
      save: vi.fn(),
      refresh: vi.fn(),
    },
    catalogConfigured: true,
    catalogSavedAndValid: true,
    firstCatalogImportCompleted: false,
    importRunning: false,
    importJob: null,
    importStarting: false,
    importError: null,
    importProgressPercent: 0,
    importClipDownloadFailed: false,
    expectClipDownloadInRun: false,
    catalogPhotoCount: 0,
    showInsightsSetup: true,
    showIdentityEmpty: true,
    showImagesEmpty: true,
    showImagesReadingCatalog: false,
    showImagesImportBanner: false,
    pickAndSaveCatalog: vi.fn(),
    startImport: vi.fn(),
    refreshSignals: vi.fn(),
    ...overrides,
  }
}

describe('FirstRunSetupScreen', () => {
  beforeEach(() => {
    mockUseClipModelStatus.mockReturnValue({ model_on_disk: false, cache_dir: '/clip' })
  })

  it('opens the CLIP confirm when Import catalog is clicked without the model on disk', () => {
    render(
      <MemoryRouter>
        <FirstRunSetupScreen setup={baseSetup()} />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: FIRST_RUN_IMPORT_CATALOG }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText(CLIP_CONFIRM_TITLE_IMPORT)).toBeTruthy()
  })

  it('does not open the confirm when the model is already on disk', () => {
    mockUseClipModelStatus.mockReturnValue({ model_on_disk: true, cache_dir: '/clip' })
    const startImport = vi.fn()
    render(
      <MemoryRouter>
        <FirstRunSetupScreen setup={baseSetup({ startImport })} />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: FIRST_RUN_IMPORT_CATALOG }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(startImport).toHaveBeenCalled()
  })

  it('starts the import only after confirming', () => {
    const startImport = vi.fn()
    render(
      <MemoryRouter>
        <FirstRunSetupScreen setup={baseSetup({ startImport })} />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: FIRST_RUN_IMPORT_CATALOG }))
    fireEvent.click(screen.getByRole('button', { name: CLIP_CONFIRM_DOWNLOAD_IMPORT }))
    expect(startImport).toHaveBeenCalledWith({ expectClipDownload: true })
  })

  it('does not start the import when the confirm is cancelled', () => {
    const startImport = vi.fn()
    render(
      <MemoryRouter>
        <FirstRunSetupScreen setup={baseSetup({ startImport })} />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: FIRST_RUN_IMPORT_CATALOG }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(startImport).not.toHaveBeenCalled()
  })

  it('shows retry without the confirm after a CLIP download failure', () => {
    const startImport = vi.fn()
    render(
      <MemoryRouter>
        <FirstRunSetupScreen
          setup={baseSetup({
            importClipDownloadFailed: true,
            importJob: {
              id: 'job-fail',
              type: 'catalog_cache_build',
              status: 'failed',
              progress: 29,
              error:
                'Could not download the image model (about 350 MB) from huggingface.co. Check the internet connection and retry.',
              logs: [],
              logs_total: 0,
              warning_count: 0,
              error_count: 0,
              created_at: '2026-01-01T00:00:00Z',
              metadata: {},
            },
            expectClipDownloadInRun: true,
            catalogPhotoCount: 42,
            startImport,
          })}
        />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: FIRST_RUN_RETRY_IMPORT }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(startImport).toHaveBeenCalledWith({ expectClipDownload: true })
  })
})
