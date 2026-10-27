import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeleteAllDataSection } from '../DeleteAllDataSection'
import {
  SETTINGS_DELETE_ALL_BUTTON,
  SETTINGS_DELETE_ALL_CONFIRM_BUTTON,
  SETTINGS_DELETE_ALL_CONFIRM_TITLE,
  SETTINGS_DELETE_ALL_HEADING,
} from '../../../constants/strings'
import * as tauri from '../../../utils/tauri'

describe('DeleteAllDataSection', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
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
})
