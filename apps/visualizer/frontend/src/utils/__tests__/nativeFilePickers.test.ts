import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pickAppModelFolderPath, pickCatalogPath } from '../nativeFilePickers'

const mockIsTauri = vi.fn()
const mockOpen = vi.fn()
const mockPickCatalog = vi.fn()
const mockPickAppModel = vi.fn()

vi.mock('../isTauri', () => ({
  isTauri: () => mockIsTauri(),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => mockOpen(...args),
}))

vi.mock('../../services/api', () => ({
  ConfigAPI: {
    pickCatalog: () => mockPickCatalog(),
  },
  AppModelsAPI: {
    pick: () => mockPickAppModel(),
  },
}))

describe('pickCatalogPath', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses the Tauri dialog in the desktop app', async () => {
    mockIsTauri.mockReturnValue(true)
    mockOpen.mockResolvedValue('/Users/me/Catalog.lrcat')

    await expect(pickCatalogPath()).resolves.toBe('/Users/me/Catalog.lrcat')
    expect(mockOpen).toHaveBeenCalledWith({
      multiple: false,
      directory: false,
      filters: [{ name: 'Lightroom Classic catalog', extensions: ['lrcat'] }],
    })
    expect(mockPickCatalog).not.toHaveBeenCalled()
  })

  it('returns null when the Tauri dialog is dismissed', async () => {
    mockIsTauri.mockReturnValue(true)
    mockOpen.mockResolvedValue(null)

    await expect(pickCatalogPath()).resolves.toBeNull()
  })

  it('uses the backend picker in a browser', async () => {
    mockIsTauri.mockReturnValue(false)
    mockPickCatalog.mockResolvedValue({ catalog_path: '/repo/foo.lrcat' })

    await expect(pickCatalogPath()).resolves.toBe('/repo/foo.lrcat')
    expect(mockOpen).not.toHaveBeenCalled()
  })
})

describe('pickAppModelFolderPath', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses a Tauri folder dialog in the desktop app', async () => {
    mockIsTauri.mockReturnValue(true)
    mockOpen.mockResolvedValue('/Users/me/my-model')

    await expect(pickAppModelFolderPath()).resolves.toBe('/Users/me/my-model')
    expect(mockOpen).toHaveBeenCalledWith({
      multiple: false,
      directory: true,
    })
    expect(mockPickAppModel).not.toHaveBeenCalled()
  })

  it('returns null when the Tauri folder dialog is dismissed', async () => {
    mockIsTauri.mockReturnValue(true)
    mockOpen.mockResolvedValue(null)

    await expect(pickAppModelFolderPath()).resolves.toBeNull()
  })

  it('uses the backend folder picker in a browser', async () => {
    mockIsTauri.mockReturnValue(false)
    mockPickAppModel.mockResolvedValue({ path: '/models/hf-format' })

    await expect(pickAppModelFolderPath()).resolves.toBe('/models/hf-format')
    expect(mockOpen).not.toHaveBeenCalled()
  })
})
