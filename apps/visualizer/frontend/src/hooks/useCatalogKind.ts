import { useQuery } from '../data'
import { ConfigAPI } from '../services/api'

export function useCatalogKind(): 'lightroom' | 'folder' {
  const cfg = useQuery(['config', 'catalog'] as const, () => ConfigAPI.getCatalog())
  return cfg.catalog_kind ?? 'lightroom'
}
