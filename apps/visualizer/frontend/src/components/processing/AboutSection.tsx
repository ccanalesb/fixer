import { useEffect, useState } from 'react'
import { APP_TITLE } from '../../constants/strings'
import {
  SETTINGS_ABOUT_ADOBE_ATTRIBUTION,
  SETTINGS_ABOUT_CHECK_UPDATES,
  SETTINGS_ABOUT_HEADING,
  SETTINGS_ABOUT_LICENSES_LINK,
  SETTINGS_ABOUT_LICENSES_UNAVAILABLE,
  SETTINGS_ABOUT_NOT_AFFILIATED,
  SETTINGS_ABOUT_UPDATES_CHECK_FAILED,
  SETTINGS_ABOUT_UPDATES_UP_TO_DATE,
  SETTINGS_ABOUT_VERSION_LABEL,
} from '../../constants/strings'
import { SystemAPI } from '../../services/api'
import { invokeCheckForUpdatesManual, isTauriRuntime } from '../../utils/tauri'
import { ThirdPartyNoticesModal } from './ThirdPartyNoticesModal'

export function AboutSection() {
  const [licensesAvailable, setLicensesAvailable] = useState<boolean | null>(null)
  const [noticesOpen, setNoticesOpen] = useState(false)
  const [noticesText, setNoticesText] = useState<string | null>(null)
  const [noticesLoading, setNoticesLoading] = useState(false)
  const [noticesError, setNoticesError] = useState<string | null>(null)
  const [updateCheckMessage, setUpdateCheckMessage] = useState<string | null>(null)
  const [updateCheckBusy, setUpdateCheckBusy] = useState(false)
  const inDesktopApp = isTauriRuntime()

  useEffect(() => {
    let cancelled = false
    void SystemAPI.thirdPartyNoticesAvailable().then((ok) => {
      if (!cancelled) setLicensesAvailable(ok)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const openLicenses = () => {
    if (!licensesAvailable) return
    setNoticesOpen(true)
    setNoticesLoading(true)
    setNoticesError(null)
    setNoticesText(null)
    void SystemAPI.thirdPartyNotices()
      .then((body) => {
        setNoticesText(body)
        setNoticesLoading(false)
      })
      .catch((e) => {
        setNoticesError(e instanceof Error ? e.message : String(e))
        setNoticesLoading(false)
      })
  }

  const closeNotices = () => {
    setNoticesOpen(false)
    setNoticesText(null)
    setNoticesError(null)
    setNoticesLoading(false)
  }

  const checkForUpdates = () => {
    setUpdateCheckBusy(true)
    setUpdateCheckMessage(null)
    void invokeCheckForUpdatesManual()
      .then((result) => {
        if (result === 'up_to_date') {
          setUpdateCheckMessage(SETTINGS_ABOUT_UPDATES_UP_TO_DATE)
        } else if (result === 'check_failed') {
          setUpdateCheckMessage(SETTINGS_ABOUT_UPDATES_CHECK_FAILED)
        }
        // update_available: native dialog is shown by the host
      })
      .catch(() => {
        setUpdateCheckMessage(SETTINGS_ABOUT_UPDATES_CHECK_FAILED)
      })
      .finally(() => {
        setUpdateCheckBusy(false)
      })
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-card-title text-text mb-2">{SETTINGS_ABOUT_HEADING}</h3>
      </div>
      <div className="divide-y divide-border rounded-base border border-border bg-bg">
        <div className="space-y-3 p-4 text-sm">
          <div>
            <div className="font-medium text-text">{APP_TITLE}</div>
            <div className="mt-1 text-text-secondary">
              {SETTINGS_ABOUT_VERSION_LABEL} {__APP_VERSION__}
            </div>
          </div>
          <div>
            {licensesAvailable === false ? (
              <span className="text-text-secondary">{SETTINGS_ABOUT_LICENSES_UNAVAILABLE}</span>
            ) : (
              <button
                type="button"
                className="text-accent hover:underline disabled:cursor-wait disabled:opacity-60"
                disabled={licensesAvailable !== true}
                onClick={openLicenses}
              >
                {SETTINGS_ABOUT_LICENSES_LINK}
              </button>
            )}
          </div>
          {inDesktopApp ? (
            <div className="space-y-1">
              <button
                type="button"
                className="text-accent hover:underline disabled:cursor-wait disabled:opacity-60"
                disabled={updateCheckBusy}
                onClick={checkForUpdates}
              >
                {SETTINGS_ABOUT_CHECK_UPDATES}
              </button>
              {updateCheckMessage ? (
                <p className="text-text-secondary" role="status">
                  {updateCheckMessage}
                </p>
              ) : null}
            </div>
          ) : null}
          <p className="text-text-secondary">{SETTINGS_ABOUT_ADOBE_ATTRIBUTION}</p>
          <p className="text-text-secondary">{SETTINGS_ABOUT_NOT_AFFILIATED}</p>
        </div>
      </div>
      {noticesOpen && (
        <ThirdPartyNoticesModal
          text={noticesText}
          loading={noticesLoading}
          error={noticesError}
          onClose={closeNotices}
        />
      )}
    </section>
  )
}
