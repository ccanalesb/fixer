import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AboutSection } from '../AboutSection'
import { APP_TITLE } from '../../../constants/strings'
import {
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
      thirdPartyNoticesUrl: vi.fn(() => 'http://test/api/system/third-party-notices'),
    },
  }
})

describe('AboutSection', () => {
  beforeEach(() => {
    vi.mocked(SystemAPI.thirdPartyNoticesAvailable).mockResolvedValue(true)
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

  it('opens the notices URL in a new tab when the link is clicked', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<AboutSection />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SETTINGS_ABOUT_LICENSES_LINK })).toBeEnabled()
    })
    fireEvent.click(screen.getByRole('button', { name: SETTINGS_ABOUT_LICENSES_LINK }))
    expect(open).toHaveBeenCalledWith(
      'http://test/api/system/third-party-notices',
      '_blank',
      'noopener,noreferrer',
    )
    open.mockRestore()
  })
})
