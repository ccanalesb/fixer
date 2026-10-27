import { useCallback, useEffect, useState } from 'react'
import { AppModelsAPI, type AppModel } from '../services/api'
import { isTauri } from '../utils/isTauri'
import { pickAppModelFolderPath } from '../utils/nativeFilePickers'
import { browserIsOnBackendHost, normalizeCatalogPath } from './useCatalogPicker'

/**
 * The models in this app and every way one is added: the backend's folder dialog,
 * or a folder path or Hugging Face id typed by hand. The same mechanism as the
 * catalog row (`useCatalogPicker`): the dialog opens on the backend's machine, so
 * it is offered only to a browser on that machine.
 */
export function useAppModelPicker() {
  const [models, setModels] = useState<AppModel[] | null>(null)
  const [pickerUsable, setPickerUsable] = useState(false)
  const [draft, setDraft] = useState('')
  const [picking, setPicking] = useState(false)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const data = await AppModelsAPI.list()
      setModels(data.models)
      setPickerUsable(
        isTauri() ||
          (data.picker_available && browserIsOnBackendHost(window.location.hostname)),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const pick = useCallback(async () => {
    setPicking(true)
    setError(null)
    try {
      const path = await pickAppModelFolderPath()
      // `null` is a dismissed dialog: the user changed their mind, not an error.
      if (path) setDraft(path)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPicking(false)
    }
  }, [])

  /** Whether the conversion was queued. A caller closing the field needs to know. */
  const add = useCallback(async () => {
    setAdding(true)
    setError(null)
    try {
      await AppModelsAPI.add(normalizeCatalogPath(draft))
      setDraft('')
      await refresh()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setAdding(false)
    }
  }, [draft, refresh])

  const clear = useCallback(() => {
    setDraft('')
    setError(null)
  }, [])

  return { models, pickerUsable, draft, setDraft, picking, adding, error, pick, add, clear, refresh }
}
