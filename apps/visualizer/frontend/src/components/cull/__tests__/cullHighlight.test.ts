import { describe, expect, it } from 'vitest'
import { failingLevelClass } from '../cullHighlight'

describe('failingLevelClass', () => {
  it('highlights failing bands', () => {
    expect(failingLevelClass(true)).toContain('warning')
    expect(failingLevelClass(false)).toBe('')
  })
})
