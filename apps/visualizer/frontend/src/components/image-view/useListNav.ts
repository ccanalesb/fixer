import { useCallback, useState } from 'react'

export type ListNav = {
  keys: string[]
  index: number
  onIndexChange: (index: number) => void
}

/**
 * The photo a list has open in the image detail modal, and the modal's Prev / Next over
 * that list. The open photo is held by its key, so a list that reloads in a new order
 * keeps showing it. A key that is not in the list (opened from a link, or gone after a
 * reload) still opens, without Prev / Next; so does a list of one.
 */
export function useListNav(keys: string[]) {
  const [openKey, setOpenKey] = useState<string | null>(null)
  const index = openKey === null ? -1 : keys.indexOf(openKey)
  const nav: ListNav | undefined =
    index >= 0 && keys.length > 1
      ? { keys, index, onIndexChange: (i) => setOpenKey(keys[i] ?? openKey) }
      : undefined
  const close = useCallback(() => setOpenKey(null), [])
  return { openKey, open: setOpenKey as (key: string) => void, close, nav }
}
