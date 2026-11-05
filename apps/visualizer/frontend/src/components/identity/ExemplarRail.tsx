import { useCallback, useEffect, useRef, useState } from 'react'
import { IdentityAPI, type MirrorExemplar } from '../../services/api'
import { thumbnailUrl } from '../../utils/imageUrl'
import { Badge } from '../ui/badges'
import { ScrollContainerLazyImage } from '../ui/ScrollContainerLazyImage'
import { formatStackCountBadge } from '../../constants/strings'

// Fallbacks only; the live values come from the mirror payload's
// `meta.exemplar_page_size` / `meta.exemplar_initial_limit` (see props below)
// so a backend change to the page sizes can't silently diverge from the UI.
const DEFAULT_EXEMPLAR_PAGE_SIZE = 12
const DEFAULT_EXEMPLAR_INITIAL_LIMIT = 24

interface ExemplarRailProps {
  perspectiveSlug: string
  initialItems?: MirrorExemplar[]
  initialTotal: number
  onOpenExemplar: (exemplar: MirrorExemplar, index: number, exemplars: MirrorExemplar[]) => void
  /** From mirror `meta.exemplar_page_size`; falls back to the default. */
  pageSize?: number
  /** From mirror `meta.exemplar_initial_limit`; falls back to the default. */
  initialLimit?: number
}

export function ExemplarRail({
  perspectiveSlug,
  initialItems,
  initialTotal,
  onOpenExemplar,
  pageSize = DEFAULT_EXEMPLAR_PAGE_SIZE,
  initialLimit = DEFAULT_EXEMPLAR_INITIAL_LIMIT,
}: ExemplarRailProps) {
  const [items, setItems] = useState<MirrorExemplar[]>(initialItems ?? [])
  const [total, setTotal] = useState(initialTotal)
  const [loading, setLoading] = useState(initialItems === undefined)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const updateScrollButtons = useCallback(() => {
    const el = railRef.current
    if (!el) return
    const atStart = el.scrollLeft <= 4
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4
    setCanScrollLeft(!atStart)
    setCanScrollRight(!atEnd || items.length < total)
  }, [items.length, total])

  useEffect(() => {
    if (initialItems !== undefined) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void IdentityAPI.getMirrorLensExemplars(perspectiveSlug, {
      offset: 0,
      limit: initialLimit,
    })
      .then((payload) => {
        if (cancelled) return
        setItems(payload.items)
        setTotal(payload.total)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load exemplars')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [initialItems, perspectiveSlug, initialLimit])

  useEffect(() => {
    updateScrollButtons()
    const el = railRef.current
    if (!el) return
    el.addEventListener('scroll', updateScrollButtons, { passive: true })
    return () => el.removeEventListener('scroll', updateScrollButtons)
  }, [items, updateScrollButtons])

  async function loadMore() {
    if (loadingMore || items.length >= total) return
    setLoadingMore(true)
    setError(null)
    try {
      const payload = await IdentityAPI.getMirrorLensExemplars(perspectiveSlug, {
        offset: items.length,
        limit: pageSize,
      })
      setItems((prev) => [...prev, ...payload.items])
      setTotal(payload.total)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load more exemplars')
    } finally {
      setLoadingMore(false)
    }
  }

  function scrollBy(delta: number) {
    railRef.current?.scrollBy({ left: delta, behavior: 'smooth' })
  }

  async function handleNext() {
    const el = railRef.current
    if (!el) return
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4
    if (atEnd && items.length < total) {
      await loadMore()
      requestAnimationFrame(() => {
        el.scrollBy({ left: 160, behavior: 'smooth' })
      })
      return
    }
    scrollBy(320)
  }

  function handlePrev() {
    scrollBy(-320)
  }

  if (loading) {
    return <p className="text-sm italic text-text-tertiary">Loading exemplars…</p>
  }

  if (error) {
    return <p className="text-sm text-warning">{error}</p>
  }

  if (items.length === 0) {
    return <p className="text-sm italic text-text-tertiary">No exemplars yet for this technique.</p>
  }

  return (
    <div className="relative">
      {canScrollLeft ? (
        <button
          type="button"
          aria-label="Scroll exemplars left"
          className="absolute left-0 top-1/2 z-10 -translate-y-1/2 rounded-full border border-border bg-bg/90 px-2 py-3 text-lg text-text shadow-card hover:border-accent/60"
          onClick={handlePrev}
        >
          ‹
        </button>
      ) : null}
      {canScrollRight ? (
        <button
          type="button"
          aria-label={items.length < total ? 'Load more exemplars' : 'Scroll exemplars right'}
          disabled={loadingMore}
          className="absolute right-0 top-1/2 z-10 -translate-y-1/2 rounded-full border border-border bg-bg/90 px-2 py-3 text-lg text-text shadow-card hover:border-accent/60 disabled:opacity-50"
          onClick={() => void handleNext()}
        >
          ›
        </button>
      ) : null}

      <div
        ref={railRef}
        className="flex gap-2.5 overflow-x-auto scroll-smooth pb-2 pl-8 pr-8 snap-x snap-mandatory"
      >
        {items.map((exemplar, index) => {
          const stackCount = exemplar.stack_size ?? 0
          const showStackBadge = exemplar.stack_id != null && stackCount > 1
          return (
            <button
              key={exemplar.image_key}
              type="button"
              className="relative h-[150px] w-[150px] shrink-0 snap-start overflow-hidden rounded-base border border-border bg-bg transition hover:-translate-y-0.5 hover:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent"
              onClick={() => onOpenExemplar(exemplar, index, items)}
            >
              <span className="absolute left-1.5 top-1.5 z-10 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-semibold text-white">
                #{index + 1}
              </span>
              {showStackBadge ? (
                <span className="absolute right-1.5 top-1.5 z-10">
                  <Badge variant="default">{formatStackCountBadge(stackCount)}</Badge>
                </span>
              ) : null}
              <ScrollContainerLazyImage
                scrollContainerRef={railRef}
                src={thumbnailUrl('catalog', exemplar.image_key)}
                alt={`Exemplar ${index + 1}`}
                className="h-full w-full object-cover"
              />
            </button>
          )
        })}
      </div>
    </div>
  )
}
