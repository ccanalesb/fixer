import { CullAPI } from '../../services/api'
import { invalidate, invalidateAll, useQuery } from '../../data'
import { CullDetailSection } from './CullDetailSection'

/** Fetches cull detail and wires send / user-action mutations. */
export function CullDetailSectionLoader({
  imageKey,
  onMutated,
}: {
  imageKey: string
  onMutated?: () => void
}) {
  const detail = useQuery(['cull.detail', imageKey] as const, () => CullAPI.photoDetail(imageKey))

  const refresh = () => {
    invalidate(['cull.detail', imageKey])
    invalidateAll(['cull.summary', 'cull.photos'])
    invalidateAll(['images.catalog'])
    onMutated?.()
  }

  return (
    <CullDetailSection
      detail={detail}
      onAction={async (action) => {
        await CullAPI.recordAction(imageKey, action)
        refresh()
      }}
      onWithdrawShouldHaveBeenFiltered={async () => {
        await CullAPI.withdrawShouldHaveBeenFiltered(imageKey)
        refresh()
      }}
      onSend={async () => {
        await CullAPI.sendPhotos([imageKey])
        refresh()
      }}
    />
  )
}
