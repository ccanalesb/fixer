import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { JobsAPI, LrWritebackAPI, type LrWritebackSettingsResponse } from '../../services/api'
import { Button } from '../ui/Button/Button'
import { ConfirmModalFrame } from '../ui/ConfirmUndoAction'
import { Spinner } from '../ui/Spinner'
import { SettingRow } from './SettingRow'
import {
  FOLDER_WRITEBACK_LOADING,
  FOLDER_WRITEBACK_REJECT_HELP,
  FOLDER_WRITEBACK_REJECT_SWITCH,
  FOLDER_WRITEBACK_SECTION,
  FOLDER_WRITEBACK_SECTION_LEAD,
  FOLDER_WRITEBACK_SKIPPED,
  FOLDER_WRITEBACK_STARS_HELP,
  FOLDER_WRITEBACK_STARS_SWITCH,
  FOLDER_WRITEBACK_STATUS_HELP,
  FOLDER_WRITEBACK_STATUS_TITLE,
  FOLDER_WRITEBACK_TURN_ON_CANCEL,
  FOLDER_WRITEBACK_TURN_ON_CONFIRM,
  FOLDER_WRITEBACK_TURN_ON_LEAD,
  FOLDER_WRITEBACK_TURN_ON_TITLE,
  FOLDER_WRITEBACK_WRITE,
  FOLDER_WRITEBACK_WRITE_RESULT,
  FOLDER_WRITEBACK_WRITING_PROGRESS,
  LR_WRITEBACK_CLOSE_LR,
  LR_WRITEBACK_LR_CLOSED,
  LR_WRITEBACK_LR_OPEN,
  LR_WRITEBACK_PENDING,
  LR_WRITEBACK_REJECT_HELP,
  LR_WRITEBACK_REJECT_SWITCH,
  LR_WRITEBACK_SECTION,
  LR_WRITEBACK_SECTION_LEAD,
  LR_WRITEBACK_STARS_HELP,
  LR_WRITEBACK_STARS_PROFILE,
  LR_WRITEBACK_STARS_SWITCH,
  LR_WRITEBACK_STATUS_HELP,
  LR_WRITEBACK_STATUS_TITLE,
  LR_WRITEBACK_LOADING,
  LR_WRITEBACK_STOP_WRITING_BODY,
  LR_WRITEBACK_STOP_WRITING_CANCEL,
  LR_WRITEBACK_STOP_WRITING_CONFIRM,
  LR_WRITEBACK_STOP_WRITING_TITLE,
  LR_WRITEBACK_WRITE_RESULT,
  LR_WRITEBACK_WRITE_TO_LR,
  LR_WRITEBACK_WRITTEN,
  LR_WRITEBACK_WRITING_JOB_LINK,
  LR_WRITEBACK_WRITING_PROGRESS,
  PROCESSING_JOB_QUEUE_ROUTE,
} from '../../constants/strings'

const LR_WRITEBACK_JOB_TYPE = 'lr_writeback'
const JOB_POLL_MS = 2000

type LrWritebackJobResult = {
  catalog_updated_stars?: number
  catalog_updated_reject?: number
}

type TurnOnDialog = {
  kind: 'stars' | 'reject'
  preview: { new_sidecar: number; update_sidecar: number; embedded: number }
}

