import { describe, expect, it } from 'vitest'
import { bulkSendButtonLabel, sendButtonLabel } from '../sendLabel'

describe('sendButtonLabel', () => {
  it('returns null when every photo is complete', () => {
    expect(sendButtonLabel(['all', 'all'])).toBeNull()
  })

  it('returns Send to scoring when none have scores', () => {
    expect(sendButtonLabel(['none', 'none'])).toBe('Send to scoring')
  })

  it('returns Send to re-scoring when any has some or all scores', () => {
    expect(sendButtonLabel(['none', 'some'])).toBe('Send to re-scoring')
    expect(sendButtonLabel(['all', 'none'])).toBe('Send to re-scoring')
  })
})

describe('bulkSendButtonLabel', () => {
  it('counts only photos that need work', () => {
    expect(bulkSendButtonLabel(['none', 'none', 'none'])).toBe('Send 3 to scoring')
    expect(bulkSendButtonLabel(['none', 'all'])).toBe('Send 1 to scoring')
  })
})
