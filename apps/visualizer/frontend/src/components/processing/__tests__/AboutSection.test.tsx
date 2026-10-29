import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AboutSection } from '../AboutSection'
import { APP_TITLE } from '../../../constants/strings'
import {
  MODAL_CLOSE,
  SETTINGS_ABOUT_ADOBE_ATTRIBUTION,
  SETTINGS_ABOUT_CHECK_UPDATES,
  SETTINGS_ABOUT_LICENSES_LINK,
  SETTINGS_ABOUT_LICENSES_UNAVAILABLE,
  SETTINGS_ABOUT_NOT_AFFILIATED,
  SETTINGS_ABOUT_UPDATES_CHECK_FAILED,
  SETTINGS_ABOUT_UPDATES_UP_TO_DATE,
} from '../../../constants/strings'
import { SystemAPI } from '../../../services/api'
import * as tauriUtils from '../../../utils/tauri'

vi.mock('../../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/api')>()
  return {
    ...actual,
    SystemAPI: {
      ...actual.SystemAPI,
      thirdPartyNoticesAvailable: vi.fn(),
      thirdPartyNotices: vi.fn(),
    },
  }
})

vi.mock('../../../utils/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/tauri')>()
  return {
    ...actual,
    isTauriRuntime: vi.fn(() => false),
    invokeCheckForUpdatesManual: vi.fn(),
  }
})

describe('AboutSection', () => {
  beforeEach(() => {
    vi.mocked(SystemAPI.thirdPartyNoticesAvailable).mockResolvedValue(true)
    vi.mocked(SystemAPI.thirdPartyNotices).mockResolvedValue('MIT License\n\nCopyright…\n')
    vi.mocked(tauriUtils.isTauriRuntime).mockReturnValue(false)
    vi.mocked(tauriUtils.invokeCheckForUpdatesManual).mockReset()
  })

  it('shows the app name, version, Adobe attribution and licenses link when notices exist', async () => {
    render(<AboutSection />)
    expect(screen.getByText(APP_TITLE)).toBeInTheDocument()
    expect(screen.getByText(/Version/)).toHaveTextContent(__APP_VERSION__)
    expect(screen.getByText(SETTINGS_ABOUT_ADOBE_ATTRIBUTION)).toBeInTheDocument()
    expect(screen.getByText(SETTINGS_ABOUT_NOT_AFFILIATED)).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: SETTINGS_ABOUT_LICENSES_LINK })).toBeEnabled()
    })
  })

  it('does not show Check for updates in the browser', async () => {
    render(<AboutSection />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SETTINGS_ABOUT_LICENSES_LINK })).toBeEnabled()
    })
    expect(screen.queryByRole('button', { name: SETTINGS_ABOUT_CHECK_UPDATES })).not.toBeInTheDocument()
  })

  it('shows Check for updates in the desktop app', async () => {
    vi.mocked(tauriUtils.isTauriRuntime).mockReturnValue(true)
    render(<AboutSection />)
    expect(await screen.findByRole('button', { name: SETTINGS_ABOUT_CHECK_UPDATES })).toBeInTheDocument()
  })

  it('shows up-to-date copy after a successful manual check', async () => {
    vi.mocked(tauriUtils.isTauriRuntime).mockReturnValue(true)
    vi.mocked(tauriUtils.invokeCheckForUpdatesManual).mockResolvedValue('up_to_date')
    render(<AboutSection />)
    fireEvent.click(await screen.findByRole('button', { name: SETTINGS_ABOUT_CHECK_UPDATES }))
    expect(await screen.findByRole('status')).toHaveTextContent(SETTINGS_ABOUT_UPDATES_UP_TO_DATE)
  })

  it('shows failure copy when the manual check fails', async () => {
    vi.mocked(tauriUtils.isTauriRuntime).mockReturnValue(true)
    vi.mocked(tauriUtils.invokeCheckForUpdatesManual).mockResolvedValue('check_failed')
    render(<AboutSection />)
    fireEvent.click(await screen.findByRole('button', { name: SETTINGS_ABOUT_CHECK_UPDATES }))
    expect(await screen.findByRole('status')).toHaveTextContent(SETTINGS_ABOUT_UPDATES_CHECK_FAILED)
  })

  it('does not show inline status when an update is available (host shows the notice)', async () => {
    vi.mocked(tauriUtils.isTauriRuntime).mockReturnValue(true)
    vi.mocked(tauriUtils.invokeCheckForUpdatesManual).mockResolvedValue('update_available')
    render(<AboutSection />)
    fireEvent.click(await screen.findByRole('button', { name: SETTINGS_ABOUT_CHECK_UPDATES }))
    await waitFor(() => {
      expect(tauriUtils.invokeCheckForUpdatesManual).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows unavailable copy when notices are not bundled', async () => {
    vi.mocked(SystemAPI.thirdPartyNoticesAvailable).mockResolvedValue(false)
    render(<AboutSection />)
    await waitFor(() => {
      expect(screen.getByText(SETTINGS_ABOUT_LICENSES_UNAVAILABLE)).toBeInTheDocument()
    })
  })

  it('opens an in-app viewer with the fetched notices when the link is clicked', async () => {
    render(<AboutSection />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SETTINGS_ABOUT_LICENSES_LINK })).toBeEnabled()
    })
    fireEvent.click(screen.getByRole('button', { name: SETTINGS_ABOUT_LICENSES_LINK }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    await waitFor(() => {
      expect(SystemAPI.thirdPartyNotices).toHaveBeenCalledTimes(1)
    })
    expect(screen.getByText(/MIT License/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: MODAL_CLOSE }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })
})
