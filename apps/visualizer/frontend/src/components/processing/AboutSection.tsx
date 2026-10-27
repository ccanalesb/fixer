import { useEffect, useState } from 'react'
import { APP_TITLE } from '../../constants/strings'
import {
  SETTINGS_ABOUT_ADOBE_ATTRIBUTION,
  SETTINGS_ABOUT_HEADING,
  SETTINGS_ABOUT_LICENSES_LINK,
  SETTINGS_ABOUT_LICENSES_UNAVAILABLE,
  SETTINGS_ABOUT_NOT_AFFILIATED,
  SETTINGS_ABOUT_VERSION_LABEL,
} from '../../constants/strings'
import { SystemAPI } from '../../services/api'

export function AboutSection() {
  const [licensesAvailable, setLicensesAvailable] = useState<boolean | null>(null)

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
    window.open(SystemAPI.thirdPartyNoticesUrl(), '_blank', 'noopener,noreferrer')
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
          <p className="text-text-secondary">{SETTINGS_ABOUT_ADOBE_ATTRIBUTION}</p>
          <p className="text-text-secondary">{SETTINGS_ABOUT_NOT_AFFILIATED}</p>
          <div className="pt-1" aria-hidden="true" data-testid="about-updates-slot" />
        </div>
      </div>
    </section>
  )
}
