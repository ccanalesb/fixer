import { invoke } from '@tauri-apps/api/core';
import { io } from 'socket.io-client';

async function runSocketSmoke() {
  const port = await invoke<number>('spike_port');
  const url = `http://127.0.0.1:${port}`;
  const userAgent = navigator.userAgent;

  const result = await new Promise<{ ok: boolean; detail?: string; error?: string }>((resolve) => {
    const timer = setTimeout(() => {
      resolve({ ok: false, error: 'socket.io connect timeout (45s)' });
    }, 45_000);

    const socket = io(url, {
      transports: ['websocket', 'polling'],
      reconnection: false,
      timeout: 20_000,
    });

    socket.on('connect', () => {
      /* wait for backend 'connected' event */
    });

    socket.on('connected', (payload: unknown) => {
      clearTimeout(timer);
      socket.close();
      resolve({
        ok: true,
        detail: `connected event ${JSON.stringify(payload)}`,
      });
    });

    socket.on('connect_error', (err: Error) => {
      clearTimeout(timer);
      socket.close();
      resolve({ ok: false, error: err.message });
    });
  });

  await invoke('report_socket_smoke', {
    payload: {
      ok: result.ok,
      detail: result.detail,
      error: result.error,
      userAgent,
      backendUrl: url,
    },
  });
}

runSocketSmoke().catch(async (e) => {
  await invoke('report_socket_smoke', {
    payload: {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      userAgent: navigator.userAgent,
    },
  });
});
