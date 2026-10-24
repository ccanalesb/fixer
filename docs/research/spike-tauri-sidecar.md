# Spike: real backend + native addons as Node sidecar in Tauri 2 (#413)

Research date: **2026-10-24**. Throwaway harness: `spike/tauri/` on branch `spike/tauri-sidecar` (not merged). Electron baseline: [spike-electron-addons.md](spike-electron-addons.md) on `spike/electron-addons`.

## TL;DR

**Confirmed on all three targets (packaged smoke):** Tauri **2.12.x** spawns **nodejs.org Node 24.11.0** as a **`externalBin` sidecar** (`tauri-plugin-shell`), with the compiled visualizer backend + full production `node_modules` in **bundle resources**. The sidecar runs reused `spike/electron/spike-entry.mjs` → `native-smoke.mjs` → `dist/src/server.js` on an **ephemeral port** and **temp data dir** (never repo `library.db` / `:5001`).

**Smoke checks (all pass):** sharp, better-sqlite3 + sqlite-vec KNN, onnxruntime-node, `GET /api/status`, **socket.io** `connected` event from a minimal bundled Vite page (WKWebView / WebKitGTK / WebView2) reported to Rust via `invoke`.

**Size vs Electron (same unp pruned backend tree):** installed footprint is **~15–40% smaller** than the Electron dir packages because Tauri does not ship a private Chromium stack—only system webview + Node sidecar + backend resources. Dominant weight remains **onnxruntime-node**, **sharp/libvips**, and the rest of backend `node_modules`.

