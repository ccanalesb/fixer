export type SendCompletion = 'none' | 'some' | 'all'

/** Bulk / single send button label (F15: re-scoring if any scored). */
export function sendButtonLabel(completions: readonly SendCompletion[]): string | null {
  if (completions.length === 0) return null
  const anyScored = completions.some((c) => c === 'some' || c === 'all')
  if (completions.every((c) => c === 'all')) return null
  return anyScored ? 'Send to re-scoring' : 'Send to scoring'
}

export function bulkSendButtonLabel(completions: readonly SendCompletion[]): string | null {
  const sendable = completions.filter((c) => c !== 'all')
  const base = sendButtonLabel(sendable)
  if (!base) return null
  const verb = base.replace('Send to ', '')
  return `Send ${sendable.length} to ${verb}`
}
