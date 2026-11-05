import { useState } from 'react'
import { AsyncThumbnail } from '../ui/AsyncThumbnail'
import { Button } from '../ui/Button/Button'
import { Card, CardContent } from '../ui/Card'
import { EmptyState } from '../ui/page-states'
import {
  STACK_SUGGESTIONS_ACCEPT,
  STACK_SUGGESTIONS_EMPTY,
  STACK_SUGGESTIONS_REJECT,
  STACK_SUGGESTIONS_TIME_GAP_SECONDS,
  msgShowingOf,
} from '../../constants/strings'
import { ErrorState, keys, useQuery } from '../../data'
import { ImagesAPI, type StackSuggestion } from '../../services/api'

type StackSuggestionsListProps = {
  items: StackSuggestion[]
  total: number
  busyKey: string | null
  onAccept: (item: StackSuggestion) => void
  onReject: (item: StackSuggestion) => void
}

function pairKey(item: StackSuggestion): string {
  return `${item.image_a.key}::${item.image_b.key}`
}

export function StackSuggestionsList({
  items,
  total,
  busyKey,
  onAccept,
  onReject,
}: StackSuggestionsListProps) {
  if (items.length === 0) {
    return <EmptyState message={STACK_SUGGESTIONS_EMPTY} />
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">{msgShowingOf(items.length, total, 'suggestions')}</p>
      {items.map((item) => {
        const key = pairKey(item)
        const busy = busyKey === key
        const gap =
          item.time_gap_seconds != null
            ? STACK_SUGGESTIONS_TIME_GAP_SECONDS(item.time_gap_seconds)
            : null
        return (
          <Card key={`${item.group_id}-${key}`} padding="md">
            <CardContent>
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="flex items-center gap-3">
                    <AsyncThumbnail
                      src={item.image_a.thumbnail_url ?? ''}
                      alt={item.image_a.filename ?? item.image_a.key}
                      className="h-24 w-24 rounded-md object-cover"
                    />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-text">
                        {item.image_a.filename ?? item.image_a.key}
                      </p>
                      <p className="text-xs text-text-secondary">{item.image_a.date_taken ?? 'No date'}</p>
                    </div>
                  </div>
                  <div className="text-sm text-text-secondary sm:px-2">↔</div>
                  <div className="flex items-center gap-3">
                    <AsyncThumbnail
                      src={item.image_b.thumbnail_url ?? ''}
                      alt={item.image_b.filename ?? item.image_b.key}
                      className="h-24 w-24 rounded-md object-cover"
                    />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-text">
                        {item.image_b.filename ?? item.image_b.key}
                      </p>
                      <p className="text-xs text-text-secondary">{item.image_b.date_taken ?? 'No date'}</p>
                    </div>
                  </div>
                </div>
                <div className="flex flex-col items-start gap-2 lg:items-end">
                  <p className="text-sm text-text-secondary">
                    {item.why_matched}
                    {gap ? ` · ${gap}` : ''}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy}
                      onClick={() => onAccept(item)}
                    >
                      {STACK_SUGGESTIONS_ACCEPT}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => onReject(item)}
                    >
                      {STACK_SUGGESTIONS_REJECT}
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

export function StackSuggestionsPanel() {
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [actionError, setActionError] = useState<Error | null>(null)
  const suggestions = useQuery(keys.stacks.suggestions(), () =>
    ImagesAPI.listStackSuggestions({ limit: 50, offset: 0 }),
  )

  const handleAccept = async (item: StackSuggestion) => {
    const key = pairKey(item)
    setBusyKey(key)
    setActionError(null)
    try {
      await ImagesAPI.acceptStackSuggestion(item.image_a.key, item.image_b.key)
    } catch (e) {
      setActionError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      setBusyKey(null)
    }
  }

  const handleReject = async (item: StackSuggestion) => {
    const key = pairKey(item)
    setBusyKey(key)
    setActionError(null)
    try {
      await ImagesAPI.rejectStackSuggestion(item.image_a.key, item.image_b.key)
    } catch (e) {
      setActionError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      setBusyKey(null)
    }
  }

  const items = suggestions.items ?? []
  const total = suggestions.total ?? 0

  return (
    <div className="space-y-4">
      {actionError ? <ErrorState error={actionError} reset={() => setActionError(null)} /> : null}
      <StackSuggestionsList
        items={items}
        total={total}
        busyKey={busyKey}
        onAccept={handleAccept}
        onReject={handleReject}
      />
    </div>
  )
}
