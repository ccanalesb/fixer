import { useCallback, useEffect, useState } from 'react'
import { ConfigAPI } from '../services/api'
import { isTauri } from '../utils/isTauri'
import { catalogDisplayName } from '../utils/catalogDisplayName'
import { pickCatalogPath, pickFolderCatalogPath } from '../utils/nativeFilePickers'
import type {
  CatalogChangeMode,
  CatalogKind,
  ConfigCatalogChangePreviewResponse,
  ConfigCatalogPutResponse,
} from '../types/config'

/**
 * Every way the catalog path is acquired and saved, in one place.
 *
 * A browser cannot hand JavaScript a filesystem path, so the picker is the
 * backend's: it opens a macOS dialog on its own machine and answers with what
 * was chosen. Typing a path stays as the fallback for the machines and browsers
 * that leaves out. The desktop app replaces the transport with a native dialog
 * without touching anything above this hook.
 *
 * Every chosen path goes through one change flow: a preview, then a confirmation
 * in the catalog change modal, then the save.
 */

export interface CatalogStatus {
  /** As stored in `config.yaml`, `~` and all. */
  path: string
  /** What the backend resolves that to. */
  resolvedPath: string
  exists: boolean
  catalogKind: CatalogKind
  photoCount: number | null
  folderCount: number | null
  /**
   * Whether the dialog is worth offering: the backend's machine can open one
   * AND this browser is on that machine. Both halves are needed — the dialog
   * opens where the backend is, so from another device it would appear in front
   * of nobody and hold the request until it times out.
   */
  pickerUsable: boolean
  /**
   * Another device talking to the backend over the network: the catalog is
   * read-only here, shown without buttons or a typed path. A backend-host
   * browser with no native dialog is NOT read-only — it keeps the typed path.
   */
  readOnly: boolean
}

export type SameCatalogChoice = 'same' | 'different'

/** A chosen path waiting for confirmation in the catalog change modal. */
export interface PendingCatalogChange {
  path: string
  preview: ConfigCatalogChangePreviewResponse
  /** Null until answered when the preview asks whether it is the same catalog. */
  sameChoice: SameCatalogChoice | null
}

/** What confirming saves; null while the same-or-different question is unanswered. */
export function catalogChangeMode(
  preview: Pick<ConfigCatalogChangePreviewResponse, 'ask_same_or_different'>,
  sameChoice: SameCatalogChoice | null,
): CatalogChangeMode | null {
  if (!preview.ask_same_or_different) return 'switch'
  if (sameChoice === 'same') return 'update_path'
  if (sameChoice === 'different') return 'switch'
  return null
}

/**
 * Finder's "Copy as Pathname" (⌥⌘C) wraps paths containing spaces in single
 * quotes on macOS 15+, so a pasted path arrives as `'/Users/me/My Photos/a.lrcat'`.
 */
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

/** IPv6 literals arrive bracketed in `location.hostname`; bare form for safety. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Whether this page is being served from the machine it is talking to.
 *
 * Reaching the backend over loopback is the only evidence a browser has that the
 * two are the same machine. It is a floor, not a ceiling: opening the UI by LAN
 * address while sitting at that very machine reads as remote and gives up the
 * dialog. Offering a dialog that opens somewhere else is the worse mistake.
 */
export function browserIsOnBackendHost(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname)
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
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
  const [pendingChange, setPendingChange] = useState<PendingCatalogChange | null>(null)

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
        folderCount: data.folder_count,
        pickerUsable:
          isTauri() ||
          (data.picker_available && browserIsOnBackendHost(window.location.hostname)),
        readOnly: !isTauri() && !browserIsOnBackendHost(window.location.hostname),
      })
      setDraft(data.catalog_path)
    } catch (e) {
      setError(errorMessage(e))
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

  const resetDraft = useCallback(() => {
    setDraft(status?.path ?? '')
  }, [status])

  const applyChange = useCallback(
    async (path: string, change: CatalogChangeMode) => {
      setSaving(true)
      setError(null)
      try {
        const result = await ConfigAPI.putCatalog(path, change)
        await refresh()
        const message = buildNotice(result)
        if (message) setNotice(message)
        return result
      } catch (e) {
        setError(errorMessage(e))
        return null
      } finally {
        setSaving(false)
      }
    },
    [refresh],
  )

  /**
   * Previews `rawPath` and opens the change modal for it. The first catalog is
   * saved at once: nothing is replaced, so there is nothing to confirm.
   * Resolves false when the path was rejected.
   */
  const beginChange = useCallback(
    async (rawPath: string): Promise<boolean> => {
      const path = normalizeCatalogPath(rawPath)
      if (!path) return false
      setError(null)
      let preview: ConfigCatalogChangePreviewResponse
      try {
        preview = await ConfigAPI.previewCatalogChange(path)
      } catch (e) {
        setError(errorMessage(e))
        return false
      }
      if (preview.unchanged) {
        resetDraft()
        return true
      }
      if (!status?.path.trim()) {
        return (await applyChange(path, 'switch')) !== null
      }
      setPendingChange({
        path,
        preview,
        sameChoice: preview.ask_same_or_different ? null : 'different',
      })
      return true
    },
    [applyChange, resetDraft, status],
  )

  const chooseWith = useCallback(
    async (pick: () => Promise<string | null>, setBusy: (busy: boolean) => void) => {
      setBusy(true)
      setError(null)
      let chosen: string | null
      try {
        chosen = await pick()
      } catch (e) {
        setError(errorMessage(e))
        return
      } finally {
        setBusy(false)
      }
      // `null` is a dismissed dialog: the user changed their mind, not an error.
      if (chosen) await beginChange(chosen)
    },
    [beginChange],
  )

  const chooseLrcat = useCallback(
    () => chooseWith(pickCatalogPath, setPicking),
    [chooseWith],
  )

  const chooseFolder = useCallback(
    () => chooseWith(pickFolderCatalogPath, setPickingFolder),
    [chooseWith],
  )

  const setSameChoice = useCallback((sameChoice: SameCatalogChoice) => {
    setPendingChange((pending) => (pending ? { ...pending, sameChoice } : pending))
  }, [])

  const cancelChange = useCallback(() => {
    setPendingChange(null)
    resetDraft()
  }, [resetDraft])

  /** Saves the pending change; resolves to what was saved, or null when nothing was. */
  const confirmChange = useCallback(async (): Promise<ConfigCatalogPutResponse | null> => {
    if (!pendingChange) return null
    const mode = catalogChangeMode(pendingChange.preview, pendingChange.sameChoice)
    if (!mode) return null
    const result = await applyChange(pendingChange.path, mode)
    if (result) setPendingChange(null)
    return result
  }, [applyChange, pendingChange])

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
    chooseLrcat,
    chooseFolder,
    beginChange,
    pendingChange,
    setSameChoice,
    cancelChange,
    confirmChange,
    refresh,
  }
}

function buildNotice(result: ConfigCatalogPutResponse): string {
  const name = catalogDisplayName(result.catalog_path)
  if (result.change === 'update_path') {
    return `Path updated to ${name}. The library stays; a catalog sync is queued.`
  }
  if (result.reopened_library && result.library_photo_count != null) {
    const count = result.library_photo_count.toLocaleString('en-US')
    return `Reopened ${name}: ${count} photos with their descriptions, scores and culling. A catalog sync is queued.`
  }
  return ''
}
