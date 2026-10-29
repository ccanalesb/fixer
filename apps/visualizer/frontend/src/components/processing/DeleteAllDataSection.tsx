import { useState } from 'react'
import { Button } from '../ui/Button/Button'
import { RedecideConfirmDialog } from '../cull/RedecideConfirmDialog'
import {
  SETTINGS_DELETE_ALL_BUTTON,
  SETTINGS_DELETE_ALL_CONFIRM_BODY,
  SETTINGS_DELETE_ALL_CONFIRM_BUTTON,
  SETTINGS_DELETE_ALL_CONFIRM_TITLE,
  SETTINGS_DELETE_ALL_DESCRIPTION,
  SETTINGS_DELETE_ALL_HEADING,
  SETTINGS_DELETE_ALL_WORKING,
} from '../../constants/strings'
import { invokeDeleteAllDataAndQuit, isTauriRuntime } from '../../utils/tauri'

export function DeleteAllDataSection() {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!isTauriRuntime()) {
    return null
  }

  const onConfirm = async () => {
    setWorking(true)
    setError(null)
    try {
      await invokeDeleteAllDataAndQuit()
    } catch (e) {
      setWorking(false)
      setConfirmOpen(false)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-card-title text-text mb-2">{SETTINGS_DELETE_ALL_HEADING}</h3>
        <p className="text-sm text-text-secondary">{SETTINGS_DELETE_ALL_DESCRIPTION}</p>
      </div>
      <div className="rounded-base border border-border bg-bg p-4">
        {error && <p className="mb-3 text-sm text-error">{error}</p>}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-error hover:bg-error/10"
          disabled={working}
          onClick={() => setConfirmOpen(true)}
        >
          {working ? SETTINGS_DELETE_ALL_WORKING : SETTINGS_DELETE_ALL_BUTTON}
        </Button>
      </div>
      {confirmOpen && (
        <RedecideConfirmDialog
          title={SETTINGS_DELETE_ALL_CONFIRM_TITLE}
          body={SETTINGS_DELETE_ALL_CONFIRM_BODY}
          confirmLabel={working ? SETTINGS_DELETE_ALL_WORKING : SETTINGS_DELETE_ALL_CONFIRM_BUTTON}
          onCancel={() => {
            if (!working) setConfirmOpen(false)
          }}
          onConfirm={() => void onConfirm()}
        />
      )}
    </section>
  )
}
