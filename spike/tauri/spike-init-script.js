/**
 * Tauri initialization script — runs before page scripts on every navigation.
 * Records errors from the start; on loopback origins runs the SPA mount probe.
 */
(function () {
  const log = (window.__SPIKE_ERROR_LOG__ = window.__SPIKE_ERROR_LOG__ || []);

  function push(entry) {
    try {
      log.push({ ...entry, t: Date.now() });
    } catch {
      log.push({ type: 'log-failed', t: Date.now() });
    }
  }

  if (!window.__SPIKE_CAPTURE_INSTALLED__) {
    window.__SPIKE_CAPTURE_INSTALLED__ = true;

    window.addEventListener(
      'error',
      (e) => {
        if (e.target && e.target !== window && e.target.tagName) {
          push({
            type: 'resource',
            tag: e.target.tagName,
            src: e.target.src || e.target.href || '',
            message: e.message || 'resource failed',
          });
        } else {
          push({
            type: 'error',
            message: e.message,
            file: e.filename,
            line: e.lineno,
            col: e.colno,
          });
        }
      },
      true,
    );

    window.addEventListener('unhandledrejection', (e) => {
      push({ type: 'unhandledrejection', message: String(e.reason) });
    });

    window.addEventListener('securitypolicyviolation', (e) => {
      push({
        type: 'csp',
        violatedDirective: e.violatedDirective,
        blockedURI: e.blockedURI,
        disposition: e.disposition,
      });
    });

    const origError = console.error;
    console.error = function (...args) {
      push({ type: 'console.error', message: args.map(String).join(' ') });
      return origError.apply(this, args);
    };
  }

  function isLoopbackSpa() {
    return /^https?:\/\/(127\.0\.0\.1|localhost):\d+/.test(window.location.href);
  }

  async function waitForMount(maxMs) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const root = document.getElementById('root');
      const n = root ? root.childElementCount : 0;
      const header = document.querySelector('header h1');
      if (n > 0 && header) {
        return {
          mounted: true,
          rootChildCount: n,
          hasHeaderH1: true,
          waitMs: maxMs - (deadline - Date.now()),
        };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const root = document.getElementById('root');
    return {
      mounted: false,
      rootChildCount: root ? root.childElementCount : 0,
      hasHeaderH1: Boolean(document.querySelector('header h1')),
      waitMs: maxMs,
    };
  }

  function shellReady() {
    const root = document.getElementById('root');
    return (
      (root?.childElementCount ?? 0) > 0 && Boolean(document.querySelector('header h1'))
    );
  }

  async function runProbe() {
    if (!isLoopbackSpa()) return;
    if (window.__SPIKE_PROBE_STARTED__) return;
    window.__SPIKE_PROBE_STARTED__ = true;

    const probeLocation = window.location.href;

    const report = async (payload) => {
      if (!window.__TAURI__?.core?.invoke) {
        push({ type: 'probe', message: 'invoke missing at report time' });
        return;
      }
      await window.__TAURI__.core.invoke('report_spa_smoke', { payload });
    };

    if (!window.__TAURI__?.core?.invoke) {
      for (let i = 0; i < 100; i++) {
        if (window.__TAURI__?.core?.invoke) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    if (!window.__TAURI__?.core?.invoke) {
      await report({
        ok: false,
        probeLocation,
        error: '__TAURI__.core.invoke missing on loopback SPA',
        userAgent: navigator.userAgent,
        pageErrors: log.slice(),
      });
      return;
    }

    const mount = await waitForMount(30_000);

    const routeResults = [];
    const navLinks = Array.from(document.querySelectorAll('header nav a[href]'));
    const seen = new Set();
    for (const link of navLinks) {
      const href = link.getAttribute('href');
      if (!href || seen.has(href)) continue;
      seen.add(href);
      const beforeLen = log.length;
      link.click();
      await new Promise((r) => setTimeout(r, 2200));
      routeResults.push({
        route: href,
        rendered: shellReady(),
        rootChildCount: document.getElementById('root')?.childElementCount ?? 0,
        newPageErrors: log.slice(beforeLen),
      });
    }

    if (routeResults.length === 0) {
      for (const route of ['/', '/images', '/identity', '/processing']) {
        const beforeLen = log.length;
        window.history.pushState({}, '', route);
        window.dispatchEvent(new PopStateEvent('popstate'));
        await new Promise((r) => setTimeout(r, 2200));
        routeResults.push({
          route,
          rendered: shellReady(),
          rootChildCount: document.getElementById('root')?.childElementCount ?? 0,
          newPageErrors: log.slice(beforeLen),
          note: 'history.pushState fallback',
        });
      }
    }

    let socketIo = { ok: false, error: 'not run' };
    if (mount.mounted) {
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
            resolve({ ok: false, error: 'connected event timeout (20s)' });
          }, 20_000);
          const socket = window.io(window.location.origin, {
            transports: ['websocket', 'polling'],
            reconnection: false,
            timeout: 12_000,
          });
          socket.on('connected', (payload) => {
            clearTimeout(timer);
            socket.close();
            resolve({ ok: true, detail: payload });
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
    } else {
      socketIo = { ok: false, error: 'skipped — SPA not mounted' };
    }

    let catalogDialog = { ok: false, error: 'not run' };
    if (mount.mounted) {
      try {
        const path = await window.__TAURI__.core.invoke('pick_catalog_path');
        catalogDialog = {
          ok: typeof path === 'string' && path.length > 0,
          pathSample: typeof path === 'string' ? path.slice(0, 120) : null,
          typeof: typeof path,
        };
      } catch (e) {
        catalogDialog = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    } else {
      catalogDialog = { ok: false, error: 'skipped — SPA not mounted' };
    }

    const routesOk = routeResults.length > 0 && routeResults.every((r) => r.rendered);
    const pageErrors = log.slice();
    const productionSpaRendered =
      mount.mounted && mount.hasHeaderH1 && routesOk && mount.rootChildCount > 0;
    const ok =
      productionSpaRendered &&
      pageErrors.length === 0 &&
      socketIo.ok === true &&
      catalogDialog.ok === true;

    await report({
      ok,
      productionSpaRendered,
      probeLocation,
      mount,
      routeResults,
      pageErrors,
      socketIo,
      catalogDialog,
      domProbe: {
        title: document.title,
        rootChildCount: document.getElementById('root')?.childElementCount ?? 0,
        hasHeaderH1: Boolean(document.querySelector('header h1')),
        navLinkCount: document.querySelectorAll('header nav a[href]').length,
      },
      userAgent: navigator.userAgent,
      location: window.location.href,
      crossoriginStripped: document.querySelector('script[type="module"]')?.hasAttribute('crossorigin') === false,
    });
  }

  if (isLoopbackSpa()) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => runProbe().catch(() => {}));
    } else {
      runProbe().catch(() => {});
    }
  }
})();
