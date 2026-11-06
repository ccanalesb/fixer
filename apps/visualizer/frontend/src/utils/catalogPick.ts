import type { components } from '../types/api.gen'

type CatalogPick = components['schemas']['CatalogPick'] | undefined

/** The catalog's pick flag: 1 = pick, -1 = reject, 0 = neither. */
export function isCatalogRejected(pick: CatalogPick): boolean {
  return pick === -1
}

export function isCatalogPick(pick: CatalogPick): boolean {
  return pick === 1
}
