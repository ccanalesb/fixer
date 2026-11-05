import type { PrimaryScoreSource } from './PrimaryScorePill'
import type { ImageDetailTab } from './ImageDetailModal'

export type ImageDetailModalView = 'culling' | 'catalog' | 'identity'

export type ModalPropsForView = {
  initialTab: ImageDetailTab
  showCullSection: boolean
  primaryScoreSource: PrimaryScoreSource
}

export function modalPropsFor(view: ImageDetailModalView): ModalPropsForView {
  switch (view) {
    case 'culling':
      return { initialTab: 'culling', showCullSection: true, primaryScoreSource: 'catalog' }
    case 'catalog':
      return { initialTab: 'file', showCullSection: false, primaryScoreSource: 'catalog' }
    case 'identity':
      return { initialTab: 'ai', showCullSection: false, primaryScoreSource: 'identity' }
  }
}
