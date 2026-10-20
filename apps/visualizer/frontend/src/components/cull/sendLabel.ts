export type SendCompletion = 'none' | 'some' | 'all'

export type SendLabelRow = { completion: SendCompletion; needs_send_work: boolean }

/** Single-row send label from server `needs_send_work` + completion (F15). */
export function rowSendButtonLabel(row: SendLabelRow): string | null {
  if (!row.needs_send_work) return null
  const anyScored = row.completion === 'some' || row.completion === 'all'
  return anyScored ? 'Send to re-scoring' : 'Send to scoring'
}

/** Bulk send label — only rows the server marked as having send work. */
export function bulkSendButtonLabel(rows: readonly SendLabelRow[]): string | null {
  const sendable = rows.filter((r) => r.needs_send_work)
  if (sendable.length === 0) return null
  const anyScored = sendable.some((r) => r.completion === 'some' || r.completion === 'all')
  const base = anyScored ? 'Send to re-scoring' : 'Send to scoring'
  const verb = base.replace('Send to ', '')
  return `Send ${sendable.length} to ${verb}`
}

/** @deprecated Prefer {@link rowSendButtonLabel} with `needs_send_work`. */
export function sendButtonLabel(completions: readonly SendCompletion[]): string | null {
  if (completions.length === 0) return null
  const anyScored = completions.some((c) => c === 'some' || c === 'all')
  if (completions.every((c) => c === 'all')) return null
  return anyScored ? 'Send to re-scoring' : 'Send to scoring'
}
