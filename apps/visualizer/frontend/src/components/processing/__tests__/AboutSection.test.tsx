import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AboutSection } from '../AboutSection'
import { APP_TITLE } from '../../../constants/strings'
import {
  MODAL_CLOSE,
  SETTINGS_ABOUT_ADOBE_ATTRIBUTION,
  SETTINGS_ABOUT_LICENSES_LINK,
  SETTINGS_ABOUT_LICENSES_UNAVAILABLE,
  SETTINGS_ABOUT_NOT_AFFILIATED,
} from '../../../constants/strings'
import { SystemAPI } from '../../../services/api'

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

describe('AboutSection', () => {
  beforeEach(() => {
    vi.mocked(SystemAPI.thirdPartyNoticesAvailable).mockResolvedValue(true)
    vi.mocked(SystemAPI.thirdPartyNotices).mockResolvedValue('MIT License\n\nCopyright…\n')
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
