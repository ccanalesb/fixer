import { describe, expect, it } from 'vitest'
import { levelHighlightClass } from '../cullHighlight'

describe('levelHighlightClass', () => {
  it('highlights failing answers as warning', () => {
    expect(levelHighlightClass({ fails: true, strong: false })).toContain('text-warning')
  })

  it('highlights strong answers as success', () => {
    expect(levelHighlightClass({ fails: false, strong: true })).toContain('text-success')
  })

  it('leaves other answers plain', () => {
    expect(levelHighlightClass({ fails: false, strong: false })).toBe('')
    expect(levelHighlightClass(undefined)).toBe('')
  })
})
