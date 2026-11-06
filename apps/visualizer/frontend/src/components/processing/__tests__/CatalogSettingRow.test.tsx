import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CatalogSettingRow } from '../CatalogSettingRow'
import { SETTINGS_CATALOG_REMOTE_HINT } from '../../../constants/strings'

const mockUseCatalogPicker = vi.fn()

vi.mock('../../../hooks/useCatalogPicker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../hooks/useCatalogPicker')>()),
  useCatalogPicker: () => mockUseCatalogPicker(),
}))

const mockNavigate = vi.fn()

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}))

describe('CatalogSettingRow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows read-only catalog details from another device with no pickers', () => {
    mockUseCatalogPicker.mockReturnValue({
      status: {
        path: '/Users/me/Pictures/Cat.lrcat',
        resolvedPath: '/Users/me/Pictures/Cat.lrcat',
        exists: true,
        catalogKind: 'lightroom',
        photoCount: 120,
        folderCount: null,
        pickerUsable: false,
        readOnly: true,
      },
      draftPath: '/Users/me/Pictures/Cat.lrcat',
      setDraftPath: vi.fn(),
      changesCatalog: false,
      loading: false,
      picking: false,
      pickingFolder: false,
      saving: false,
      error: null,
      notice: null,
      chooseLrcat: vi.fn(),
      chooseFolder: vi.fn(),
      beginChange: vi.fn(),
      pendingChange: null,
      setSameChoice: vi.fn(),
      cancelChange: vi.fn(),
      confirmChange: vi.fn(),
    })

    render(<CatalogSettingRow />)

    expect(screen.getByText('Lightroom catalog')).toBeInTheDocument()
    expect(screen.getByText('Cat.lrcat')).toBeInTheDocument()
    expect(screen.getByText(/120 photos/)).toBeInTheDocument()
    expect(screen.getByText(SETTINGS_CATALOG_REMOTE_HINT)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Choose folder…' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Choose .lrcat…' })).not.toBeInTheDocument()
    expect(screen.queryByText('Enter a path manually')).not.toBeInTheDocument()
  })

  it('shows the reopened-library notice in the shared success banner', () => {
    const notice =
      'Reopened Holiday: 4,300 photos with their descriptions, scores and culling. A catalog sync is queued.'
    mockUseCatalogPicker.mockReturnValue({
      status: {
        path: '/Volumes/Photos/Holiday',
        resolvedPath: '/Volumes/Photos/Holiday',
        exists: true,
        catalogKind: 'folder',
        photoCount: 4300,
        folderCount: 12,
        pickerUsable: true,
        readOnly: false,
      },
      draftPath: '/Volumes/Photos/Holiday',
      setDraftPath: vi.fn(),
      changesCatalog: false,
      loading: false,
      picking: false,
      pickingFolder: false,
      saving: false,
      error: null,
      notice,
      chooseLrcat: vi.fn(),
      chooseFolder: vi.fn(),
      beginChange: vi.fn(),
      pendingChange: null,
      setSameChoice: vi.fn(),
      cancelChange: vi.fn(),
      confirmChange: vi.fn(),
    })

    render(<CatalogSettingRow />)

    const banner = screen.getByRole('status')
    expect(banner).toHaveAttribute('data-tone', 'success')
    expect(banner).toHaveTextContent(notice)
  })

  it('opens the change modal for a pending change and goes to setup after switching to an empty catalog', async () => {
    const confirmChange = vi.fn().mockResolvedValue({
      catalog_path: '/Volumes/NAS/Photos',
      change: 'switch',
      reopened_library: false,
      library_photo_count: null,
      catalog_sync_job_id: 'sync-1',
      cancelled_job_ids: [],
      ok: true,
    })
    mockUseCatalogPicker.mockReturnValue({
      status: {
        path: '/a/old.lrcat',
        resolvedPath: '/a/old.lrcat',
        exists: true,
        catalogKind: 'lightroom',
        photoCount: 100,
        folderCount: null,
        pickerUsable: true,
        readOnly: false,
      },
      draftPath: '/a/old.lrcat',
      setDraftPath: vi.fn(),
      changesCatalog: false,
      loading: false,
      picking: false,
      pickingFolder: false,
      saving: false,
      error: null,
      notice: null,
      chooseLrcat: vi.fn(),
      chooseFolder: vi.fn(),
      beginChange: vi.fn(),
      pendingChange: {
        path: '/Volumes/NAS/Photos',
        sameChoice: 'different',
        preview: {
          unchanged: false,
          current: {
            catalog_path: '/a/old.lrcat',
            resolved_path: '/a/old.lrcat',
            catalog_kind: 'lightroom',
            display_name: 'old',
            exists: true,
            library_photo_count: 100,
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
          jobs_to_cancel: [],
        },
      },
      setSameChoice: vi.fn(),
      cancelChange: vi.fn(),
      confirmChange,
    })

    render(<CatalogSettingRow />)

    fireEvent.click(screen.getByRole('button', { name: 'Switch catalog' }))
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('/', { state: { startCatalogImport: true } }),
    )
  })
})
