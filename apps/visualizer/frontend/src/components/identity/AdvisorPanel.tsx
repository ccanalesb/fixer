import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  IdentityAPI,
  type PostNextCandidate,
} from '../../services/api'
import { useQuery } from '../../data'
import { keys } from '../../data/keys'
import { ImageDetailModal, modalPropsFor } from '../image-view'
import { Button } from '../ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card'
import {
  IDENTITY_ACTION_OPEN_CATALOG,
  IDENTITY_ADVISOR_EMPTY_FALLBACK,
  IDENTITY_ADVISOR_HELP,
  IDENTITY_INTRO_ADVISOR,
  IDENTITY_REASON_CODE_LABELS,
  IDENTITY_SECTION_ADVISOR,
  IDENTITY_SIGNATURE_LABEL,
  FILTER_LABEL_SORT_DATE,
  FILTER_SORT_DATE_NEWEST,
  FILTER_SORT_DATE_OLDEST,
  FILTER_SORT_DATE_NONE,
  msgShowingOf,
} from '../../constants/strings'
import { FilterBar } from '../filters/FilterBar'
import { useFilters } from '../../hooks/useFilters'
import type { FilterSchema } from '../filters/types'

const SUGGESTIONS_LIMIT = 20

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

function labelForReasonCode(code: string): string {
  return IDENTITY_REASON_CODE_LABELS[code] ?? code.replace(/_/g, ' ')
}

function formatPeakPercentile(peak: number): string {
  return `${(peak * 100).toFixed(1)}%`
}

function peakLensLabel(row: PostNextCandidate): string {
  const name = row.peak_perspective_display_name || row.peak_perspective_slug
  if (!name) return '—'
  return row.is_signature ? `${name} (${IDENTITY_SIGNATURE_LABEL})` : name
}

