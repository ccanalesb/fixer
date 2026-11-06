import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { FirstRunSetupScreen } from '../FirstRunSetupScreen'
import {
  CLIP_CONFIRM_DOWNLOAD_IMPORT,
  CLIP_CONFIRM_TITLE_IMPORT,
  FIRST_RUN_CHANGE_CATALOG,
  FIRST_RUN_CHOOSE_FOLDER,
  FIRST_RUN_CHOOSE_LRCAT,
  FIRST_RUN_FOLDER_CARD_TITLE,
  FIRST_RUN_IMPORT_PHOTOS,
  FIRST_RUN_MANUAL_PATH_DISCLOSURE,
  FIRST_RUN_MANUAL_PATH_LABEL,
  FIRST_RUN_RETRY_IMPORT,
  FIRST_RUN_USE_PATH,
  SETTINGS_CATALOG_REMOTE_HINT,
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
        catalogKind: 'lightroom',
        photoCount: 12,
        folderCount: null,
        pickerUsable: true,
        readOnly: false,
      },
      changesCatalog: false,
      error: null,
      notice: null,
      pickingFolder: false,
      chooseLrcat: vi.fn(),
      chooseFolder: vi.fn(),
      beginChange: vi.fn(),
      pendingChange: null,
      setSameChoice: vi.fn(),
      cancelChange: vi.fn(),
      confirmChange: vi.fn(),
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
    startImport: vi.fn(),
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
    fireEvent.click(screen.getByRole('button', { name: FIRST_RUN_IMPORT_PHOTOS(12) }))
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
    fireEvent.click(screen.getByRole('button', { name: FIRST_RUN_IMPORT_PHOTOS(12) }))
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
    fireEvent.click(screen.getByRole('button', { name: FIRST_RUN_IMPORT_PHOTOS(12) }))
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
    fireEvent.click(screen.getByRole('button', { name: FIRST_RUN_IMPORT_PHOTOS(12) }))
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

  it('shows read-only copy instead of pickers when the catalog is remote', () => {
    render(
      <MemoryRouter>
        <FirstRunSetupScreen
          setup={baseSetup({
            catalogConfigured: false,
            catalog: {
              ...baseSetup().catalog,
              status: {
                ...baseSetup().catalog.status!,
                readOnly: true,
              },
            },
          })}
        />
      </MemoryRouter>,
    )

    expect(screen.getByText(/Only on the Mac running Fixer/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: FIRST_RUN_CHOOSE_FOLDER })).not.toBeInTheDocument()
  })

  it('shows folder cards while picking and stats once a folder catalog is chosen', () => {
    const folderStatus = {
      path: '/Volumes/NAS/Photos',
      resolvedPath: '/Volumes/NAS/Photos',
      exists: true,
      catalogKind: 'folder' as const,
      photoCount: 12_408,
      folderCount: 214,
      pickerUsable: true,
      readOnly: false,
    }

    const { unmount } = render(
      <MemoryRouter>
        <FirstRunSetupScreen
          setup={baseSetup({
            catalogConfigured: false,
            catalog: { ...baseSetup().catalog, status: folderStatus },
          })}
        />
      </MemoryRouter>,
    )
    expect(screen.getByText(FIRST_RUN_FOLDER_CARD_TITLE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: FIRST_RUN_CHOOSE_FOLDER })).toBeInTheDocument()
    unmount()

    render(
      <MemoryRouter>
        <FirstRunSetupScreen
          setup={baseSetup({
            catalog: { ...baseSetup().catalog, status: folderStatus },
          })}
        />
      </MemoryRouter>,
    )
    expect(screen.getByText(/12,408 photos in 214 folders/)).toBeInTheDocument()
  })

  it('shows the chosen catalog read-only from another device', () => {
    render(
      <MemoryRouter>
        <FirstRunSetupScreen
          setup={baseSetup({
            catalog: {
              ...baseSetup().catalog,
              status: { ...baseSetup().catalog.status!, readOnly: true },
            },
          })}
        />
      </MemoryRouter>,
    )

    expect(screen.getByText('cat.lrcat')).toBeInTheDocument()
    expect(screen.getByText(SETTINGS_CATALOG_REMOTE_HINT)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: FIRST_RUN_CHANGE_CATALOG })).not.toBeInTheDocument()
  })

  it('changes the catalog through the change flow, from either dialog', () => {
    const setup = baseSetup()
    render(
      <MemoryRouter>
        <FirstRunSetupScreen setup={setup} />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: FIRST_RUN_CHANGE_CATALOG }))
    fireEvent.click(screen.getByRole('button', { name: FIRST_RUN_CHOOSE_FOLDER }))
    fireEvent.click(screen.getByRole('button', { name: FIRST_RUN_CHOOSE_LRCAT }))

    expect(setup.catalog.chooseFolder).toHaveBeenCalled()
    expect(setup.catalog.chooseLrcat).toHaveBeenCalled()
  })

  it('sends a typed path into the change flow from a disclosure that reports its state', () => {
    const setup = baseSetup({ catalogConfigured: false })
    render(
      <MemoryRouter>
        <FirstRunSetupScreen setup={setup} />
      </MemoryRouter>,
    )

    const details = screen.getByText(FIRST_RUN_MANUAL_PATH_DISCLOSURE).closest('details')!
    expect(details).not.toHaveAttribute('open')
    fireEvent.click(screen.getByText(FIRST_RUN_MANUAL_PATH_DISCLOSURE))
    expect(details).toHaveAttribute('open')

    fireEvent.change(screen.getByLabelText(FIRST_RUN_MANUAL_PATH_LABEL), {
      target: { value: "'/Volumes/NAS/My Photos'" },
    })
    expect(screen.getByText('Not a .lrcat file, so this is a folder catalog.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: FIRST_RUN_USE_PATH }))

    expect(setup.catalog.beginChange).toHaveBeenCalledWith("'/Volumes/NAS/My Photos'")
  })

  it('shows the catalog change modal for a pending change and confirms it', () => {
    const setup = baseSetup()
    setup.catalog.pendingChange = {
      path: '/Volumes/NAS/Photos',
      sameChoice: 'different',
      preview: {
        unchanged: false,
        current: {
          catalog_path: '/tmp/cat.lrcat',
          resolved_path: '/tmp/cat.lrcat',
          catalog_kind: 'lightroom',
          display_name: 'cat',
          exists: true,
          library_photo_count: 12,
          has_library: true,
        },
        next: {
          catalog_path: '/Volumes/NAS/Photos',
          resolved_path: '/Volumes/NAS/Photos',
          catalog_kind: 'folder',
          display_name: 'Photos',
          exists: true,
          library_photo_count: null,
          has_library: false,
        },
        ask_same_or_different: false,
        jobs_to_cancel: [{ id: 'job-1', type: 'batch_describe', status: 'running' }],
      },
    }
    render(
      <MemoryRouter>
        <FirstRunSetupScreen setup={setup} />
      </MemoryRouter>,
    )

    expect(screen.getByRole('heading', { name: 'Switch to Photos?' })).toBeInTheDocument()
    expect(screen.getByText(/Switching cancels 1 job on photos:/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Switch catalog' }))
    expect(setup.catalog.confirmChange).toHaveBeenCalled()
  })
})
