import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CatalogSettingRow } from '../CatalogSettingRow'
import { SETTINGS_CATALOG_REMOTE_HINT } from '../../../constants/strings'

const mockUseCatalogPicker = vi.fn()

vi.mock('../../../hooks/useCatalogPicker', () => ({
  useCatalogPicker: () => mockUseCatalogPicker(),
}))

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
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
      pickLrcat: vi.fn(),
      pickFolder: vi.fn(),
      previewChange: vi.fn(),
      applyChange: vi.fn(),
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
})
