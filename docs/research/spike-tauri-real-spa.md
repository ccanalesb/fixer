# Spike: production SPA + model worker in Tauri 2 webviews (#418)

Research date: **2026-10-26** (rerun with honest render gate). Throwaway branch `spike/tauri-real-spa` (not merged). Prior notes on sidecar baseline: [spike-tauri-sidecar.md](spike-tauri-sidecar.md).

## TL;DR

**Root cause of empty `#root` (first CI run):** `spike-server.mjs` mounted `serveStatic` with `root: frontend-dist/assets`, so `/assets/*.js` missed on disk and fell through to the SPA **`index.html` fallback** (HTTP 200, `text/html`). The module script never executed. **Fix:** `serveStatic({ root: frontendRoot })` and do not SPA-fallback `/assets/*`.

**After fix — does the production SPA render?**

| Webview | Renders (shell + `#root` + routes) | Evidence |
|---------|-------------------------------------|----------|
| **WKWebView** (macOS arm64 local packaged) | **Yes** | `mount.mounted: true`, `rootChildCount: 1`, all four routes `rendered: true`; screenshot `spike/tauri/spike-screenshot-macos.png` (local run) |
| **WebView2** (Windows CI) | *(see latest CI artifacts)* | `spike-screenshot-windows.png`, `spike-result-windows.json` → `spa_smoke.productionSpaRendered` |
| **WebKitGTK** (Linux CI) | *(see latest CI artifacts)* | `spike-screenshot-linux.png`, `spike-result-linux.json` |

**Honest `spa_smoke.ok`:** **false** when the app logs **`console.error`** (e.g. `ApiRequestError: Library database not found` without a catalog) even if the shell renders. **`productionSpaRendered`** is the render gate used in the probe.

**`crossorigin` strip:** Playwright A/B against the same spike-server (CI artifact `playwright-mount-*.json`) compares Vite default vs stripped `index.html`. With the **asset-path fix**, both variants should mount in Chromium/WebKit; the first run’s empty `#root` was **not** fixed by strip alone — it was **wrong asset URLs**.

**System One** on Node sidecar still passes when `SPIKE_APP_MODELS_DIR` points at CI-converted `laya-base` (ADR-0020).

---

## Per-platform results (fill from CI artifact JSON)

| Check | macOS arm64 (local) | Windows x64 | Linux x64 |
|-------|---------------------|-------------|-----------|
| HTTP `/assets/*.js` is JavaScript | **Pass** (`text/javascript`, ~1.1 MB) | CI | CI |
| HTTP bogus asset | **404** (not HTML) | CI | CI |
| `productionSpaRendered` | **true** | CI | CI |
| `spa_smoke.ok` | **false** (library API console errors) | CI | CI |
| socket.io `connected` | **Pass** | CI | CI |
| System One worker | **Pass** | CI | CI |
| Screenshot artifact | local PNG path above | `spike-screenshot-windows.png` | `spike-screenshot-linux.png` |

---

## Harness (rerun)

- **`spike-init-script.js`:** Tauri `initialization_script` — error log from navigation start; probe only on `http://127.0.0.1:<port>`; **30 s** mount poll; **`productionSpaRendered`**; invokes `report_spa_smoke`.
- **Window:** created in Rust (`1280×800`), navigates to loopback (not the bundled Vite harness page).
- **`http_probe`:** Rust `reqwest` documents `/`, JS, CSS, missing asset, `/images` fallback.
- **Playwright:** `scripts/playwright-spa-mount.mjs` — crossorigin A/B vs standalone spike-server.
- **CI run:** *(updated on push)*

---

## Open problems

1. **Smoke pass criteria vs empty library** — rendering works; strict `spa_smoke.ok` fails on expected API errors until smoke seeds a minimal library or allowlists known messages.
2. **Interactive catalog dialog** — still stubbed in CI (`SPIKE_DIALOG_STUB=1`).
3. **Product static serving** — replace `spike-server.mjs` with supported backend static mount before ship.

---

## References

- CI workflow: `.github/workflows/spike-tauri-real-spa.yml`
- Worker conversion recipe: `spike/electron-worker-models` / #410
