import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useAppModelPicker } from '../useAppModelPicker'

const mockList = vi.fn()
const mockAdd = vi.fn()
const mockPickAppModelFolderPath = vi.fn()
const mockIsTauri = vi.fn()

vi.mock('../../services/api', () => ({
  AppModelsAPI: {
    list: () => mockList(),
    add: (...args: unknown[]) => mockAdd(...args),
  },
}))

vi.mock('../../utils/isTauri', () => ({
  isTauri: () => mockIsTauri(),
}))

vi.mock('../../utils/nativeFilePickers', () => ({
  pickAppModelFolderPath: () => mockPickAppModelFolderPath(),
}))

describe('useAppModelPicker pick', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauri.mockReturnValue(false)
    mockList.mockResolvedValue({ models: [], picker_available: true })
  })

  it('puts a Tauri-chosen folder in the draft', async () => {
    mockIsTauri.mockReturnValue(true)
    mockPickAppModelFolderPath.mockResolvedValue('/models/local')

    const { result } = renderHook(() => useAppModelPicker())
    await waitFor(() => expect(result.current.models).not.toBeNull())

    await act(async () => {
      await result.current.pick()
    })

    expect(result.current.draft).toBe('/models/local')
  })

  it('puts a backend-chosen folder in the draft', async () => {
    mockPickAppModelFolderPath.mockResolvedValue('/models/from-api')

    const { result } = renderHook(() => useAppModelPicker())
    await waitFor(() => expect(result.current.models).not.toBeNull())

    await act(async () => {
      await result.current.pick()
    })

    expect(result.current.draft).toBe('/models/from-api')
  })

  it('queues conversion through the app-models API after pick', async () => {
    mockPickAppModelFolderPath.mockResolvedValue('/models/local')
    mockAdd.mockResolvedValue(undefined)
    mockList
      .mockResolvedValueOnce({ models: [], picker_available: true })
      .mockResolvedValueOnce({ models: [{ id: 'm1' }], picker_available: true })

    const { result } = renderHook(() => useAppModelPicker())
    await waitFor(() => expect(result.current.models).not.toBeNull())

    await act(async () => {
      await result.current.pick()
    })
    let added = false
    await act(async () => {
      added = await result.current.add()
    })

    expect(added).toBe(true)
    expect(mockAdd).toHaveBeenCalledWith('/models/local')
  })

  it('offers the picker in Tauri when the backend reports none', async () => {
    mockIsTauri.mockReturnValue(true)
    mockList.mockResolvedValue({ models: [], picker_available: false })

    const { result } = renderHook(() => useAppModelPicker())
    await waitFor(() => expect(result.current.models).not.toBeNull())

    expect(result.current.pickerUsable).toBe(true)
  })
})
