import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useCatalogPicker } from '../useCatalogPicker'

const mockGetCatalog = vi.fn()
const mockPutCatalog = vi.fn()
const mockPickCatalogPath = vi.fn()
const mockIsTauri = vi.fn()

vi.mock('../../services/api', () => ({
  ConfigAPI: {
    getCatalog: () => mockGetCatalog(),
    putCatalog: (...args: unknown[]) => mockPutCatalog(...args),
  },
}))

vi.mock('../../utils/isTauri', () => ({
  isTauri: () => mockIsTauri(),
}))

vi.mock('../../utils/nativeFilePickers', () => ({
  pickCatalogPath: () => mockPickCatalogPath(),
}))

const catalogStatus = {
  catalog_path: '/old.lrcat',
  resolved_path: '/old.lrcat',
  exists: true,
  picker_available: true,
  needs_catalog_sync: false,
}

describe('useCatalogPicker pick', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauri.mockReturnValue(false)
    mockGetCatalog.mockResolvedValue(catalogStatus)
  })

  it('puts a Tauri-chosen path in the draft', async () => {
    mockIsTauri.mockReturnValue(true)
    mockPickCatalogPath.mockResolvedValue('/picked.lrcat')

    const { result } = renderHook(() => useCatalogPicker())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.pick()
    })

    expect(result.current.draftPath).toBe('/picked.lrcat')
    expect(mockPickCatalogPath).toHaveBeenCalled()
  })

  it('puts a backend-chosen path in the draft', async () => {
    mockPickCatalogPath.mockResolvedValue('/backend.lrcat')

    const { result } = renderHook(() => useCatalogPicker())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.pick()
    })

    expect(result.current.draftPath).toBe('/backend.lrcat')
  })

  it('saves the draft through the catalog API', async () => {
    mockPickCatalogPath.mockResolvedValue('/new.lrcat')
    mockPutCatalog.mockResolvedValue(undefined)
    mockGetCatalog
      .mockResolvedValueOnce(catalogStatus)
      .mockResolvedValueOnce({ ...catalogStatus, catalog_path: '/new.lrcat' })

    const { result } = renderHook(() => useCatalogPicker())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.pick()
    })
    let saved = false
    await act(async () => {
      saved = await result.current.save()
    })

    expect(saved).toBe(true)
    expect(mockPutCatalog).toHaveBeenCalledWith('/new.lrcat')
  })

  it('marks the picker usable in Tauri even when the backend has no osascript picker', async () => {
    mockIsTauri.mockReturnValue(true)
    mockGetCatalog.mockResolvedValue({ ...catalogStatus, picker_available: false })

    const { result } = renderHook(() => useCatalogPicker())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.status?.pickerUsable).toBe(true)
  })
})
