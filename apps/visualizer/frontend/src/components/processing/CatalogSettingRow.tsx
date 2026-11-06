import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCatalogPicker } from '../../hooks/useCatalogPicker'
import { Button } from '../ui/Button/Button'
import { PathSummary, SettingRow } from './SettingRow'
import { CatalogChangeModal } from './CatalogChangeModal'
import { CatalogManualPath } from './CatalogManualPath'
import { Badge } from '../ui/badges'
import {
  FIRST_RUN_CHOOSE_FOLDER,
  FIRST_RUN_CHOOSE_LRCAT,
  FIRST_RUN_KIND_FOLDER,
  FIRST_RUN_KIND_LRCAT,
  SETTINGS_CATALOG_REMOTE_HINT,
} from '../../constants/strings'
import { forCatalogKind } from '../../utils/catalogKindCopy'
import { InlineNotice } from '../ui/InlineNotice'

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
    chooseLrcat,
    chooseFolder,
    beginChange,
    pendingChange,
    setSameChoice,
    cancelChange,
    confirmChange,
  } = useCatalogPicker()

  const [typing, setTyping] = useState<boolean | null>(null)

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

  const submitTyped = async () => {
    if (await beginChange(draftPath)) setTyping(null)
  }

  const confirm = async () => {
    const result = await confirmChange()
    if (result?.change === 'switch' && !result.reopened_library) {
      navigate('/', { state: { startCatalogImport: true } })
    }
  }

  const photoSuffix =
    status.photoCount != null
      ? ` · ${status.photoCount.toLocaleString('en-US')} photos`
      : ''

  const description = (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      <Badge>
        {forCatalogKind(status.catalogKind, FIRST_RUN_KIND_LRCAT, FIRST_RUN_KIND_FOLDER)}
      </Badge>
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
                onClick={() => void chooseFolder()}
                disabled={manual || busy}
              >
                {pickingFolder ? 'Choosing…' : FIRST_RUN_CHOOSE_FOLDER}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void chooseLrcat()}
                disabled={manual || busy}
              >
                {picking ? 'Choosing…' : FIRST_RUN_CHOOSE_LRCAT}
              </Button>
            </>
          ) : null
        }
        under={
          <>
            {notice ? (
              <InlineNotice className="mb-3">{notice}</InlineNotice>
            ) : null}
            {error ? <p className="mb-3 text-sm text-error">{error}</p> : null}
            <CatalogManualPath
              open={manual}
              onToggle={() => setTyping(!manual)}
              busy={busy}
              value={draftPath}
              onChange={setDraftPath}
              submitLabel="Save"
              submitDisabled={!changesCatalog}
              onSubmit={() => void submitTyped()}
              onCancel={() => {
                setDraftPath(status.path)
                setTyping(null)
              }}
            />
          </>
        }
      />
      {pendingChange ? (
        <CatalogChangeModal
          preview={pendingChange.preview}
          sameChoice={pendingChange.sameChoice}
          onSameChoice={setSameChoice}
          saving={saving}
          onCancel={cancelChange}
          onConfirm={() => void confirm()}
        />
      ) : null}
    </>
  )
}
