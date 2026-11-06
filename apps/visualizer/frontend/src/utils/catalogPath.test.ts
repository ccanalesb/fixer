import { describe, expect, it } from 'vitest'
import { catalogKindOfPath } from './catalogPath'
import { catalogDisplayName } from './catalogDisplayName'

describe('catalogKindOfPath', () => {
  it('reads a path ending in .lrcat, any case, as a Lightroom catalog', () => {
    expect(catalogKindOfPath('/Users/me/Pictures/Lightroom Catalog.lrcat')).toBe('lightroom')
    expect(catalogKindOfPath('  /Users/me/Old.LRCAT \n')).toBe('lightroom')
  })

  it('reads any other path as a folder catalog', () => {
    expect(catalogKindOfPath('/Volumes/NAS/Photos')).toBe('folder')
    expect(catalogKindOfPath('/Volumes/NAS/Photos.lrcat-data')).toBe('folder')
  })
})

describe('catalogDisplayName', () => {
  it('names a Lightroom catalog by its file stem and a folder by its name', () => {
    expect(catalogDisplayName('/a/Holiday.LRCAT')).toBe('Holiday')
    expect(catalogDisplayName('/Volumes/NAS/Photos/')).toBe('Photos')
  })
})
