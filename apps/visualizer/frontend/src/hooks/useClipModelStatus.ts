import { keys, useQuery } from '../data'
import { SystemAPI } from '../services/api'

export function useClipModelStatus() {
  return useQuery(keys.system.clipModel(), () => SystemAPI.clipModel(), {
    initialValue: { model_on_disk: true, cache_dir: '' },
  })
}
