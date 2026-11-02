import { useEffect, useState } from 'react'

interface PaginationProps {
  currentPage: number
  totalPages: number
  onPageChange: (page: number) => void
  disabled?: boolean
}

export function Pagination({ currentPage, totalPages, onPageChange, disabled }: PaginationProps) {
  if (totalPages <= 1) return null

  const pages = Array.from({ length: totalPages }, (_, i) => i + 1)

  // Show max 7 pages: [1] ... [n-1] [n] [n+1] ... [total]
  let visiblePages = pages
  if (totalPages > 7) {
    if (currentPage <= 3) {
      visiblePages = [...pages.slice(0, 5), -1, totalPages]
    } else if (currentPage >= totalPages - 2) {
      visiblePages = [1, -1, ...pages.slice(totalPages - 5)]
    } else {
      visiblePages = [1, -1, currentPage - 1, currentPage, currentPage + 1, -1, totalPages]
    }
  }

  return (
    <div className="flex w-full items-center gap-2 sm:w-auto">
      <button
        type="button"
        onClick={() => onPageChange(currentPage - 1)}
        disabled={currentPage === 1 || disabled}
        className="px-3 py-2 rounded-base border border-border bg-bg text-text-secondary hover:bg-surface hover:text-text disabled:opacity-50 disabled:cursor-not-allowed transition-all"
        aria-label="Previous page"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      <div className="hidden items-center gap-2 sm:flex">
        {visiblePages.map((page, index) =>
          page === -1 ? (
            <span key={`ellipsis-${index}`} className="px-3 py-2 text-text-tertiary">
              ...
            </span>
          ) : (
            <button
              type="button"
              key={page}
              onClick={() => onPageChange(page)}
              disabled={disabled}
              className={`px-3 py-2 rounded-base border transition-all ${
                page === currentPage
                  ? 'bg-accent-light text-accent border-accent font-medium'
                  : 'border-border bg-bg text-text-secondary hover:bg-surface hover:text-text'
              }`}
            >
              {page}
            </button>
          )
        )}
      </div>

      <PageField
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={onPageChange}
        disabled={disabled}
      />

      <button
        type="button"
        onClick={() => onPageChange(currentPage + 1)}
        disabled={currentPage === totalPages || disabled}
        className="px-3 py-2 rounded-base border border-border bg-bg text-text-secondary hover:bg-surface hover:text-text disabled:opacity-50 disabled:cursor-not-allowed transition-all"
        aria-label="Next page"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  )
}

/** Phone-width stand-in for the page buttons: type a page and press Enter to jump there. */
function PageField({ currentPage, totalPages, onPageChange, disabled }: PaginationProps) {
  const [draft, setDraft] = useState(String(currentPage))
  useEffect(() => setDraft(String(currentPage)), [currentPage])

  const jump = () => {
    const page = Number.parseInt(draft, 10)
    if (Number.isNaN(page)) return setDraft(String(currentPage))
    const target = Math.min(totalPages, Math.max(1, page))
    setDraft(String(target))
    if (target !== currentPage) onPageChange(target)
  }

  return (
    <label className="flex flex-1 items-center justify-center gap-2 text-sm text-text-secondary sm:hidden">
      Page
      <input
        type="text"
        inputMode="numeric"
        aria-label="Go to page"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') jump()
        }}
        onBlur={() => setDraft(String(currentPage))}
        className="w-16 rounded-base border border-border bg-bg px-2 py-2 text-center text-text disabled:opacity-50"
      />
      of {totalPages}
    </label>
  )
}
