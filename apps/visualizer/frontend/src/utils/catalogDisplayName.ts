/** Basename of a catalog path for UI copy (folder name or .lrcat stem). */
export function catalogDisplayName(catalogPath: string): string {
  const trimmed = catalogPath.trim().replace(/\/$/, '')
  const base = trimmed.split('/').pop() ?? trimmed
  return base.toLowerCase().endsWith('.lrcat') ? base.slice(0, -'.lrcat'.length) : base
}
