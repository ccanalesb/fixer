import { describe, expect, it } from 'vitest'
import { CULL_HEADING } from '../../../constants/strings'
import { bulkSendButtonLabel, rowSendButtonLabel, sendButtonLabel } from '../sendLabel'

describe('CULL_HEADING', () => {
  it('uses singular copy for one photo', () => {
    expect(CULL_HEADING(1)).toBe('1 photo did not pass the cull')
    expect(CULL_HEADING(2)).toContain('2 photos')
  })
})

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

describe('rowSendButtonLabel', () => {
  it('respects needs_send_work from the server', () => {
    expect(rowSendButtonLabel({ completion: 'all', needs_send_work: false })).toBeNull()
    expect(rowSendButtonLabel({ completion: 'all', needs_send_work: true })).toBe('Send to re-scoring')
    expect(rowSendButtonLabel({ completion: 'none', needs_send_work: true })).toBe('Send to scoring')
  })
})

describe('bulkSendButtonLabel', () => {
  it('counts only photos that need send work', () => {
    expect(
      bulkSendButtonLabel([
        { completion: 'none', needs_send_work: true },
        { completion: 'none', needs_send_work: true },
        { completion: 'none', needs_send_work: true },
      ]),
    ).toBe('Send 3 to scoring')
    expect(
      bulkSendButtonLabel([
        { completion: 'none', needs_send_work: true },
        { completion: 'all', needs_send_work: false },
      ]),
    ).toBe('Send 1 to scoring')
    expect(
      bulkSendButtonLabel([{ completion: 'all', needs_send_work: false }]),
    ).toBeNull()
  })
})
