import { useMemo, useState, useTransition } from 'react'
import { CullAPI, type CullReviewRow } from '../../services/api'
import { useQuery, invalidateAll } from '../../data'
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
} from '../../constants/strings'
import { CullReviewRowView } from './CullReviewRow'
import { bulkSendButtonLabel } from './sendLabel'
import { ImageDetailModal } from '../image-view/ImageDetailModal'

const LIMIT = 50
type TabId = 'all' | 'culling_recipe' | 'score_forecast'

export function CullReviewTab() {
  const [tab, setTab] = useState<TabId>('all')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [modalIndex, setModalIndex] = useState<number | null>(null)
  const [, startTransition] = useTransition()

  const summary = useQuery(['cull.summary'] as const, () => CullAPI.summary())
  const list = useQuery(
    ['cull.photos', tab, page] as const,
    () => CullAPI.listPhotos({ tab, limit: LIMIT, offset: (page - 1) * LIMIT }),
  )

  const rows = useMemo(() => list?.data ?? [], [list])
  const total = list?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / LIMIT))
  const tabCounts = summary.tab_counts ?? { all: 0, culling_recipe: 0, score_forecast: 0 }

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
    await CullAPI.sendPhotos(keys)
    setSelected(new Set())
    invalidateAll(['cull.summary', 'cull.photos'])
  }

  const agreeSelected = async () => {
    await Promise.all([...selected].map((key) => CullAPI.recordAction(key, 'agrees_with_cut')))
    setSelected(new Set())
    invalidateAll(['cull.summary', 'cull.photos'])
  }

  const tabs: { id: TabId; label: string }[] = [
    { id: 'all', label: `All (${tabCounts.all})` },
    { id: 'culling_recipe', label: `Culling recipe (${tabCounts.culling_recipe})` },
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
        {rows.map((row: CullReviewRow, idx) => (
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
            onOpen={() => setModalIndex(idx)}
          />
        ))}
      </div>

      <Pagination
        currentPage={page}
        totalPages={totalPages}
        onPageChange={(p) => startTransition(() => setPage(p))}
      />

      {modalIndex !== null && rows[modalIndex] ? (
        <ImageDetailModal
          imageType="catalog"
          imageKey={rows[modalIndex]!.image_key}
          primaryScoreSource="catalog"
          showCullSection
          cullNav={{
            keys: rows.map((r) => r.image_key),
            index: modalIndex,
            onIndexChange: setModalIndex,
          }}
          onClose={() => setModalIndex(null)}
        />
      ) : null}

      {selected.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 border-t border-border bg-bg p-4 flex flex-wrap gap-2 items-center justify-center shadow-lg z-30">
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
    </div>
  )
}
