declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
  }
}

/** True when the page runs inside the Fixer desktop shell (remote loopback URL). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__ != null
}
