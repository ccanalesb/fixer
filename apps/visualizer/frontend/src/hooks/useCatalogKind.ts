import { useQuery } from '../data'
import { ConfigAPI } from '../services/api'
import type { ConfigCatalogGetResponse } from '../types/config'

/**
 * Catalog kind for copy that names Lightroom. Seeded with `lightroom` so a
 * component picking its wording never suspends on this non-critical detail.
 */
export function useCatalogKind(): 'lightroom' | 'folder' {
  const cfg = useQuery(['config', 'catalog'] as const, () => ConfigAPI.getCatalog(), {
    initialValue: { catalog_kind: 'lightroom' } as ConfigCatalogGetResponse,
  })
  return cfg.catalog_kind ?? 'lightroom'
}
