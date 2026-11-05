import { useCallback, useEffect, useMemo, useState, useTransition, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  CullAPI,
  CullingModelsAPI,
  type CullingModelsUsable,
  type CullingStageKind,
  type CullReviewRow,
} from '../../services/api'
import { keys, useQuery } from '../../data'
import { Button } from '../ui/Button'
import { Pagination } from '../ui/Pagination'
import {
  CULL_AGREE,
  CULL_CLEAR,
  CULL_HEADING,
  CULL_LAST_CHECKED,
  CULL_SELECT_ALL,
  CULL_SORT_HINT,
  CULL_SUB_AUTO,
  CULL_SUB_MANUAL,
  CULL_ALREADY_SCORED,
  CULLING_CHECKING,
  CULLING_OPEN_PROVIDERS,
  CULLING_OPEN_SETTINGS,
  PROCESSING_PROVIDERS_STAGE_ROUTE,
  CULLING_PROFILE_OFF_NOTE,
  CULLING_PROFILE_OFF_SUB,
  CULLING_TURN_OFF,
  PROCESSING_SETTINGS_STAGE_ROUTE,
} from '../../constants/strings'
import { StageFixLink } from './CullingStageDialog'
import { cullingProfileNote, isUnusable, scoreForecastWarning } from './stageUsability'
import { turnStageOff } from './pipelineStageSwitch'
import { useCullingGate } from './useCullingGate'
import { CullReviewRowView } from './CullReviewRow'
import { bulkSendButtonLabel } from './sendLabel'
import { ImageDetailModal, modalPropsFor, useListNav } from '../image-view'

const LIMIT = 50
type TabId = 'all' | 'culling_profile' | 'score_forecast'

