import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useCatalogPicker } from '../useCatalogPicker'

const mockGetCatalog = vi.fn()
const mockPutCatalog = vi.fn()
const mockPreviewCatalogChange = vi.fn()
const mockPickCatalogPath = vi.fn()
const mockIsTauri = vi.fn()
const mockPickFolderCatalogPath = vi.fn()

vi.mock('../../services/api', () => ({
  ConfigAPI: {
    getCatalog: () => mockGetCatalog(),
    putCatalog: (...args: unknown[]) => mockPutCatalog(...args),
    previewCatalogChange: (...args: unknown[]) => mockPreviewCatalogChange(...args),
  },
}))

vi.mock('../../utils/isTauri', () => ({
  isTauri: () => mockIsTauri(),
}))

vi.mock('../../utils/nativeFilePickers', () => ({
  pickCatalogPath: () => mockPickCatalogPath(),
  pickFolderCatalogPath: () => mockPickFolderCatalogPath(),
}))

const catalogStatus = {
  catalog_path: '/old.lrcat',
  resolved_path: '/old.lrcat',
  exists: true,
  catalog_kind: 'lightroom' as const,
  photo_count: 12,
  picker_available: true,
}

describe('useCatalogPicker pickers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauri.mockReturnValue(false)
    mockGetCatalog.mockResolvedValue(catalogStatus)
  })

  it('previews the .lrcat chosen in the dialog', async () => {
    mockIsTauri.mockReturnValue(true)
    mockPickCatalogPath.mockResolvedValue('/picked.lrcat')
    mockPreviewCatalogChange.mockResolvedValue(preview())

    const { result } = renderHook(() => useCatalogPicker())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.chooseLrcat()
    })

    expect(mockPreviewCatalogChange).toHaveBeenCalledWith('/picked.lrcat')
    expect(result.current.pendingChange?.path).toBe('/picked.lrcat')
  })

  it('marks the picker usable in Tauri even when the backend has no osascript picker', async () => {
    mockIsTauri.mockReturnValue(true)
    mockGetCatalog.mockResolvedValue({ ...catalogStatus, picker_available: false })

    const { result } = renderHook(() => useCatalogPicker())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.status?.pickerUsable).toBe(true)
  })

  it('previews the folder chosen in the dialog', async () => {
    mockPickFolderCatalogPath.mockResolvedValue('/Volumes/NAS/Photos')
    mockPreviewCatalogChange.mockResolvedValue(preview({ ask_same_or_different: false }))

    const { result } = renderHook(() => useCatalogPicker())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.chooseFolder()
    })

    expect(mockPreviewCatalogChange).toHaveBeenCalledWith('/Volumes/NAS/Photos')
  })

  it('does nothing when the dialog is dismissed', async () => {
    mockPickFolderCatalogPath.mockResolvedValue(null)

    const { result } = renderHook(() => useCatalogPicker())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.chooseFolder()
    })

    expect(mockPreviewCatalogChange).not.toHaveBeenCalled()
    expect(result.current.error).toBeNull()
  })
})

function preview(overrides: Record<string, unknown> = {}) {
  return {
    unchanged: false,
    current: { display_name: 'old', catalog_kind: 'lightroom' },
    next: { display_name: 'Holiday', catalog_kind: 'lightroom', has_library: false },
    ask_same_or_different: true,
    jobs_to_cancel: [],
    ...overrides,
  }
}

