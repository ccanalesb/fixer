import { useCallback, useEffect, useState } from 'react'
import { ConfigAPI } from '../services/api'
import { isTauri } from '../utils/isTauri'
import { pickCatalogPath, pickFolderCatalogPath } from '../utils/nativeFilePickers'
import type { ConfigCatalogPutResponse } from '../types/config'

/**
 * Every way the catalog path is acquired and saved, in one place.
 *
 * A browser cannot hand JavaScript a filesystem path, so the picker is the
 * backend's: it opens a macOS dialog on its own machine and answers with what
 * was chosen. Typing a path stays as the fallback for the machines and browsers
 * that leaves out. The desktop app replaces the transport with a native dialog
 * without touching anything above this hook.
 */

export interface CatalogStatus {
  path: string
  resolvedPath: string
  exists: boolean
  catalogKind: 'lightroom' | 'folder'
  photoCount: number | null
  pickerUsable: boolean
}

export function normalizeCatalogPath(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length < 2) return trimmed
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if ((first === "'" || first === '"') && first === last) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function browserIsOnBackendHost(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname)
}

export function useCatalogPicker() {
  const [status, setStatus] = useState<CatalogStatus | null>(null)
  const [draftPath, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [picking, setPicking] = useState(false)
  const [pickingFolder, setPickingFolder] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const data = await ConfigAPI.getCatalog()
      setStatus({
        path: data.catalog_path,
        resolvedPath: data.resolved_path,
        exists: data.exists,
        catalogKind: data.catalog_kind,
        photoCount: data.photo_count,
        pickerUsable:
          isTauri() ||
          (data.picker_available && browserIsOnBackendHost(window.location.hostname)),
      })
      setDraft(data.catalog_path)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const setDraftPath = useCallback((value: string) => {
    setDraft(normalizeCatalogPath(value))
  }, [])

  const pickLrcat = useCallback(async (): Promise<string | null> => {
    setPicking(true)
    setError(null)
    try {
      return await pickCatalogPath()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setPicking(false)
    }
  }, [])

  const pickFolder = useCallback(async (): Promise<string | null> => {
    setPickingFolder(true)
    setError(null)
    try {
      return await pickFolderCatalogPath()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setPickingFolder(false)
    }
  }, [])

  const previewChange = useCallback(async (path: string) => {
    setError(null)
    return ConfigAPI.previewCatalogChange(path)
  }, [])

  const applyChange = useCallback(
    async (path: string, change: 'update_path' | 'switch') => {
      setSaving(true)
      setError(null)
      try {
        const result = await ConfigAPI.putCatalog(path, change)
        await refresh()
        const message = buildNotice(result)
        if (message) setNotice(message)
        return result
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        throw e
      } finally {
        setSaving(false)
      }
    },
    [refresh],
  )

  return {
    status,
    draftPath,
    setDraftPath,
    changesCatalog: status !== null && draftPath !== status.path,
    loading,
    picking,
    pickingFolder,
    saving,
    error,
    notice,
    clearNotice: () => setNotice(null),
    pickLrcat,
    pickFolder,
    previewChange,
    applyChange,
    refresh,
  }
}

function buildNotice(result: ConfigCatalogPutResponse): string {
  if (result.change === 'update_path') {
    return 'The library stays. A catalog sync is queued.'
  }
  if (result.reopened_library && result.library_photo_count != null) {
    const count = result.library_photo_count.toLocaleString('en-US')
    return `Reopened this catalog: ${count} photos with their descriptions, scores and culling. A catalog sync is queued.`
  }
  return ''
}