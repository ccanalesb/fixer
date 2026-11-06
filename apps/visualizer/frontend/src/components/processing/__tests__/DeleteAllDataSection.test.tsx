import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteMatching } from '../../../data/cache'
import { DeleteAllDataSection } from '../DeleteAllDataSection'
import {
  SETTINGS_DELETE_ALL_BUTTON,
  SETTINGS_DELETE_ALL_CONFIRM_BODY,
  SETTINGS_DELETE_ALL_CONFIRM_BODY_FOLDER,
  SETTINGS_DELETE_ALL_CONFIRM_BUTTON,
  SETTINGS_DELETE_ALL_CONFIRM_TITLE,
  SETTINGS_DELETE_ALL_HEADING,
} from '../../../constants/strings'
import * as tauri from '../../../utils/tauri'
import { ConfigAPI } from '../../../services/api'

describe('DeleteAllDataSection', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    vi.restoreAllMocks()
    vi.spyOn(ConfigAPI, 'getCatalog').mockResolvedValue({
      catalog_path: '/tmp/test.lrcat',
      resolved_path: '/tmp/test.lrcat',
      exists: true,
      catalog_kind: 'lightroom',
      photo_count: 0,
      folder_count: null,
      unreadable_directories: [],
      picker_available: false,
    })
  })

  it('is not rendered in a browser', () => {
    const { container } = render(<DeleteAllDataSection />)
    expect(container).toBeEmptyDOMElement()
  })

  it('confirms then invokes the Tauri command in the desktop app', async () => {
    vi.spyOn(tauri, 'isTauriRuntime').mockReturnValue(true)
    const invoke = vi.spyOn(tauri, 'invokeDeleteAllDataAndQuit').mockResolvedValue()
    render(<DeleteAllDataSection />)
    expect(screen.getByText(SETTINGS_DELETE_ALL_HEADING)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: SETTINGS_DELETE_ALL_BUTTON }))
    expect(screen.getByText(SETTINGS_DELETE_ALL_CONFIRM_TITLE)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: SETTINGS_DELETE_ALL_CONFIRM_BUTTON }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledTimes(1)
    })
  })

  it('shows folder-specific confirm copy on a folder catalog', async () => {
    vi.spyOn(ConfigAPI, 'getCatalog').mockResolvedValue({
      catalog_path: '/tmp/photos',
      resolved_path: '/tmp/photos',
      exists: true,
      catalog_kind: 'folder',
      photo_count: 0,
      folder_count: 0,
      unreadable_directories: [],
      picker_available: false,
    })
    vi.spyOn(tauri, 'isTauriRuntime').mockReturnValue(true)
    render(<DeleteAllDataSection />)
    fireEvent.click(screen.getByRole('button', { name: SETTINGS_DELETE_ALL_BUTTON }))
    expect(await screen.findByText(SETTINGS_DELETE_ALL_CONFIRM_BODY_FOLDER)).toBeInTheDocument()
    expect(screen.queryByText(SETTINGS_DELETE_ALL_CONFIRM_BODY)).toBeNull()
  })
})
