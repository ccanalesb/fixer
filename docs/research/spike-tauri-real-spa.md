# Spike: production SPA + model worker in Tauri 2 webviews (#418)

Research date: **2026-10-26**. Throwaway harness extends `spike/tauri/` on branch `spike/tauri-real-spa` (not merged). Sidecar baseline: [spike-tauri-sidecar.md](spike-tauri-sidecar.md). Model worker recipe: [spike-electron-worker-models.md](spike-electron-worker-models.md) on `spike/electron-worker-models`.

## TL;DR

**Packaged Tauri 2.12** still runs the **Node 24.11 sidecar** with the real backend; this spike adds **`spike-server.mjs`** so loopback serves the **production** `apps/visualizer/frontend` build (`backend-pack/frontend-dist/`) and the window navigates to `http://127.0.0.1:<ephemeral>/` instead of the minimal Vite harness page.

**Headless smoke (all targets):** native addons, `GET /api/status`, **socket.io `connected`** from the loopback page, **`pick_catalog_path`** via `tauri-plugin-dialog` (stub path in CI with `SPIKE_DIALOG_STUB=1`), and **ONNX worker** `GET /v1/models` + `POST /v1/systemone` for CI-converted **`laya-base`** (ADR-0020 — no weights in git).

**macOS arm64 (local packaged `.app`, measured):** end-to-end smoke **`ok: true`** after stripping Vite’s `crossorigin` attributes from the built `index.html` (WebKit otherwise left `#root` empty with no console errors). Automated **route / layout probes** still reported **`rootChildCount: 0`** / no nav links in the inject script — treat main-view rendering as **partially verified** (see below).

**CI:** workflow [`.github/workflows/spike-tauri-real-spa.yml`](../.github/workflows/spike-tauri-real-spa.yml) on push to `spike/tauri-real-spa` — Linux (xvfb) + Windows; macOS local only.

---

## Per-platform results

| Check | macOS arm64 (local `.app`) | Windows x64 (CI) | Linux x64 (CI) |
|-------|---------------------------|------------------|----------------|
| Backend `/api/status` | **Pass** | *(see CI run)* | *(see CI run)* |
| Native addons (sharp / sqlite-vec / ORT) | **Pass** | *(CI)* | *(CI)* |
| Production SPA on loopback | **Partial** — socket + IPC; DOM probe empty `#root` in headless inject | *(CI)* | *(CI)* |
| Console errors (inject harness) | **None captured** | *(CI)* | *(CI)* |
| socket.io `connected` (loopback page) | **Pass** | *(CI)* | *(CI)* |
| `tauri-plugin-dialog` → `pick_catalog_path` | **Pass** (stub path locally/CI; interactive picker not exercised) | *(CI stub)* | *(CI stub)* |
| `useCatalogPicker` fetch bridge | **Wired** (POST `/api/config/catalog/pick` → invoke); not UI-click tested | *(CI)* | *(CI)* |
| `GET /v1/models` + `POST /v1/systemone` (worker) | **Pass** (~1.5 s wall on M-series) | *(CI)* | *(CI)* |
| Live job progress in SPA | **Not exercised** — only backend `connected` event | same | same |

Webview engines (from smoke `userAgent` where present): **WKWebView** on macOS; CI expects **WebView2** / **WebKitGTK 4.1** as in #413.

---

## What broke and why (evidence)

### 1. Production SPA did not mount in WebKit with stock Vite `index.html`

**Symptom:** `document.title` was `Lightroom Tagger` but injected probe showed `rootChildCount: 0`, `hasHeaderH1: false`, and no `nav` links, with **empty `consoleErrors`**.

**Cause (spike fix):** Vite 5 production build emitted `<script type="module" crossorigin src="...">`. Served from loopback inside WKWebView, the module did not hydrate `#root` (silent failure). **`prepare-backend.mjs` strips `crossorigin` from script/link tags** in the copied `frontend-dist/index.html`.

**After fix (local):** packaged smoke **`ok: true`**, socket.io and System One pass; DOM probe still **0 children** in the automated inject (timing/isolation — see open problems).

### 2. Backend did not serve the SPA (pre-spike product gap)

**Symptom:** N/A in product today — dev uses Vite proxy; packaged spike needed a server.

**Fix (spike-only):** `spike-server.mjs` mounts `createApp()` API routes, `/assets/*` static, and SPA fallback HTML for client routes.