**CI:** workflow run [40114156774](https://github.com/ccanalesb/lightroom-tagger/actions/runs/40114156774) (Linux + Windows after smoke-script fix).

---

## Per-platform results

| Check | macOS arm64 (local) | Windows x64 (CI) | Linux x64 (CI) |
|-------|---------------------|------------------|----------------|
| Backend `/api/status` | **Pass** | **Pass** | **Pass** |
| **sharp** | **Pass** | **Pass** | **Pass** |
| **better-sqlite3 + sqlite-vec** | **Pass** | **Pass** | **Pass** |
| **onnxruntime-node** | **Pass** | **Pass** | **Pass** |
| **socket.io** in system webview | **Pass** | **Pass** | **Pass** |
| Sidecar killed on app exit | **Pass** (SIGKILL in log) | **Pass** | **Pass** |
| Node for natives | **24.11.0** sidecar | **24.11.0** sidecar | **24.11.0** sidecar |
| `@electron/rebuild` / ORT rebuild | **Not needed** (stock Node prebuilds) | same | same |

### Webview (from smoke JSON user-agent)

| Platform | Engine |
|----------|--------|
| macOS arm64 | **WKWebView** (WebKit 605.1.15) |
| Linux x64 | **WebKitGTK** 4.1 (WebKit 605.1.15 / Safari 605.1.15 UA) |
| Windows x64 | **WebView2** (Edge **131** / Chrome 131 UA) |

Stack: **Tauri 2.12.5**, **wry 0.57.1**.

---

## Size vs Electron spike (~798 / ~859 / ~1.1 GB dir packages)

Metrics differ slightly (Tauri `.app` / `.deb` / NSIS vs Electron `dir` trees), but all include the **same full backend `node_modules`**.

| Platform | Tauri spike (this work) | Electron spike (#401) | Notes |
|----------|-------------------------|------------------------|-------|
| macOS arm64 | **~636 MB** `.app` (`du -sh`) | **~798 MB** `.app` | **−162 MB (~20%)** — no bundled Chromium |
| Windows x64 | **~131 MB** NSIS `*-setup.exe`; **~7.5 MB** GUI `.exe` + **`backend/`** beside it in `target/release/` | **~859 MB** `win-unpacked` | Installer artifact is compressed; full install ≈ backend resources + WebView2 runtime (usually already on Win11). Still far below Electron **unpacked** dir. |
| Linux x64 | **~407 MB** `.deb`; **~9.4 MB** `lt-tauri-spike` binary | **~1.1 GB** `linux-unpacked` | **−~700 MB (~36%)** vs Electron dir; `.deb` holds app + resources. |

Backend resource tree alone (mac, inside `.app`): same order of magnitude as Electron `Resources/backend/` (~600 MB class).

---

## Build time (approx.)

| Target | Time |
|--------|------|
| macOS arm64 local (`npm run build:release`, cold Rust fetch) | **~7–9 min** (incl. `prepare-backend` npm ci + `tsc`) |
| Linux CI job | **~21 min** |
| Windows CI job | **~9 min** (parallel workflow **~9 min** wall on [40114156774](https://github.com/ccanalesb/lightroom-tagger/actions/runs/40114156774)) |

Local tooling installed for this spike: **rustup** → **stable 1.99.1** (`aarch64-apple-darwin`), user-level only.

---

## Minimal config that worked

**Sidecar + resources** (`spike/tauri/src-tauri/tauri.conf.json`):

```json
{
  "bundle": {
    "externalBin": ["binaries/node"],
    "resources": { "../backend-pack/": "backend/" },
    "targets": ["app", "nsis", "deb"]
  }
}
```

**Prepare:** `npm run prepare-spike` → `prepare-backend.mjs` (reuse electron smoke scripts) + `fetch-node.mjs` (nodejs.org **v24.11.0** → `src-tauri/binaries/node-<target-triple>`).

**Spawn (Rust):** `app.shell().sidecar("node")` with `cwd = backend`, env `FLASK_HOST` / `FLASK_PORT`, temp `DATABASE_PATH`, `LIBRARY_DB`, `LT_CONFIG_YAML`, `LT_PROVIDERS_JSON`, `THUMBNAIL_DIR`, `SPIKE_RESULT_PATH`.

**Shell capability:** `shell:allow-execute` for sidecar name `node`; `shell:allow-kill`.

**Headless CI smoke:** `SPIKE_HEADLESS=1`, `SPIKE_OUTPUT_JSON=…`, Linux `xvfb-run -a npm run smoke:packaged`.

---

## Process model

```
Tauri (Rust) ── sidecar spawn ──► node (externalBin) ── spike-entry.mjs
                                      │
                                      ├─ native-smoke.mjs (sharp / sqlite-vec / ORT)
                                      └─ dist/src/server.js (HTTP + socket.io)

Webview (bundled dist/) ── socket.io-client ──► 127.0.0.1:<ephemeral port>
                      └── invoke report_socket_smoke ──► JSON result + exit
```

---

## Open problems / follow-ups

1. **Shipping size** — still dominated by backend deps; Tauri shell savings do not remove ORT/sharp weight.
2. **Full visualizer SPA** — spike uses a **minimal** Vite page, not `apps/visualizer/frontend` production build (socket.io path validated only).
3. **macOS DMG** — `tauri build` **DMG step failed locally** (Finder AppleScript timeout); spike uses **`app` bundle only** on macOS (no DMG in targets).
4. **Windows smoke harness** — first CI attempt launched **NSIS setup.exe** ( hung ); fixed to run **`target/release/lt-tauri-spike.exe`**.
5. **Linux resource layout** — backend lands under `target/release/backend/` next to the binary (differs from macOS `Contents/Resources/backend`); document for #382 installers.
6. **Worker threads + ORT in workers** — not exercised (same gap as Electron spike).
7. **Code signing / notarization** — out of scope.

---

## References

- Electron counterpart: [spike-electron-addons.md](spike-electron-addons.md)
- Harness: `spike/tauri/`
- CI: `.github/workflows/spike-tauri-sidecar.yml` (push to `spike/tauri-sidecar` only)
- Issue: [#413](https://github.com/ccanalesb/lightroom-tagger/issues/413)
