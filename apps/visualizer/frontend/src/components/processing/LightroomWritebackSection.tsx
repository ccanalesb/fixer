import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { JobsAPI, LrWritebackAPI, type LrWritebackSettingsResponse } from '../../services/api'
import { Button } from '../ui/Button/Button'
import { ConfirmModalFrame } from '../ui/ConfirmUndoAction'
import { Spinner } from '../ui/Spinner'
import { SettingRow } from './SettingRow'
import {
  LR_WRITEBACK_CLOSE_LR,
  LR_WRITEBACK_LR_CLOSED,
  LR_WRITEBACK_LR_OPEN,
  LR_WRITEBACK_PENDING,
  LR_WRITEBACK_REJECT_HELP,
  LR_WRITEBACK_REJECT_SWITCH,
  LR_WRITEBACK_SECTION,
  LR_WRITEBACK_SECTION_LEAD,
  LR_WRITEBACK_STARS_HELP,
  LR_WRITEBACK_STARS_RECIPE,
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

export function LightroomWritebackSection() {
  const [data, setData] = useState<LrWritebackSettingsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [writebackJobId, setWritebackJobId] = useState<string | null>(null)
  const [writeBusy, setWriteBusy] = useState(false)
  const [writeResult, setWriteResult] = useState<string | null>(null)
  const [stopDialog, setStopDialog] = useState<'stars' | 'reject' | null>(null)
  const [stopBusy, setStopBusy] = useState(false)

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
            setWriteResult(LR_WRITEBACK_WRITE_RESULT(n))
          }
        } catch {
          /* ignore */
        }
        await load()
      })()
    }
    prevJobId.current = writebackJobId
  }, [writebackJobId, load])

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

  const turnSwitch = async (kind: 'stars' | 'reject', checked: boolean) => {
    if (!checked && writebackJobId) {
      setStopDialog(kind)
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

  const writeToLightroom = async () => {
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
    return <p className="text-sm text-text-secondary">{LR_WRITEBACK_LOADING}</p>
  }
  if (!data) {
    return <p className="text-sm text-error">{error ?? 'Could not load settings'}</p>
  }

  const pendingTotal = data.counts.stars.pending + data.counts.reject.pending
  const writtenTotal = data.counts.stars.written + data.counts.reject.written
  const showRecipeSelect = data.active_recipe_slugs.length > 1
  const jobRunning = writebackJobId !== null
  const switchesOn = data.write_stars || data.write_reject
  const writeDisabled =
    !switchesOn || jobRunning || !data.catalog_write_available || writeBusy

  return (
    <div className="space-y-0 divide-y divide-border rounded-base border border-border bg-bg">
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
        <h4 className="text-sm font-semibold text-text">{LR_WRITEBACK_SECTION}</h4>
        <p className="mt-1 text-sm text-text-secondary">{LR_WRITEBACK_SECTION_LEAD}</p>
      </div>

      <SettingRow
        name={LR_WRITEBACK_STARS_SWITCH}
        description={LR_WRITEBACK_STARS_HELP}
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
          showRecipeSelect && data.write_stars ? (
            <label className="block text-sm max-w-md">
              <span className="font-medium">{LR_WRITEBACK_STARS_RECIPE}</span>
              <select
                className="mt-1 w-full border border-border rounded-base px-2 py-1"
                value={data.stars_recipe_slug ?? ''}
                onChange={(e) => void patchSettings({ stars_recipe_slug: e.target.value || null })}
              >
                {(data.active_recipes ?? data.active_recipe_slugs.map((slug) => ({ slug, name: slug }))).map(
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
        name={LR_WRITEBACK_REJECT_SWITCH}
        description={LR_WRITEBACK_REJECT_HELP}
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
            {LR_WRITEBACK_WRITING_PROGRESS}{' '}
            <Link to={PROCESSING_JOB_QUEUE_ROUTE} className="text-primary underline">
              {LR_WRITEBACK_WRITING_JOB_LINK}
            </Link>
          </span>
        </div>
      ) : null}

      <div className="px-4 py-3 flex flex-wrap items-center gap-3">
        <Button type="button" disabled={writeDisabled} onClick={() => void writeToLightroom()}>
          {LR_WRITEBACK_WRITE_TO_LR}
        </Button>
        {!data.catalog_write_available ? (
          <span className="text-xs text-warning">{LR_WRITEBACK_CLOSE_LR}</span>
        ) : null}
        {writeResult ? <span className="text-xs text-text-secondary">{writeResult}</span> : null}
      </div>

      <SettingRow
        name={LR_WRITEBACK_STATUS_TITLE}
        description={LR_WRITEBACK_STATUS_HELP}
        control={
          <div className="flex flex-col items-end gap-1 text-xs text-text-secondary">
            <span
              className={
                data.catalog_write_available ? 'text-success font-medium' : 'text-warning font-medium'
              }
            >
              {data.catalog_write_available ? LR_WRITEBACK_LR_CLOSED : LR_WRITEBACK_LR_OPEN}
            </span>
          </div>
        }
        under={
          <div className="text-xs text-text-secondary flex flex-wrap gap-3 items-center">
            <span>
              {LR_WRITEBACK_PENDING} <b>{pendingTotal}</b>
            </span>
            <span>
              {LR_WRITEBACK_WRITTEN} <b>{writtenTotal}</b>
            </span>
            {error ? <span className="text-error">{error}</span> : null}
          </div>
        }
      />
    </div>
  )
}
