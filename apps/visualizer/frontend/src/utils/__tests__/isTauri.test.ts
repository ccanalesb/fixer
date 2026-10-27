import { describe, it, expect, afterEach } from 'vitest'
import { isTauri } from '../isTauri'

describe('isTauri', () => {
  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('is false in a normal browser page', () => {
    expect(isTauri()).toBe(false)
  })

  it('is true when the host injected Tauri internals', () => {
    ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    expect(isTauri()).toBe(true)
  })
})