export function LightroomWritebackSection() {
  const [data, setData] = useState<LrWritebackSettingsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [writebackJobId, setWritebackJobId] = useState<string | null>(null)
  const [writeBusy, setWriteBusy] = useState(false)
  const [writeResult, setWriteResult] = useState<string | null>(null)
  const [stopDialog, setStopDialog] = useState<'stars' | 'reject' | null>(null)
  const [stopBusy, setStopBusy] = useState(false)
  const [turnOnDialog, setTurnOnDialog] = useState<TurnOnDialog | null>(null)
  const [turnOnBusy, setTurnOnBusy] = useState(false)

  const isFolder = data?.catalog_kind === 'folder'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await LrWritebackAPI.getSettings())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load write-back settings')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const refreshActiveJob = useCallback(async () => {
    try {
      const active = await JobsAPI.getActive()
      const job = active.find((j) => j.type === LR_WRITEBACK_JOB_TYPE)
      setWritebackJobId(job?.id ?? null)
      return job ?? null
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    void refreshActiveJob()
  }, [refreshActiveJob])

  const prevJobId = useRef<string | null>(null)
  useEffect(() => {
    const finishedId = prevJobId.current
    if (finishedId && !writebackJobId) {
      void (async () => {
        try {
          const job = await JobsAPI.get(finishedId)
          const result = job.result as LrWritebackJobResult | null | undefined
          if (result && job.status === 'completed') {
            const n = (result.catalog_updated_stars ?? 0) + (result.catalog_updated_reject ?? 0)
            setWriteResult(
              isFolder ? FOLDER_WRITEBACK_WRITE_RESULT(n) : LR_WRITEBACK_WRITE_RESULT(n),
            )
          }
        } catch {
          /* ignore */
        }
        await load()
      })()
    }
    prevJobId.current = writebackJobId
  }, [writebackJobId, load, isFolder])

  useEffect(() => {
    if (!writebackJobId) return
    const t = window.setInterval(() => {
      void refreshActiveJob()
    }, JOB_POLL_MS)
    return () => window.clearInterval(t)
  }, [writebackJobId, refreshActiveJob])

  const patchSettings = async (body: Parameters<typeof LrWritebackAPI.patchSettings>[0]) => {
    const next = await LrWritebackAPI.patchSettings(body)
    setData(next)
    return next
  }

  const confirmTurnOn = async () => {
    if (!turnOnDialog) return
    setTurnOnBusy(true)
    try {
      await patchSettings(
        turnOnDialog.kind === 'stars' ? { write_stars: true } : { write_reject: true },
      )
      setTurnOnDialog(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed')
    } finally {
      setTurnOnBusy(false)
    }
  }

  const turnSwitch = async (kind: 'stars' | 'reject', checked: boolean) => {
    if (!checked && writebackJobId) {
      setStopDialog(kind)
      return
    }

    if (checked && isFolder) {
      try {
        const preview = await LrWritebackAPI.turnOnPreview(kind)
        setTurnOnDialog({ kind, preview })
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Update failed')
      }
      return
    }

    try {
      await patchSettings(kind === 'stars' ? { write_stars: checked } : { write_reject: checked })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed')
    }
  }

  const confirmStopWriting = async () => {
    if (!stopDialog) return
    setStopBusy(true)
    try {
      await patchSettings(
        stopDialog === 'stars' ? { write_stars: false } : { write_reject: false },
      )
      setStopDialog(null)
      await refreshActiveJob()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed')
    } finally {
      setStopBusy(false)
    }
  }

  const writeToCatalog = async () => {
    setWriteBusy(true)
    setWriteResult(null)
    try {
      const { job_id } = await LrWritebackAPI.write()
      setWritebackJobId(job_id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Write failed')
    } finally {
      setWriteBusy(false)
    }
  }

  if (loading && !data) {
    return (
      <p className="text-sm text-text-secondary">
        {isFolder ? FOLDER_WRITEBACK_LOADING : LR_WRITEBACK_LOADING}
      </p>
    )
  }
  if (!data) {
    return <p className="text-sm text-error">{error ?? 'Could not load settings'}</p>
  }

  const pendingTotal = data.counts.stars.pending + data.counts.reject.pending
  const writtenTotal = data.counts.stars.written + data.counts.reject.written
  const skippedTotal = (data.counts.stars.skipped ?? 0) + (data.counts.reject.skipped ?? 0)
  const showProfileSelect = data.active_profile_slugs.length > 1
  const jobRunning = writebackJobId !== null
  const switchesOn = data.write_stars || data.write_reject
  const writeDisabled =
    !switchesOn || jobRunning || !data.catalog_write_available || writeBusy

  const sectionTitle = isFolder ? FOLDER_WRITEBACK_SECTION : LR_WRITEBACK_SECTION
  const sectionLead = isFolder ? FOLDER_WRITEBACK_SECTION_LEAD : LR_WRITEBACK_SECTION_LEAD
  const starsSwitch = isFolder ? FOLDER_WRITEBACK_STARS_SWITCH : LR_WRITEBACK_STARS_SWITCH
  const starsHelp = isFolder ? FOLDER_WRITEBACK_STARS_HELP : LR_WRITEBACK_STARS_HELP
  const rejectSwitch = isFolder ? FOLDER_WRITEBACK_REJECT_SWITCH : LR_WRITEBACK_REJECT_SWITCH
  const rejectHelp = isFolder ? FOLDER_WRITEBACK_REJECT_HELP : LR_WRITEBACK_REJECT_HELP
  const statusTitle = isFolder ? FOLDER_WRITEBACK_STATUS_TITLE : LR_WRITEBACK_STATUS_TITLE
  const statusHelp = isFolder ? FOLDER_WRITEBACK_STATUS_HELP : LR_WRITEBACK_STATUS_HELP
  const writeLabel = isFolder ? FOLDER_WRITEBACK_WRITE : LR_WRITEBACK_WRITE_TO_LR
  const writingProgress = isFolder ? FOLDER_WRITEBACK_WRITING_PROGRESS : LR_WRITEBACK_WRITING_PROGRESS

  return (
    <div className="space-y-0 divide-y divide-border rounded-base border border-border bg-bg">
      {turnOnDialog ? (
        <ConfirmModalFrame
          title={FOLDER_WRITEBACK_TURN_ON_TITLE(turnOnDialog.kind)}
          confirmLabel={FOLDER_WRITEBACK_TURN_ON_CONFIRM}
          cancelLabel={FOLDER_WRITEBACK_TURN_ON_CANCEL}
          onConfirm={() => void confirmTurnOn()}
          onCancel={() => setTurnOnDialog(null)}
          busy={turnOnBusy}
        >
          <p className="text-sm text-text-secondary">
            {FOLDER_WRITEBACK_TURN_ON_LEAD(data.catalog_path ?? 'your folder')}
          </p>
          <ul className="mt-3 text-sm list-disc pl-5 space-y-1">
            <li>
              <b>{turnOnDialog.preview.new_sidecar}</b> RAW photos get a new <code>.xmp</code> file next
              to them
            </li>
            <li>
              <b>{turnOnDialog.preview.update_sidecar}</b> existing <code>.xmp</code> files are updated
            </li>
            <li>
              <b>{turnOnDialog.preview.embedded}</b> JPEG, HEIC and TIFF files are rewritten with the
              rating inside
            </li>
          </ul>
          <p className="mt-3 text-sm text-text-secondary">
            Photos you rated are never touched. No backup copies are kept. You can undo each photo from
            its detail.
          </p>
        </ConfirmModalFrame>
      ) : null}

      {stopDialog ? (
        <ConfirmModalFrame
          title={LR_WRITEBACK_STOP_WRITING_TITLE}
          confirmLabel={LR_WRITEBACK_STOP_WRITING_CONFIRM}
          cancelLabel={LR_WRITEBACK_STOP_WRITING_CANCEL}
          onConfirm={() => void confirmStopWriting()}
          onCancel={() => setStopDialog(null)}
          busy={stopBusy}
        >
          <p className="text-sm text-text-secondary">{LR_WRITEBACK_STOP_WRITING_BODY}</p>
        </ConfirmModalFrame>
      ) : null}

      <div className="p-4 border-b border-border">
        <h4 className="text-sm font-semibold text-text">{sectionTitle}</h4>
        <p className="mt-1 text-sm text-text-secondary">{sectionLead}</p>
      </div>

      <SettingRow
        name={starsSwitch}
        description={starsHelp}
        control={
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={data.write_stars}
              onChange={(e) => void turnSwitch('stars', e.target.checked)}
            />
          </label>
        }
        under={
          showProfileSelect && data.write_stars ? (
            <label className="block text-sm max-w-md">
              <span className="font-medium">{LR_WRITEBACK_STARS_PROFILE}</span>
              <select
                className="mt-1 w-full border border-border rounded-base px-2 py-1"
                value={data.stars_profile_slug ?? ''}
                onChange={(e) => void patchSettings({ stars_profile_slug: e.target.value || null })}
              >
                {(data.active_profiles ?? data.active_profile_slugs.map((slug) => ({ slug, name: slug }))).map(
                  (r) => (
                    <option key={r.slug} value={r.slug}>
                      {r.name}
                    </option>
                  ),
                )}
              </select>
            </label>
          ) : null
        }
      />

      <SettingRow
        name={rejectSwitch}
        description={rejectHelp}
        control={
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={data.write_reject}
              onChange={(e) => void turnSwitch('reject', e.target.checked)}
            />
          </label>
        }
        under={
          <div className="text-xs text-text-secondary flex flex-wrap gap-4">
            <span>
              {LR_WRITEBACK_PENDING} (stars): <b>{data.counts.stars.pending}</b>
            </span>
            <span>
              {LR_WRITEBACK_WRITTEN} (stars): <b>{data.counts.stars.written}</b>
            </span>
            <span>
              {LR_WRITEBACK_PENDING} (reject): <b>{data.counts.reject.pending}</b>
            </span>
            <span>
              {LR_WRITEBACK_WRITTEN} (reject): <b>{data.counts.reject.written}</b>
            </span>
          </div>
        }
      />

      {jobRunning ? (
        <div className="px-4 py-3 flex items-center gap-2 text-sm text-text-secondary">
          <Spinner sizeClass="h-4 w-4" />
          <span>
            {writingProgress}{' '}
            <Link to={PROCESSING_JOB_QUEUE_ROUTE} className="text-primary underline">
              {LR_WRITEBACK_WRITING_JOB_LINK}
            </Link>
          </span>
        </div>
      ) : null}

      <div className="px-4 py-3 flex flex-wrap items-center gap-3">
        <Button type="button" disabled={writeDisabled} onClick={() => void writeToCatalog()}>
          {writeLabel}
        </Button>
        {!isFolder && !data.catalog_write_available ? (
          <span className="text-xs text-warning">{LR_WRITEBACK_CLOSE_LR}</span>
        ) : null}
        {writeResult ? <span className="text-xs text-text-secondary">{writeResult}</span> : null}
      </div>

      <SettingRow
        name={statusTitle}
        description={statusHelp}
        control={
          isFolder ? (
            <span className="hidden sm:inline" aria-hidden />
          ) : (
            <div className="flex flex-col items-end gap-1 text-xs text-text-secondary">
              <span
                className={
                  data.catalog_write_available ? 'text-success font-medium' : 'text-warning font-medium'
                }
              >
                {data.catalog_write_available ? LR_WRITEBACK_LR_CLOSED : LR_WRITEBACK_LR_OPEN}
              </span>
            </div>
          )
        }
        under={
          <div className="text-xs text-text-secondary flex flex-wrap gap-3 items-center">
            <span>
              {LR_WRITEBACK_PENDING} <b>{pendingTotal}</b>
            </span>
            <span>
              {LR_WRITEBACK_WRITTEN} <b>{writtenTotal}</b>
            </span>
            {isFolder ? (
              <span>
                {FOLDER_WRITEBACK_SKIPPED} <b>{skippedTotal}</b>
              </span>
            ) : null}
            {error ? <span className="text-error">{error}</span> : null}
          </div>
        }
      />
    </div>
  )
}
