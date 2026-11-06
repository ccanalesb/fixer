import { LRCAT_EXTENSION, catalogKindOfPath } from './catalogPath'

/** Basename of a catalog path for UI copy (folder name or .lrcat stem). */
export function catalogDisplayName(catalogPath: string): string {
  const trimmed = catalogPath.trim().replace(/\/$/, '')
  const base = trimmed.split('/').pop() ?? trimmed
  return catalogKindOfPath(base) === 'lightroom' ? base.slice(0, -LRCAT_EXTENSION.length) : base
}
