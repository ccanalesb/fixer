export function isTauriDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function getAppPort(): Promise<number> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<number>('get_app_port');
}

export async function setAppPort(port: number): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_app_port', { port });
}