const SETTINGS_LINK =
  'inline-flex items-center rounded-base border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-hover'

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function PageNote({
  text,
  sub,
  actions,
  error,
}: {
  text: string
  sub?: string
  actions?: ReactNode
  error?: string | null
}) {
  return (
    <div className="py-12 text-center">
      <p className="text-sm text-text-secondary">{text}</p>
      {sub && <p className="mt-1 text-xs text-text-tertiary">{sub}</p>}
      {actions && <div className="mt-3 flex flex-wrap justify-center gap-2">{actions}</div>}
      {error && (
        <p className="mt-2 text-sm text-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** The list of filtered photos, unless the culling profile is off or cannot run. */
export function CullReviewTab() {
  const [usable, setUsable] = useState<CullingModelsUsable | 'unknown' | null>(null)
  const [turningOff, setTurningOff] = useState(false)
  const [turnOffError, setTurnOffError] = useState<string | null>(null)

  const load = useCallback(() => {
    CullingModelsAPI.usable().then(setUsable, () => setUsable('unknown'))
  }, [])
  useEffect(load, [load])

  const turnOff = async (stage: CullingStageKind) => {
    setTurningOff(true)
    setTurnOffError(null)
    try {
      await turnStageOff(stage)
      load()
    } catch (e) {
      setTurnOffError(errorText(e))
    } finally {
      setTurningOff(false)
    }
  }
  const turnOffButton = (stage: CullingStageKind) => (
    <Button type="button" variant="ghost" size="sm" disabled={turningOff} onClick={() => void turnOff(stage)}>
      {CULLING_TURN_OFF[stage]}
    </Button>
  )
  const settingsLink = (stage: CullingStageKind) => (
    <Link to={PROCESSING_SETTINGS_STAGE_ROUTE(stage)} className={SETTINGS_LINK}>
      {CULLING_OPEN_SETTINGS}
    </Link>
  )
  const providersLink = (stage: CullingStageKind) => (
    <Link to={PROCESSING_PROVIDERS_STAGE_ROUTE(stage)} className={SETTINGS_LINK}>
      {CULLING_OPEN_PROVIDERS}
    </Link>
  )

  if (usable === null) return <PageNote text={CULLING_CHECKING} />
  if (usable === 'unknown') return <CullReviewList onStageOff={load} />

  const profile = usable.culling_profile
  if (!profile.on) {
    return <PageNote text={CULLING_PROFILE_OFF_NOTE} sub={CULLING_PROFILE_OFF_SUB} actions={settingsLink('culling_profile')} />
  }
  if (isUnusable(profile)) {
    const { text, sub } = cullingProfileNote(profile)
    const actions =
      profile.problem === 'converting' ? (
        <StageFixLink stage="culling_profile" usable={usable} />
      ) : profile.problem === 'no_questions' ? (
        <>
          <StageFixLink stage="culling_profile" usable={usable} />
          {turnOffButton('culling_profile')}
        </>
      ) : (
        <>
          {providersLink('culling_profile')}
          {turnOffButton('culling_profile')}
        </>
      )
    return <PageNote text={text} sub={sub} actions={actions} error={turnOffError} />
  }

  const forecast = usable.score_forecast
  return (
    <div className="space-y-4">
      {isUnusable(forecast) && (
        <div role="alert" className="rounded-base border border-warning/30 bg-warning/5 px-4 py-3 text-sm">
          <div className="font-semibold text-text">{scoreForecastWarning(forecast)}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {forecast.problem === 'no_questions' ? (
              settingsLink('score_forecast')
            ) : forecast.problem === 'converting' ? (
              <StageFixLink stage="score_forecast" usable={usable} />
            ) : (
              providersLink('score_forecast')
            )}
            {turnOffButton('score_forecast')}
          </div>
          {turnOffError && <p className="mt-2 text-sm text-error">{turnOffError}</p>}
        </div>
      )}
      <CullReviewList onStageOff={load} />
    </div>
  )
}

function CullReviewList({ onStageOff }: { onStageOff: () => void }) {
  const { run: runCullingGate, dialog: cullingDialog } = useCullingGate({ onStageOff })
  const [tab, setTab] = useState<TabId>('all')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [actionError, setActionError] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const summary = useQuery(keys.cull.summary(), () => CullAPI.summary())
  const list = useQuery(
    keys.cull.photos(tab, page),
    () => CullAPI.listPhotos({ tab, limit: LIMIT, offset: (page - 1) * LIMIT }),
  )

  const rows = useMemo(() => list?.data ?? [], [list])
  const total = list?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / LIMIT))
  const listNav = useListNav(rows.map((r) => r.image_key))
  const tabCounts = summary.tab_counts ?? { all: 0, culling_profile: 0, score_forecast: 0 }

  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(r.image_key)),
    [rows, selected],
  )
  const sendLabel = bulkSendButtonLabel(selectedRows)
  const completeCount = selectedRows.filter((r) => r.completion === 'all').length

  const toggleAll = () => {
    if (selected.size === rows.length) setSelected(new Set())
    else setSelected(new Set(rows.map((r) => r.image_key)))
  }

  const sendSelected = async () => {
    const keys = selectedRows.filter((r) => r.needs_send_work).map((r) => r.image_key)
    if (keys.length === 0) return
    setActionError(null)
    const result = await runCullingGate('send', () => CullAPI.sendPhotos(keys))
    if (result.status === 'started') {
      setSelected(new Set())
    } else if (result.status === 'failed') {
      setActionError(errorText(result.error))
    }
  }

  const agreeSelected = async () => {
    setActionError(null)
    try {
      await Promise.all([...selected].map((key) => CullAPI.recordAction(key, 'agrees_with_filter')))
      setSelected(new Set())
    } catch (e) {
      setActionError(errorText(e))
    }
  }

  const tabs: { id: TabId; label: string }[] = [
    { id: 'all', label: `All (${tabCounts.all})` },
    { id: 'culling_profile', label: `Culling profile (${tabCounts.culling_profile})` },
    { id: 'score_forecast', label: `Score forecast (${tabCounts.score_forecast})` },
  ]

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{CULL_HEADING(summary.not_passed_count ?? 0)}</h2>
        <p className="text-sm text-text-secondary">
          {CULL_SUB_AUTO}
          {(summary.sent_manually_count ?? 0) > 0 && (
            <> {CULL_SUB_MANUAL(summary.sent_manually_count ?? 0)}</>
          )}
        </p>
        {summary.last_checked_at && (
          <p className="text-xs text-text-tertiary mt-1">
            {CULL_LAST_CHECKED}{' '}
            {new Date(summary.last_checked_at).toLocaleString()}
          </p>
        )}
        <p className="text-xs text-text-tertiary mt-1">{CULL_SORT_HINT}</p>
      </div>

      <div className="flex gap-1 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === t.id ? 'border-accent text-accent' : 'border-transparent text-text-secondary'
            }`}
            onClick={() => startTransition(() => { setTab(t.id); setPage(1); setSelected(new Set()) })}
          >
            {t.label}
          </button>
        ))}
      </div>

      <button type="button" className="text-sm text-accent" onClick={toggleAll}>
        {CULL_SELECT_ALL(rows.length)}
      </button>

      <div className="border border-border rounded-base overflow-hidden">
        {rows.map((row: CullReviewRow) => (
          <CullReviewRowView
            key={row.image_key}
            row={row}
            checked={selected.has(row.image_key)}
            onCheck={(on) => {
              setSelected((prev) => {
                const next = new Set(prev)
                if (on) next.add(row.image_key)
                else next.delete(row.image_key)
                return next
              })
            }}
            onOpen={() => listNav.open(row.image_key)}
          />
        ))}
      </div>

      <Pagination
        currentPage={page}
        totalPages={totalPages}
        onPageChange={(p) => startTransition(() => setPage(p))}
      />

      {listNav.openKey ? (
        <ImageDetailModal
          imageKey={listNav.openKey}
          {...modalPropsFor('culling')}
          nav={listNav.nav}
          onClose={listNav.close}
        />
      ) : null}

      {selected.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 border-t border-border bg-bg p-4 flex flex-wrap gap-2 items-center justify-center shadow-lg z-30">
          {actionError && (
            <p className="w-full text-center text-sm text-error" role="alert">
              {actionError}
            </p>
          )}
          {sendLabel && (
            <Button type="button" variant="primary" size="sm" onClick={() => void sendSelected()}>
              {sendLabel}
            </Button>
          )}
          <Button type="button" variant="secondary" size="sm" onClick={() => void agreeSelected()}>
            {CULL_AGREE}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => setSelected(new Set())}>
            {CULL_CLEAR}
          </Button>
          {completeCount > 0 && (
            <span className="text-sm text-text-secondary">{CULL_ALREADY_SCORED(completeCount)}</span>
          )}
        </div>
      )}
      {cullingDialog}
    </div>
  )
}
