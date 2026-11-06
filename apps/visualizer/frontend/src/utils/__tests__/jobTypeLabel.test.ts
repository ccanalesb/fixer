import { describe, expect, it } from 'vitest'
import { jobTypeLabel } from '../jobTypeLabel'

describe('jobTypeLabel', () => {
  it('names the write-back job without naming Lightroom, so it reads true for a folder catalog', () => {
    expect(jobTypeLabel('lr_writeback')).toBe('Write-back')
  })

  it('falls back to the raw type for an unknown job', () => {
    expect(jobTypeLabel('something_new')).toBe('something_new')
  })
})