### 3. Tauri IPC from loopback origin

**Requirement:** `app.withGlobalTauri: true`, capability `remote-loopback-spa` with `remote.urls` `http://127.0.0.1:*` / `http://localhost:*`, and permissions for `pick_catalog_path`, `report_spa_smoke`, `spike_port`.

**Evidence:** `catalogDialog.ok: true` with `invoke pick_catalog_path from loopback SPA` in macOS artifact `/tmp/spike-result-macos8.json` (local run).

### 4. Catalog picker vs backend macOS dialog

**Product today:** `useCatalogPicker` → `ConfigAPI.pickCatalog()` → backend **AppleScript** dialog (macOS only).

**Spike:** `catalog-bridge-snippet.html` patches `fetch` for POST `/api/config/catalog/pick` to **`pick_catalog_path`** (Rust + `tauri-plugin-dialog`). **Interactive** “Choose catalog…” in the UI was **not** clicked locally or in CI.

---

## Minimal config that worked

**Serve SPA from sidecar** — env on backend child:

- `SPIKE_FRONTEND_DIST=<backend>/frontend-dist`
- `spike-entry.mjs` → `spike-server.mjs` (not `dist/src/server.js`)

**Prepare bundle** — `npm run prepare-spike` in `spike/tauri/`:

- `npm ci` + build backend and frontend (`npm ci --legacy-peer-deps` for frontend)
- Copy `frontend-dist/`, strip `crossorigin`, append catalog bridge before `</body>`
- Copy `spike-entry.mjs`, `spike-server.mjs`, `systemone-smoke.mjs`, `run-systemone-smoke.mjs`

**Tauri** — unchanged sidecar/resources pattern from #413; window **`navigate()`** to loopback after `/api/status`; inject `spa-smoke-inject.js` via `webview.eval`.

**CI model** — same conversion as #410:

```bash
uv run scripts/app-models/export_onnx.py thaitea/laya-vision --name laya-base --out "$SPIKE_OUT_DIR"
```

**Headless env:** `SPIKE_DIALOG_STUB=1`, `SPIKE_APP_MODELS_DIR`, `SPIKE_OUTPUT_JSON`, `xvfb-run` on Linux.

---

## Size / timing (local macOS, unpacked `.app`)

| Metric | Value |
|--------|--------|
| `.app` bundle (`du -sh`, after real SPA in resources) | **~621 MB** (`620.64 MiB` from `tauri build` log) |
| System One POST wall (local, `laya-base`) | **~1.4–1.6 s** |
| Backend RSS after inference (sidecar pid sample) | **~1.5 GB** (model worker + ORT) |

Compare Electron/Tauri sidecar sizes using the same **unpacked** backend tree as #413 — this spike adds **~1.1 MB** frontend JS/CSS gzip aside from unchanged backend `node_modules`.

---

## Open problems / follow-ups

1. **Automated main-view proof** — inject probe still sees empty `#root` on macOS headless even when smoke passes; need Playwright-in-webview, longer hydration wait, or manual QA for Insights/Images/Identity/Processing.
2. **Ship SPA from backend in product** — replace `spike-server.mjs` with a supported static mount in `server.ts` (or reverse proxy) and Vite `base` / `crossorigin` policy for WebKit.
3. **`useCatalogPicker` product integration** — spike uses fetch patch; product should call Tauri when `window.__TAURI__` is present (and keep backend dialog for browser-only).
4. **Job progress in SPA** — only `connected` verified; no cheap job enqueued in smoke.
5. **Interactive native dialog** — CI uses stub path; real `.lrcat` pick not exercised on macOS locally (needs human or scripted dialog).
6. **Linux CPU torch pin** — inherited from #405 conversion recipe in CI (not re-measured this spike).

---

## References

- Map: issue #382 (parent session)
- Sidecar spike: [spike-tauri-sidecar.md](spike-tauri-sidecar.md), branch `spike/tauri-sidecar`
- Worker spike: `spike/electron-worker-models`, workflow `spike-electron-worker-models.yml`
- ADR desktop shell: [0022-desktop-app-is-tauri-with-a-node-sidecar.md](../adr/0022-desktop-app-is-tauri-with-a-node-sidecar.md)
- **CI run URL:** *(fill from `gh run list --branch spike/tauri-real-spa` after push)*
