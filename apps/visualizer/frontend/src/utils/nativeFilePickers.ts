import { open } from '@tauri-apps/plugin-dialog'
import { AppModelsAPI, ConfigAPI } from '../services/api'
import { isTauri } from './isTauri'

const CATALOG_FILTER = {
  name: 'Lightroom Classic catalog',
  extensions: ['lrcat'],
}

function pathFromOpenResult(selected: string | string[] | null): string | null {
  if (selected === null) return null
  return Array.isArray(selected) ? (selected[0] ?? null) : selected
}

export async function pickCatalogPath(): Promise<string | null> {
  if (isTauri()) {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [CATALOG_FILTER],
    })
    return pathFromOpenResult(selected)
  }
  const { catalog_path } = await ConfigAPI.pickCatalog()
  return catalog_path
}

export async function pickAppModelFolderPath(): Promise<string | null> {
  if (isTauri()) {
    const selected = await open({
      multiple: false,
      directory: true,
    })
    return pathFromOpenResult(selected)
  }
  const { path } = await AppModelsAPI.pick()
  return path
}