describe('useCatalogPicker change flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauri.mockReturnValue(false)
    mockGetCatalog.mockResolvedValue(catalogStatus)
  })

  it('previews a pasted path without the quotes Finder adds and waits for confirmation', async () => {
    mockPreviewCatalogChange.mockResolvedValue(preview())

    const { result } = renderHook(() => useCatalogPicker())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.beginChange("'/Volumes/NAS/My Holiday.lrcat'")
    })

    expect(mockPreviewCatalogChange).toHaveBeenCalledWith('/Volumes/NAS/My Holiday.lrcat')
    expect(result.current.pendingChange?.path).toBe('/Volumes/NAS/My Holiday.lrcat')
    expect(result.current.pendingChange?.sameChoice).toBeNull()
    expect(mockPutCatalog).not.toHaveBeenCalled()
  })

  it('opens straight at the consequences when the preview does not ask same or different', async () => {
    mockPreviewCatalogChange.mockResolvedValue(preview({ ask_same_or_different: false }))

    const { result } = renderHook(() => useCatalogPicker())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.beginChange('/Volumes/NAS/Photos')
    })

    expect(result.current.pendingChange?.sameChoice).toBe('different')
  })

  it('opens nothing when the path is the current catalog', async () => {
    mockPreviewCatalogChange.mockResolvedValue(preview({ unchanged: true }))

    const { result } = renderHook(() => useCatalogPicker())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.beginChange('/old.lrcat')
    })

    expect(result.current.pendingChange).toBeNull()
    expect(mockPutCatalog).not.toHaveBeenCalled()
  })

  it('saves the first catalog without a confirmation, since nothing is replaced', async () => {
    mockGetCatalog.mockResolvedValue({ ...catalogStatus, catalog_path: '', resolved_path: '' })
    mockPreviewCatalogChange.mockResolvedValue(preview({ ask_same_or_different: false }))
    mockPutCatalog.mockResolvedValue({
      catalog_path: '/Volumes/NAS/Photos',
      change: 'switch',
      reopened_library: false,
      library_photo_count: null,
      catalog_sync_job_id: 'sync-1',
      cancelled_job_ids: [],
    })

    const { result } = renderHook(() => useCatalogPicker())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.beginChange('/Volumes/NAS/Photos')
    })

    expect(mockPutCatalog).toHaveBeenCalledWith('/Volumes/NAS/Photos', 'switch')
    expect(result.current.pendingChange).toBeNull()
  })

  it('reports a rejected path as the error and opens nothing', async () => {
    mockPreviewCatalogChange.mockRejectedValue(new Error('No such folder'))

    const { result } = renderHook(() => useCatalogPicker())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.beginChange('/nope')
    })

    expect(result.current.error).toBe('No such folder')
    expect(result.current.pendingChange).toBeNull()
  })

  it('updates the path for the same catalog and says so', async () => {
    mockPreviewCatalogChange.mockResolvedValue(preview())
    mockPutCatalog.mockResolvedValue({
      catalog_path: '/Volumes/NAS/Holiday.lrcat',
      change: 'update_path',
      reopened_library: true,
      library_photo_count: 1200,
      catalog_sync_job_id: 'sync-1',
      cancelled_job_ids: [],
    })

    const { result } = renderHook(() => useCatalogPicker())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.beginChange('/Volumes/NAS/Holiday.lrcat')
    })
    act(() => result.current.setSameChoice('same'))
    await act(async () => {
      await result.current.confirmChange()
    })

    expect(mockPutCatalog).toHaveBeenCalledWith('/Volumes/NAS/Holiday.lrcat', 'update_path')
    expect(result.current.pendingChange).toBeNull()
    expect(result.current.notice).toBe(
      'Path updated to Holiday. The library stays; a catalog sync is queued.',
    )
  })

  it('shows the reopened-library notice after switching back to a catalog with a library', async () => {
    mockPreviewCatalogChange.mockResolvedValue(preview({ ask_same_or_different: false }))
    mockPutCatalog.mockResolvedValue({
      catalog_path: '/Volumes/NAS/Holiday.lrcat',
      change: 'switch',
      reopened_library: true,
      library_photo_count: 4300,
      catalog_sync_job_id: 'sync-2',
      cancelled_job_ids: [],
    })

    const { result } = renderHook(() => useCatalogPicker())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.beginChange('/Volumes/NAS/Holiday.lrcat')
    })
    await act(async () => {
      await result.current.confirmChange()
    })

    expect(mockPutCatalog).toHaveBeenCalledWith('/Volumes/NAS/Holiday.lrcat', 'switch')
    expect(result.current.notice).toBe(
      'Reopened Holiday: 4,300 photos with their descriptions, scores and culling. A catalog sync is queued.',
    )
  })

  it('cancelling closes the change without saving', async () => {
    mockPreviewCatalogChange.mockResolvedValue(preview())

    const { result } = renderHook(() => useCatalogPicker())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.beginChange('/Volumes/NAS/Holiday.lrcat')
    })
    act(() => result.current.cancelChange())

    expect(result.current.pendingChange).toBeNull()
    expect(mockPutCatalog).not.toHaveBeenCalled()
  })
})
