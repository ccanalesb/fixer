import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCatalogPicker } from '../../hooks/useCatalogPicker'
import { Button } from '../ui/Button/Button'
import { Input } from '../ui/Input/Input'
import { PathSummary, SettingRow } from './SettingRow'
import { CatalogChangeModal } from './CatalogChangeModal'
import { Badge } from '../ui/badges'
import type { ConfigCatalogChangePreviewResponse } from '../../types/config'
import { SETTINGS_CATALOG_MANUAL_PATH_HINT, SETTINGS_CATALOG_REMOTE_HINT } from '../../constants/strings'
import { InlineNotice } from '../ui/InlineNotice'

function kindLabel(kind: 'lightroom' | 'folder'): string {
  return kind === 'folder' ? 'Folder' : 'Lightroom catalog'
}

function inferKind(path: string): 'lightroom' | 'folder' {
  return path.trim().toLowerCase().endsWith('.lrcat') ? 'lightroom' : 'folder'
}

export function CatalogSettingRow() {
  const navigate = useNavigate()
  const {
    status,
    draftPath,
    setDraftPath,
    changesCatalog,
    loading,
    picking,
    pickingFolder,
    saving,
    error,
    notice,
    pickLrcat,
    pickFolder,
    previewChange,
    applyChange,
  } = useCatalogPicker()

  const [typing, setTyping] = useState<boolean | null>(null)
  const [preview, setPreview] = useState<ConfigCatalogChangePreviewResponse | null>(null)
  const [sameChoice, setSameChoice] = useState<'same' | 'different' | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  if (loading) {
    return <SettingRow name="Catalog" description="Loading…" control={null} />
  }

  if (!status) {
    return (
      <SettingRow
        name="Catalog"
        description={<span className="text-error">{error ?? 'Could not read the setting'}</span>}
        control={null}
      />
    )
  }

  const manual = typing ?? !status.pickerUsable
  const busy = picking || pickingFolder || saving

  const closeModal = () => {
    setPreview(null)
    setSameChoice(null)
    setPreviewError(null)
    setDraftPath(status.path)
  }

  const beginChange = async (path: string) => {
    setPreviewError(null)
    try {
      const result = await previewChange(path)
      if (result.unchanged) {
        setDraftPath(status.path)
        setTyping(null)
        return
      }
      setPreview(result)
      setSameChoice(result.ask_same_or_different ? null : 'different')
      setTyping(null)
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e))
    }
  }

  const handlePickLrcat = async () => {
    const chosen = await pickLrcat()
    if (!chosen) return
    setDraftPath(chosen)
    await beginChange(chosen)
  }

  const handlePickFolder = async () => {
    const chosen = await pickFolder()
    if (!chosen) return
    setDraftPath(chosen)
    await beginChange(chosen)
  }

  const confirmChange = async () => {
    if (!preview) return
    const mode =
      preview.ask_same_or_different && sameChoice === 'same' ? 'update_path' : 'switch'
    try {
      const result = await applyChange(draftPath, mode)
      setPreview(null)
      setSameChoice(null)
      if (mode === 'switch' && !result.reopened_library) {
        navigate('/', { state: { startCatalogImport: true } })
      }
    } catch {
      /* error state lives on the hook */
    }
  }

  const photoSuffix =
    status.photoCount != null
      ? ` · ${status.photoCount.toLocaleString('en-US')} photos`
      : ''

  const description = (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      <Badge>{kindLabel(status.catalogKind)}</Badge>
      <PathSummary path={status.resolvedPath || status.path} />
      {photoSuffix ? <span className="text-text-tertiary">{photoSuffix}</span> : null}
    </span>
  )

  if (status.readOnly) {
    return (
      <SettingRow
        name="Catalog"
        description={description}
        control={null}
        under={
          <p className="text-sm text-text-tertiary">{SETTINGS_CATALOG_REMOTE_HINT}</p>
        }
      />
    )
  }

  return (
    <>
      <SettingRow
        name="Catalog"
        description={description}
        control={
          status.pickerUsable ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void handlePickFolder()}
                disabled={manual || busy}
              >
                {pickingFolder ? 'Choosing…' : 'Choose folder…'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void handlePickLrcat()}
                disabled={manual || busy}
              >
                {picking ? 'Choosing…' : 'Choose .lrcat…'}
              </Button>
            </>
          ) : null
        }
        under={
          <>
            {notice ? (
              <InlineNotice className="mb-3">{notice}</InlineNotice>
            ) : null}
            {(error || previewError) && (
              <p className="mb-3 text-sm text-error">{error ?? previewError}</p>
            )}
            <details open={manual} className="group">
              <summary
                aria-disabled={busy}
                onClick={(e) => {
                  e.preventDefault()
                  if (busy) return
                  setTyping(!manual)
                }}
                className={`inline-flex list-none items-center gap-1 text-sm [&::-webkit-details-marker]:hidden ${
                  busy ? 'cursor-default text-text-tertiary' : 'cursor-pointer text-accent'
                }`}
              >
                <span className="inline-block transition-transform group-open:rotate-90">›</span>
                Enter a path manually
              </summary>
              <div className="mt-3 space-y-3">
                <Input
                  label="Folder or catalog path"
                  value={draftPath}
                  onChange={(e) => setDraftPath(e.target.value)}
                  fullWidth
                />
                {draftPath.trim() ? (
                  <p className="text-sm text-text-tertiary">
                    {inferKind(draftPath) === 'lightroom'
                      ? 'Ends in .lrcat, so this is a Lightroom catalog.'
                      : 'Not a .lrcat file, so this is a folder catalog.'}
                  </p>
                ) : null}
                <p className="text-sm text-text-tertiary">{SETTINGS_CATALOG_MANUAL_PATH_HINT}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    onClick={() => void beginChange(draftPath)}
                    disabled={busy || !changesCatalog}
                  >
                    Save
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDraftPath(status.path)
                      setTyping(null)
                    }}
                    disabled={saving}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </details>
          </>
        }
      />
      {preview ? (
        <CatalogChangeModal
          preview={preview}
          sameChoice={sameChoice}
          onSameChoice={setSameChoice}
          saving={saving}
          onCancel={closeModal}
          onConfirm={() => void confirmChange()}
        />
      ) : null}
    </>
  )
}
