type TauriInternals = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
}

function tauriInternals(): TauriInternals | null {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return null
  }
  return (window as Window & { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__
}

export function isTauriRuntime(): boolean {
  return tauriInternals() !== null
}

export async function invokeDeleteAllDataAndQuit(): Promise<void> {
  const internals = tauriInternals()
  if (!internals) {
    throw new Error('Delete all data is only available in the desktop app.')
  }
  await internals.invoke('delete_all_data_and_quit')
}

export type ManualUpdateCheckResult = 'up_to_date' | 'check_failed' | 'update_available'

export async function invokeCheckForUpdatesManual(): Promise<ManualUpdateCheckResult> {
  const internals = tauriInternals()
  if (!internals) {
    throw new Error('Check for updates is only available in the desktop app.')
  }
  const result = (await internals.invoke('check_for_updates_manual')) as string
  if (
    result === 'up_to_date' ||
    result === 'check_failed' ||
    result === 'update_available'
  ) {
    return result
  }
  return 'check_failed'
}
