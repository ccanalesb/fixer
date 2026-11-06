import { describe, it, expect } from 'vitest'
import {
  browserIsOnBackendHost,
  catalogChangeMode,
  normalizeCatalogPath,
} from '../useCatalogPicker'

describe('browserIsOnBackendHost', () => {
  it('accepts the loopback names a browser can report', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', '::1']) {
      expect(browserIsOnBackendHost(host)).toBe(true)
    }
  })

  it('rejects a LAN address, even though it may be the same machine', () => {
    // The dialog would open on the backend's screen; being wrong the other way
    // costs a button, being wrong this way costs a hung request.
    expect(browserIsOnBackendHost('192.168.1.42')).toBe(false)
    expect(browserIsOnBackendHost('macbook.local')).toBe(false)
  })

  it('rejects a hostname that merely contains a loopback name', () => {
    expect(browserIsOnBackendHost('localhost.evil.com')).toBe(false)
    expect(browserIsOnBackendHost('notlocalhost')).toBe(false)
  })
})

describe('normalizeCatalogPath', () => {
  it('leaves a plain path alone', () => {
    expect(normalizeCatalogPath('/Users/me/lightroom/Foo.lrcat')).toBe(
      '/Users/me/lightroom/Foo.lrcat',
    )
  })

  it("strips the single quotes Finder adds around paths with spaces", () => {
    expect(normalizeCatalogPath("'/Users/me/Pictures/Lightroom Catalog.lrcat'")).toBe(
      '/Users/me/Pictures/Lightroom Catalog.lrcat',
    )
  })

  it('strips double quotes too', () => {
    expect(normalizeCatalogPath('"/Users/me/Foo.lrcat"')).toBe('/Users/me/Foo.lrcat')
  })

  it('trims surrounding whitespace and trailing newlines', () => {
    expect(normalizeCatalogPath('  /Users/me/Foo.lrcat\n')).toBe('/Users/me/Foo.lrcat')
  })

  it('leaves an unbalanced quote in place', () => {
    expect(normalizeCatalogPath("'/Users/me/Foo.lrcat")).toBe("'/Users/me/Foo.lrcat")
  })

  it('does not strip quotes that are only internal', () => {
    expect(normalizeCatalogPath("/Users/me/it's/Foo.lrcat")).toBe("/Users/me/it's/Foo.lrcat")
  })

  it('survives a lone quote character', () => {
    expect(normalizeCatalogPath("'")).toBe("'")
  })

  it('returns empty for blank input', () => {
    expect(normalizeCatalogPath('   ')).toBe('')
  })
})

describe('catalogChangeMode', () => {
  const preview = (ask: boolean) => ({ ask_same_or_different: ask })

  it('switches when the modal never asks same or different', () => {
    expect(catalogChangeMode(preview(false), null)).toBe('switch')
  })

  it('waits for an answer when it asks', () => {
    expect(catalogChangeMode(preview(true), null)).toBeNull()
  })

  it('updates the path for the same catalog and switches for a different one', () => {
    expect(catalogChangeMode(preview(true), 'same')).toBe('update_path')
    expect(catalogChangeMode(preview(true), 'different')).toBe('switch')
  })
})
