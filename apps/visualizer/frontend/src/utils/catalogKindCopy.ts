export type CatalogKind = 'lightroom' | 'folder'

export function forCatalogKind(
  kind: CatalogKind | undefined,
  lightroom: string,
  folder: string,
): string {
  return kind === 'folder' ? folder : lightroom
}
