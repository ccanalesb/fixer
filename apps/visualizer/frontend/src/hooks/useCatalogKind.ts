import { useQuery, keys } from '../data'
import { ConfigAPI } from '../services/api'
import type { ConfigCatalogGetResponse } from '../types/config'

type UseCatalogKindOptions = {
  /** When true, suspend until the catalog config loads instead of assuming Lightroom. */
  pendingAsNull?: boolean
}

/**
 * Catalog kind for copy that names Lightroom.
 */
export function useCatalogKind(options?: UseCatalogKindOptions): 'lightroom' | 'folder' | null {
  const cfg = useQuery(keys.config.catalog(), () => ConfigAPI.getCatalog(), {
    ...(options?.pendingAsNull
      ? {}
      : { initialValue: { catalog_kind: 'lightroom' } as ConfigCatalogGetResponse }),
  })
  if (options?.pendingAsNull) {
    return cfg.catalog_kind ?? null
  }
  return cfg.catalog_kind ?? 'lightroom'
}
