/** Catalog list/detail `pick`: 1 = pick, -1 = reject, 0 = neither (API may send numbers despite boolean schema). */
export function isCatalogRejected(pick: unknown): boolean {
  return pick === -1 || pick === '-1'
}

export function isCatalogPick(pick: unknown): boolean {
  if (isCatalogRejected(pick)) return false
  return pick === 1 || pick === true
}
