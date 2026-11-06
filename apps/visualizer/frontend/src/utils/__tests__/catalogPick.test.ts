import { describe, expect, it } from 'vitest'
import { isCatalogPick, isCatalogRejected } from '../catalogPick'

describe('catalogPick', () => {
  it('treats -1 as rejected and 1 as pick', () => {
    expect(isCatalogRejected(-1)).toBe(true)
    expect(isCatalogPick(-1)).toBe(false)
    expect(isCatalogPick(1)).toBe(true)
    expect(isCatalogPick(true)).toBe(true)
    expect(isCatalogRejected(true)).toBe(false)
  })
})
