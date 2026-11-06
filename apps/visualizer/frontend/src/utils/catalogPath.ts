import type { CatalogKind } from '../types/config'

export const LRCAT_EXTENSION = '.lrcat'

/** A path ending in `.lrcat`, any case, is a Lightroom catalog; any other path is a folder. */
export function catalogKindOfPath(path: string): CatalogKind {
  return path.trim().toLowerCase().endsWith(LRCAT_EXTENSION) ? 'lightroom' : 'folder'
}
