import { Suspense, useCallback, useState } from 'react'
import { FrameSubstanceAPI, type FrameSubstanceResponse } from '../../services/api'
import { invalidateAll } from '../../data'
import { useQuery } from '../../data'
import { Spinner } from '../ui/Spinner'
import {
  FRAME_SUBSTANCE_ADVISORY_LABEL,
  FRAME_SUBSTANCE_DECODE_FAILED,
  FRAME_SUBSTANCE_LABEL,
  FRAME_SUBSTANCE_MOUNT_SHARE,
  FRAME_SUBSTANCE_NO_RUN,
  FRAME_SUBSTANCE_OVERRIDE_RESTORE,
  FRAME_SUBSTANCE_OVERRIDE_RESCORE_WARN,
  FRAME_SUBSTANCE_PIXEL_VOID,
  FRAME_SUBSTANCE_PIXEL_ILLEGIBLE,
  FRAME_SUBSTANCE_RESTORED,
  FRAME_SUBSTANCE_STALE,
  FRAME_SUBSTANCE_OK,
  FRAME_SUBSTANCE_UNKNOWN_UNSPECIFIED,
} from '../../constants/strings'

interface FrameSubstanceSectionProps {
  imageKey: string
  onDataChanged?: () => void
}

// An unknown verdict never falls back to the OK message: absence of a
// reading is not a clean reading, and reading silence as approval is the
// one thing this section must never do.
function unknownReasonMessage(reason: string | null | undefined): string {
  switch (reason) {
    case 'no_cache_row':
    case 'oversized_sentinel':
    case 'cache_file_missing':
      return FRAME_SUBSTANCE_MOUNT_SHARE
    case 'decode_failed':
      return FRAME_SUBSTANCE_DECODE_FAILED
    default:
      return reason
        ? `${FRAME_SUBSTANCE_UNKNOWN_UNSPECIFIED} (${reason})`
        : FRAME_SUBSTANCE_UNKNOWN_UNSPECIFIED
  }
}

function verdictSummary(data: FrameSubstanceResponse): string {
  if (!data.has_detection_run && data.verdict == null) {
    return FRAME_SUBSTANCE_NO_RUN
  }
  if (data.verdict == null) {
    return FRAME_SUBSTANCE_NO_RUN
  }
  if (data.verdict === 'unknown') {
    return unknownReasonMessage(data.unknown_reason)
  }
  if (data.verdict === 'ok') {
    return FRAME_SUBSTANCE_OK
  }
  if (data.instrument?.kind === 'pixel_detector') {
    return data.verdict === 'void'
      ? FRAME_SUBSTANCE_PIXEL_VOID
      : FRAME_SUBSTANCE_PIXEL_ILLEGIBLE
  }
  return data.verdict
}

/** A frame the detector read and found OK, with nothing else to report, needs no panel. */
function saysNothing(data: FrameSubstanceResponse): boolean {
  return data.verdict === 'ok' && !data.is_stale && !data.has_override && data.instrument == null
}

function FrameSubstanceSectionLoaded({ imageKey, onDataChanged }: FrameSubstanceSectionProps) {
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)

  const data = useQuery(
    ['frameSubstance', imageKey, reloadToken] as const,
    () => FrameSubstanceAPI.get(imageKey),
  )

  const refresh = useCallback(() => {
    setReloadToken((n) => n + 1)
    onDataChanged?.()
    invalidateAll(['images.catalog', 'list', 'dashboard', 'identity'])
  }, [onDataChanged])

  async function handleOverrideToggle() {
    setActionError(null)
    setBusy(true)
    try {
      if (data.has_override) {
        await FrameSubstanceAPI.deleteOverride(imageKey)
      } else {
        await FrameSubstanceAPI.createOverride(imageKey)
      }
      refresh()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to update override')
    } finally {
      setBusy(false)
    }
  }

  if (saysNothing(data)) return null

  const showRestore = data.flagged || data.has_override
  const restoreWarn =
    !data.has_override && data.restore_tier === 'A' ? FRAME_SUBSTANCE_OVERRIDE_RESCORE_WARN : null

  return (
    <div className="p-4 bg-surface rounded-base border border-border space-y-3">
      <h3 className="text-sm font-medium text-text">{FRAME_SUBSTANCE_LABEL}</h3>
      <p className="text-sm text-text-secondary">{verdictSummary(data)}</p>
      {data.is_stale ? (
        <p className="text-sm text-warning">{FRAME_SUBSTANCE_STALE}</p>
      ) : null}
      {data.instrument?.kind === 'excusal_channel' ? (
        <p className="text-xs text-text-tertiary">{FRAME_SUBSTANCE_ADVISORY_LABEL}</p>
      ) : null}
      {data.instrument?.kind === 'pixel_detector' && data.instrument.verdict ? (
        <p className="text-xs text-text-tertiary">
          Pixel detector · Tier {data.instrument.tier} · {data.instrument.verdict}
        </p>
      ) : null}
      {data.has_override ? (
        <p className="text-xs text-text-tertiary">{FRAME_SUBSTANCE_RESTORED}</p>
      ) : null}
      {restoreWarn ? <p className="text-xs text-text-tertiary">{restoreWarn}</p> : null}
      {showRestore ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-base border border-border px-3 py-1.5 text-sm disabled:opacity-50"
            disabled={busy || (!data.flagged && !data.has_override)}
            onClick={() => void handleOverrideToggle()}
          >
            {busy ? '…' : data.has_override ? 'Undo restore' : FRAME_SUBSTANCE_OVERRIDE_RESTORE}
          </button>
        </div>
      ) : null}
      {actionError ? (
        <p className="text-sm text-error" role="alert">
          {actionError}
        </p>
      ) : null}
    </div>
  )
}

export function FrameSubstanceSection(props: FrameSubstanceSectionProps) {
  return (
    <Suspense
      fallback={
        <div className="p-4 bg-surface rounded-base border border-border flex items-center gap-2 text-sm text-text-secondary">
          <Spinner sizeClass="h-4 w-4" />
          {FRAME_SUBSTANCE_LABEL}
        </div>
      }
    >
      <FrameSubstanceSectionLoaded {...props} />
    </Suspense>
  )
}
