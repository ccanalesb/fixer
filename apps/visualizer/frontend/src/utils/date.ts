type DateInput = string | null | undefined

export function formatDateTime(value: DateInput): string {
  if (!value) return ''
  return new Date(value).toLocaleString()
}

export function formatDate(value: DateInput): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString()
}

export function formatTime(value: DateInput): string {
  if (!value) return ''
  return new Date(value).toLocaleTimeString()
}

export function formatMonth(yyyymm: string): string {
  if (yyyymm.length !== 6) return yyyymm
  const year = parseInt(yyyymm.substring(0, 4), 10)
  const month = parseInt(yyyymm.substring(4, 6), 10) - 1
  return new Date(year, month).toLocaleDateString('en-US', { year: 'numeric', month: 'long' })
}

/** Coarse "X ago" string for compact UI badges.
 *
 * Anything ≥ 30 days collapses to ``formatDate`` so we don't fight the user's
 * locale on long-tail values. ``now`` is injected for tests.
 */
export function formatTimeAgo(value: DateInput, now: Date = new Date()): string {
  if (!value) return ''
  const then = new Date(value)
  if (Number.isNaN(then.getTime())) return ''
  const diffMs = now.getTime() - then.getTime()
  if (diffMs < 0) return 'just now'
  const sec = Math.floor(diffMs / 1000)
  if (sec < 45) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`
  return formatDate(value)
}
