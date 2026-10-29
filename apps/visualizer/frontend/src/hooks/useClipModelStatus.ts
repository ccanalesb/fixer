import { useQuery } from '../data'
import { SystemAPI } from '../services/api'

export function useClipModelStatus() {
  return useQuery(['system', 'clip-model'] as const, () => SystemAPI.clipModel(), {
    initialValue: { model_on_disk: true, cache_dir: '' },
  })
}
