import type { CatalogKind } from '../types/config'

/** The Lightroom value, or the folder one on a folder catalog; works for a single string or a copy record. */
export function forCatalogKind<T>(
  kind: CatalogKind | null | undefined,
  lightroom: T,
  folder: T,
): T {
  return kind === 'folder' ? folder : lightroom
}
