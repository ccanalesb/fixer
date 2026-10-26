/**
 * Injected into the real SPA webview (loopback origin). Reports via Tauri invoke.
 */
(async function spikeSpaSmoke() {
  const consoleErrors = [];
  const origError = console.error;
  console.error = (...args) => {
    consoleErrors.push(args.map(String).join(' '));
    origError.apply(console, args);
  };
  window.addEventListener('error', (e) => {
    consoleErrors.push(`${e.message} @ ${e.filename}:${e.lineno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    consoleErrors.push(`unhandled: ${e.reason}`);
  });

  const report = async (payload) => {
    await window.__TAURI__.core.invoke('report_spa_smoke', { payload });
  };

  if (!window.__TAURI__?.core?.invoke) {
    await report({
      ok: false,
      error: '__TAURI__.core.invoke missing on loopback SPA',
      userAgent: navigator.userAgent,
      location: window.location.href,
    });
    return;
  }

  await new Promise((r) => setTimeout(r, 12000));

  function shellReady() {
    return Boolean(document.querySelector('header h1'));
  }

  const routeResults = [];
  const navLinks = Array.from(document.querySelectorAll('nav a[href]'));
  const seen = new Set();
  for (const link of navLinks) {
    const href = link.getAttribute('href');
    if (!href || seen.has(href)) continue;
    seen.add(href);
    const before = consoleErrors.length;
    link.click();
    await new Promise((r) => setTimeout(r, 1800));
    routeResults.push({
      route: href,
      ok: shellReady(),
      newConsoleErrors: consoleErrors.slice(before),
    });
  }

  if (routeResults.length === 0) {
    routeResults.push({
      route: window.location.pathname,
      ok: shellReady(),
      newConsoleErrors: [],
      note: 'no header nav links matched (narrow viewport?)',
    });
  }

  let socketIo = { ok: false, error: 'not run' };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket.io script load timeout')), 15_000);
      const s = document.createElement('script');
      s.src = '/socket.io/socket.io.js';
      s.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      s.onerror = () => {
        clearTimeout(timer);
        reject(new Error('failed to load /socket.io/socket.io.js'));
      };
      document.head.appendChild(s);
    });
    socketIo = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ ok: false, error: 'connected event timeout (25s)' });
      }, 25_000);
      const socket = window.io(window.location.origin, {
        transports: ['websocket', 'polling'],
        reconnection: false,
        timeout: 15_000,
      });
      socket.on('connected', (payload) => {
        clearTimeout(timer);
        socket.close();
        resolve({ ok: true, detail: payload, userAgent: navigator.userAgent });
      });
      socket.on('connect_error', (err) => {
        clearTimeout(timer);
        socket.close();
        resolve({ ok: false, error: err?.message ?? String(err) });
      });
    });
  } catch (e) {
    socketIo = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  let catalogDialog = { ok: false, error: 'not run' };
  try {
    const path = await window.__TAURI__.core.invoke('pick_catalog_path');
    catalogDialog = {
      ok: typeof path === 'string' && path.length > 0,
      pathSample: typeof path === 'string' ? path.slice(0, 120) : null,
      typeof: typeof path,
      wiring: 'invoke pick_catalog_path from loopback SPA',
    };
  } catch (e) {
    catalogDialog = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const domProbe = {
    title: document.title,
    rootChildCount: document.getElementById('root')?.childElementCount ?? 0,
    hasHeaderH1: Boolean(document.querySelector('header h1')),
    navLinkCount: document.querySelectorAll('nav a[href]').length,
  };

  await report({
    ok: consoleErrors.length === 0 && socketIo.ok === true && catalogDialog.ok === true,
    consoleErrors,
    routeResults,
    domProbe,
    socketIo,
    catalogDialog,
    userAgent: navigator.userAgent,
    location: window.location.href,
  });
})().catch(async (e) => {
  try {
    if (window.__TAURI__?.core?.invoke) {
      await window.__TAURI__.core.invoke('report_spa_smoke', {
        payload: {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          userAgent: navigator.userAgent,
        },
      });
    }
  } catch {
    /* Rust timeout */
  }
});
