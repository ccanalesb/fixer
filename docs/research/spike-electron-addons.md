# Spike: real backend + native addons in packaged Electron 45 (#401)

Research date: **2026-10-24**. Throwaway harness: `spike/electron/` on branch `spike/electron-addons` (not merged).

## TL;DR

**Confirmed on macOS arm64 (local, dir-packaged app):** the compiled visualizer backend starts in a **child of Electron 45** (`ELECTRON_RUN_AS_NODE=1` on the app binary, cwd = `Resources/backend`), serves **`GET /api/status`**, and **sharp**, **better-sqlite3 + sqlite-vec**, and **onnxruntime-node** all pass an in-process smoke test **without `@electron/rebuild`**.

**Also confirmed on macOS arm64:** the same backend starts via **`utilityProcess.fork`** (Electron’s utility process API) with identical native results.

**Packaging gotcha:** electron-builder **strips `node_modules` from a single `extraResources` tree**; a **second** `extraResources` entry copying `backend-pack/node_modules` → `Resources/backend/node_modules` is required (N-API `.node` files and ORT/sharp libs must live on disk under `Resources/`, not inside `app.asar`).

**Linux / Windows:** CI workflow `.github/workflows/spike-electron-addons.yml` runs on push to `spike/electron-addons` only — see per-platform table below (filled from CI artifacts).

**Process model recommendation for #382:** prefer **`ELECTRON_RUN_AS_NODE` child** or **`utilityProcess`** hosting **`dist/src/server.js`** with backend deps in **`Resources/backend/`**; temp user data via env (`DATABASE_PATH`, `LIBRARY_DB`, `LT_CONFIG_YAML`, etc.). Linux sharp-in-**Electron-main** glib issue (#46323) was **not** retested here because sharp runs in the **Node child**, not the browser/main process.

---

## Per-platform results

| Addon / check | macOS arm64 | Windows x64 | Linux x64 |
|---------------|-------------|-------------|-----------|
| Backend HTTP `/api/status` | **Pass** (packaged + unpachaged) | _CI_ | _CI_ |
| **sharp** resize | **Pass** | _CI_ | _CI_ |
| **better-sqlite3** + **sqlite-vec** KNN | **Pass** | _CI_ | _CI_ |
| **onnxruntime-node** (CPU, tiny Identity ONNX) | **Pass** | _CI_ | _CI_ |
| Notes | No `@electron/rebuild`; Node **24.22** / Electron **45.0.0** | | Linux: sharp in **child** process (not renderer) |

_Update this table from `spike-result-*.json` CI artifacts after workflow completes._

### macOS arm64 (local)

| Check | Result |
|-------|--------|
| `ELECTRON_RUN_AS_NODE` | Pass |
| `utilityProcess.fork` | Pass |
| Rebuild | Not required (stock npm prebuilds) |

---

## Process models tried

| Model | macOS arm64 packaged | Notes |
|-------|----------------------|-------|
| **`spawn(execPath, [spike-entry.mjs], { env: { ELECTRON_RUN_AS_NODE: '1' }, cwd: Resources/backend })`** | **Pass** | Matches research doc “reuse one binary”; native modules resolve from `Resources/backend/node_modules`. |
| **`utilityProcess.fork(spike-entry.mjs, { cwd: Resources/backend })`** | **Pass** | No `ELECTRON_RUN_AS_NODE` in child; same native smoke + server. |
| Backend inside `app.asar` | **Not used** | Backend + natives live in **`extraResources`**, not ASAR. |

Child entry: `Resources/backend/spike-entry.mjs` → `native-smoke.mjs` → dynamic import `dist/src/server.js`.

---

## Package size (dir target, includes full backend `node_modules`)

| Platform | Size (approx.) |
|----------|----------------|
| macOS arm64 `.app` | **~798 MB** (`du -sh out/mac-arm64/*.app`) |
| Windows x64 | _CI `spike-win-size.txt`_ |
| Linux x64 | _CI `spike-linux-size.txt`_ |

Dominant weight: **onnxruntime-node**, **@img/sharp-libvips**, **@huggingface/transformers** transitive tree — spike ships the **entire** backend production `node_modules`, not a pruned subset.

---

## Minimal electron-builder config that worked

From `spike/electron/package.json` `build` section (abridged):

```json
{
  "electron": "45.0.0",
  "build": {
    "files": ["main.mjs", "package.json"],
    "extraResources": [
      {
        "from": "backend-pack",
        "to": "backend",
        "filter": ["**/*", "!node_modules", "!node_modules/**"]
      },
      {
        "from": "backend-pack/node_modules",
        "to": "backend/node_modules"
      }
    ],
    "asar": true
  }
}
```

Prepare step (`npm run prepare-backend`): `npm ci` + `npm run build` in `apps/visualizer/backend`, copy `dist/`, `node_modules/`, `providers.json`, `fixtures/tiny.onnx`, `spike-entry.mjs`, `native-smoke.mjs` into `backend-pack/`.

**Not needed for this spike:** `asarUnpack` on the main app ASAR (natives are outside ASAR in `Resources/backend/`). A production app might still want unpack globs if any native deps are linked from the main process.

---

## Smoke harness

- **Health:** poll `http://127.0.0.1:<ephemeral>/api/status` until `{ "status": "ok" }`.
- **Data dir:** temp only (`DATABASE_PATH`, `LIBRARY_DB`, `LT_CONFIG_YAML`, `THUMBNAIL_DIR`); never repo-root `library.db` / `config.yaml`.
- **Port:** ephemeral (never 5001).
- **Native smoke:** 8×8 PNG → sharp 4×4; in-memory `vec0` KNN; ORT Identity on `fixtures/tiny.onnx` (73 bytes, generated once via Python `onnx` helper).
- **Headless exit:** `SPIKE_HEADLESS=1`; JSON written to `SPIKE_OUTPUT_JSON` or temp `final-spike-result.json`; process exit 0/1.

Run locally after pack:

```bash
cd spike/electron && npm ci && npm run pack:dir && SPIKE_HEADLESS=1 npm run smoke:packaged
```

---

## Open problems / follow-ups for implementation

1. **Prune backend dependencies** for desktop (CLIP/Laya paths not exercised in spike) — size likely still dominated by ORT + sharp.
2. **`@electron/rebuild` policy:** spike did not need rebuild on macOS arm64; **Windows/Linux CI must confirm** N-API prebuilds under `ELECTRON_RUN_AS_NODE`.
3. **Linux sharp vs Electron glib (#46323):** spike runs sharp in the **backend child** only; still validate on Ubuntu CI and on distros where users run the full UI in-process with any sharp usage in **Electron** process.
4. **Laya `worker_threads` + ORT inside worker** — not exercised (only main-thread ORT smoke).
5. **`--env-file-if-exists` via `utilityProcess` `execArgv`** — not tested; spike uses explicit env vars from the main process.
6. **electron-builder `node_modules` copy** — production pipeline should document the **two-step `extraResources`** pattern or an `afterPack` copy so natives are never silently dropped.
7. **Compiled server path** is `dist/src/server.js` (backend `tsc` `rootDir: "."`).

---

## References

- Prior research: [electron-native-addons.md](electron-native-addons.md) (branch `research/electron-native-addons`)
- Harness: `spike/electron/`
- CI: `.github/workflows/spike-electron-addons.yml` (branch `spike/electron-addons` only)
