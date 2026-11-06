import { describe, expect, it } from 'vitest'
import { isCatalogPick, isCatalogRejected } from '../catalogPick'

describe('catalogPick', () => {
  it('reads -1 as a reject and 1 as a pick', () => {
    expect(isCatalogRejected(-1)).toBe(true)
    expect(isCatalogPick(-1)).toBe(false)
    expect(isCatalogPick(1)).toBe(true)
    expect(isCatalogRejected(1)).toBe(false)
  })

  it('reads 0 and a missing value as neither', () => {
    for (const pick of [0, null, undefined] as const) {
      expect(isCatalogPick(pick)).toBe(false)
      expect(isCatalogRejected(pick)).toBe(false)
    }
  })
})
