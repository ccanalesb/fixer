import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useCatalogPicker } from '../useCatalogPicker'

const mockGetCatalog = vi.fn()
const mockPutCatalog = vi.fn()
const mockPreviewCatalogChange = vi.fn()
const mockPickCatalogPath = vi.fn()
const mockIsTauri = vi.fn()

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
  pickFolderCatalogPath: vi.fn(),
}))

const catalogStatus = {
  catalog_path: '/old.lrcat',
  resolved_path: '/old.lrcat',
  exists: true,
  catalog_kind: 'lightroom' as const,
  photo_count: 12,
  picker_available: true,
}

describe('useCatalogPicker pickLrcat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauri.mockReturnValue(false)
    mockGetCatalog.mockResolvedValue(catalogStatus)
  })

  it('returns a Tauri-chosen path', async () => {
    mockIsTauri.mockReturnValue(true)
    mockPickCatalogPath.mockResolvedValue('/picked.lrcat')

    const { result } = renderHook(() => useCatalogPicker())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let chosen: string | null = null
    await act(async () => {
      chosen = await result.current.pickLrcat()
    })

    expect(chosen).toBe('/picked.lrcat')
    expect(mockPickCatalogPath).toHaveBeenCalled()
  })

  it('marks the picker usable in Tauri even when the backend has no osascript picker', async () => {
    mockIsTauri.mockReturnValue(true)
    mockGetCatalog.mockResolvedValue({ ...catalogStatus, picker_available: false })

    const { result } = renderHook(() => useCatalogPicker())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.status?.pickerUsable).toBe(true)
  })

  it('shows catalog-name notices after applyChange', async () => {
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
      await result.current.applyChange('/Volumes/NAS/Holiday.lrcat', 'update_path')
    })

    expect(result.current.notice).toBe(
      'Path updated to Holiday. The library stays; a catalog sync is queued.',
    )
  })

  it('shows the reopened-library notice after switching back to a catalog with a library', async () => {
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
      await result.current.applyChange('/Volumes/NAS/Holiday.lrcat', 'switch')
    })

    expect(result.current.notice).toBe(
      'Reopened Holiday: 4,300 photos with their descriptions, scores and culling. A catalog sync is queued.',
    )
  })
})