export function AdvisorPanel() {
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const [extra, setExtra] = useState<{ sortKey: string; rows: PostNextCandidate[] }>({
    sortKey: '',
    rows: [],
  })
  const [selected, setSelected] = useState<PostNextCandidate | null>(null)

  const postNextSchema = useMemo<FilterSchema>(
    () => [
      {
        type: 'select',
        key: 'sortByDate',
        label: FILTER_LABEL_SORT_DATE,
        paramName: 'sort_by_date',
        defaultValue: 'none',
        options: [
          { value: 'none', label: FILTER_SORT_DATE_NONE },
          { value: 'newest', label: FILTER_SORT_DATE_NEWEST },
          { value: 'oldest', label: FILTER_SORT_DATE_OLDEST },
        ],
        toParam: (v) => (v === 'none' || v === '' || v === undefined ? undefined : v),
      },
    ],
    [],
  )
  const filters = useFilters(postNextSchema)
  const sortByDate = filters.values.sortByDate as string | undefined
  const sortParam =
    sortByDate && sortByDate !== 'none'
      ? (sortByDate as 'newest' | 'oldest')
      : undefined

  const sortKey = sortParam ?? 'none'
  const initial = useQuery(
    keys.identity.postNext(sortParam ?? null),
    () =>
      IdentityAPI.getSuggestions({
        limit: SUGGESTIONS_LIMIT,
        offset: 0,
        sort_by_date: sortParam,
      }),
  )

  useEffect(() => {
    setExtra({ sortKey, rows: [] })
    setLoadMoreError(null)
  }, [sortKey])

  const appended = extra.sortKey === sortKey ? extra.rows : []
  const rows = [...initial.candidates, ...appended]
  const total = initial.total
  const emptyState = initial.empty_state

  const handleLoadMore = () => {
    if (loadingMore || rows.length >= total) return
    setLoadingMore(true)
    setLoadMoreError(null)
    IdentityAPI.getSuggestions({
      limit: SUGGESTIONS_LIMIT,
      offset: rows.length,
      sort_by_date: sortParam,
    })
      .then((res) => {
        setExtra((prev) => {
          if (prev.sortKey !== sortKey) return prev
          const merged = [...initial.candidates, ...prev.rows]
          const seen = new Set(merged.map((r) => r.image_key))
          const more = res.candidates.filter((c) => !seen.has(c.image_key))
          return { sortKey, rows: [...prev.rows, ...more] }
        })
      })
      .catch((e) => {
        setLoadMoreError(errMessage(e))
      })
      .finally(() => {
        setLoadingMore(false)
      })
  }

  const emptyMessage = rows.length === 0 ? emptyState ?? IDENTITY_ADVISOR_EMPTY_FALLBACK : null

  return (
    <section className="space-y-3" aria-labelledby="identity-advisor-heading">
      <h2 id="identity-advisor-heading" className="text-card-title text-text">
        {IDENTITY_SECTION_ADVISOR}
      </h2>
      <p className="text-sm text-text-secondary">{IDENTITY_INTRO_ADVISOR}</p>
      <Card padding="md">
        <CardHeader>
          <CardTitle className="text-base sr-only">{IDENTITY_SECTION_ADVISOR}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 !text-text">
          <p className="text-sm text-text-secondary">{IDENTITY_ADVISOR_HELP}</p>
          <FilterBar
            schema={postNextSchema}
            filters={filters}
            summary={
              rows.length > 0 ? (
                <p className="text-sm text-text-secondary">
                  {msgShowingOf(rows.length, total, 'suggestions')}
                </p>
              ) : null
            }
            disabled={false}
          />

          {loadMoreError ? (
            <p className="text-sm text-error" role="alert">
              {loadMoreError}
            </p>
          ) : null}

          {emptyMessage ? (
            <p className="text-sm text-text-secondary" role="status">
              {emptyMessage}
            </p>
          ) : null}

          {rows.length > 0 ? (
            <>
              <ol className="space-y-4">
                {rows.map((row, i) => {
                  const dateDisplay = row.date_taken
                    ? new Date(row.date_taken).toLocaleDateString()
                    : '—'
                  return (
                    <li
                      key={row.image_key}
                      className="flex flex-col gap-3 rounded-card border border-border bg-bg p-3 sm:flex-row sm:items-start"
                    >
                      <button
                        type="button"
                        onClick={() => setSelected(row)}
                        className="mx-auto shrink-0 focus:outline-none focus:ring-2 focus:ring-accent sm:mx-0"
                      >
                        <img
                          src={`/api/images/catalog/${encodeURIComponent(row.image_key)}/thumbnail`}
                          alt={row.filename}
                          className="h-28 w-28 rounded-base border border-border object-cover"
                          loading="lazy"
                        />
                      </button>
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="text-xs font-medium text-text-tertiary">#{i + 1}</span>
                          <p className="truncate font-medium text-text">{row.filename}</p>
                          <span className="text-sm font-semibold text-accent">
                            {formatPeakPercentile(row.peak_percentile)}
                          </span>
                          <span className="text-xs text-text-tertiary">{dateDisplay}</span>
                        </div>
                        <p className="text-sm text-text-secondary">
                          Peak lens: <span className="text-text">{peakLensLabel(row)}</span>
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {row.reason_codes.map((code, ci) => (
                            <span
                              key={`${code}-${ci}`}
                              className="rounded-full border border-border bg-surface px-2 py-0.5 text-xs text-text-secondary"
                            >
                              {labelForReasonCode(code)}
                            </span>
                          ))}
                        </div>
                        <ul className="list-inside list-disc space-y-1 text-sm text-text-secondary">
                          {row.reasons.map((r, j) => (
                            <li key={j}>{r}</li>
                          ))}
                        </ul>
                        <Link
                          to={`/images?tab=catalog&image_key=${encodeURIComponent(row.image_key)}`}
                          className="inline-block text-sm font-medium text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent rounded-sm"
                        >
                          {IDENTITY_ACTION_OPEN_CATALOG}
                        </Link>
                      </div>
                    </li>
                  )
                })}
              </ol>
              {total !== null && rows.length < total ? (
                <div className="flex justify-center pt-2">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={loadingMore}
                    onClick={handleLoadMore}
                  >
                    Load more
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
        </CardContent>
      </Card>

      {selected ? (
        <ImageDetailModal
          imageKey={selected.image_key}
          {...modalPropsFor('identity')}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </section>
  )
}
