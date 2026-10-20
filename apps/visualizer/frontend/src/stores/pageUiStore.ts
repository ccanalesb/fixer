import { create } from 'zustand'

export const IMAGES_TAB_IDS = ['catalog', 'cull-catalog'] as const
export type ImagesTabId = (typeof IMAGES_TAB_IDS)[number]

export const PROCESSING_TAB_IDS = [
  'analyze',
  'cull',
  'perspectives',
  'cache',
  'jobs',
  'providers',
  'settings',
] as const
export type ProcessingTabId = (typeof PROCESSING_TAB_IDS)[number]

export const FILTER_PERSIST_KEYS = {
  imagesCatalog: 'images.catalog',
} as const

export type PersistedFilterState = {
  raw: Record<string, unknown>
  committed: Record<string, unknown>
}

type PageUiState = {
  imagesTab: ImagesTabId
  processingTab: ProcessingTabId
  filterStates: Record<string, PersistedFilterState>
  setImagesTab: (tab: ImagesTabId) => void
  setProcessingTab: (tab: ProcessingTabId) => void
  getFilterState: (key: string) => PersistedFilterState | undefined
  setFilterState: (key: string, state: PersistedFilterState) => void
  clearFilterState: (key: string) => void
}

export const usePageUiStore = create<PageUiState>((set, get) => ({
  imagesTab: 'catalog',
  processingTab: 'analyze',
  filterStates: {},
  setImagesTab: (tab) => set({ imagesTab: tab }),
  setProcessingTab: (tab) => set({ processingTab: tab }),
  getFilterState: (key) => get().filterStates[key],
  setFilterState: (key, state) =>
    set((prev) => ({
      filterStates: { ...prev.filterStates, [key]: state },
    })),
  clearFilterState: (key) =>
    set((prev) => {
      if (!(key in prev.filterStates)) return prev
      const rest = { ...prev.filterStates }
      delete rest[key]
      return { filterStates: rest }
    }),
}))
