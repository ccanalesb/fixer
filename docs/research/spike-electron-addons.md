# Spike: real backend + native addons in packaged Electron 45 (#401)

Research date: **2026-10-24**. Throwaway harness: `spike/electron/` on branch `spike/electron-addons` (not merged).

## TL;DR

**Confirmed on all three targets (packaged dir builds):** the compiled visualizer backend starts in a **child of Electron 45.0.0** (`ELECTRON_RUN_AS_NODE=1`, cwd = `Resources/backend`), serves **`GET /api/status`**, and **sharp**, **better-sqlite3 + sqlite-vec**, and **onnxruntime-node** pass an in-process smoke test **without `@electron/rebuild`**.

**Also confirmed on macOS arm64 (local):** the same backend starts via **`utilityProcess.fork`** with identical native results.

**Packaging gotcha:** electron-builder **drops `node_modules` from a single `extraResources` tree**; a **second** `extraResources` entry must copy `backend-pack/node_modules` → `Resources/backend/node_modules`.

**Linux CI:** packaged app launch requires **`--no-sandbox`** (GitHub Actions cannot configure setuid `chrome-sandbox`); sharp still runs in the **backend child**, not the Chromium UI process — this spike does **not** reproduce electron#46323 (glib in the **same** process as Electron’s UI).

**Process model for #382:** `ELECTRON_RUN_AS_NODE` child or `utilityProcess` + backend in `Resources/backend/`; user data only via env overrides (`DATABASE_PATH`, `LIBRARY_DB`, `LT_CONFIG_YAML`, …).

---

## Per-platform results

CI: workflow run [40107875409](https://github.com/ccanalesb/lightroom-tagger/actions/runs/40107875409) on branch `spike/electron-addons`.

| Addon / check | macOS arm64 | Windows x64 | Linux x64 |
|---------------|-------------|-------------|-----------|
| Backend HTTP `/api/status` | **Pass** | **Pass** | **Pass** |
| **sharp** resize | **Pass** | **Pass** | **Pass** |
| **better-sqlite3** + **sqlite-vec** KNN | **Pass** | **Pass** | **Pass** |
| **onnxruntime-node** (CPU, tiny Identity ONNX) | **Pass** | **Pass** | **Pass** |
| `@electron/rebuild` | Not used | Not used | Not used |
| Spawn mode in CI/local packaged smoke | `ELECTRON_RUN_AS_NODE` | same | same (+ `--no-sandbox` for app launch) |
| `utilityProcess.fork` | **Pass** (macOS local only) | Not tested in CI | Not tested in CI |

### macOS arm64 (local packaged `.app`)

- Electron **45.0.0**, Node **24.22.0**
- Dir package **~798 MB** (`du -sh out/mac-arm64/*.app`)

### Windows x64 (CI)

- Dir package **~859 MB** (`out/win-unpacked`)
- Artifact: `spike-result-windows.json` from workflow

### Linux x64 (CI, Ubuntu 24.04 + xvfb)

- Dir package **~1.1 GB** (`out/linux-unpacked`)
- Artifact: `spike-result-linux.json` from workflow
- **Headless launch:** `ELECTRON_DISABLE_SANDBOX` + `--no-sandbox` (see `scripts/run-packaged-smoke.mjs`)

---

## Process models tried

| Model | Result | Notes |
|-------|--------|-------|
| **`spawn(appBinary, [spike-entry.mjs], { ELECTRON_RUN_AS_NODE: '1', cwd: Resources/backend })`** | **Pass** (all platforms) | Primary CI path; stock npm N-API prebuilds load under Electron’s Node 24.22. |
| **`utilityProcess.fork(spike-entry.mjs, { cwd: Resources/backend })`** | **Pass** (macOS local) | Same smoke + server; child is not `ELECTRON_RUN_AS_NODE`. |
| Natives inside `app.asar` | **Avoided** | Backend + `node_modules` live under **`Resources/backend/`** (outside ASAR). |

Child flow: `spike-entry.mjs` → `native-smoke.mjs` → `import('dist/src/server.js')`.

---

## Package size (dir target, full backend `node_modules`)

| Platform | Size |
|----------|------|
| macOS arm64 | **~798 MB** |
| Windows x64 | **~859 MB** |
| Linux x64 | **~1.1 GB** |

Weight is dominated by **onnxruntime-node**, **@img/sharp-libvips**, and the rest of the backend dependency tree (spike does not prune).

---

## Minimal electron-builder config that worked

From `spike/electron/package.json` `build` section (abridged):

```json
{
  "devDependencies": { "electron": "45.0.0" },
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
    "asar": true,
    "win": { "target": ["dir"], "executableName": "LTElectronSpike" },
    "linux": { "target": ["dir"], "executableName": "lt-electron-spike" }
  }
}
```

Prepare: `npm run prepare-backend` → `npm ci` + `npm run build` in `apps/visualizer/backend`, copy `dist/`, `node_modules/`, smoke scripts, `fixtures/tiny.onnx`, `providers.json`.

---

## Smoke harness

- Poll `GET /api/status` on an ephemeral port (never 5001).
- Temp data dir only for `DATABASE_PATH`, `LIBRARY_DB`, `LT_CONFIG_YAML`, `THUMBNAIL_DIR`.
- Native smoke: sharp 8→4 resize; in-memory `vec0` KNN; ORT Identity on 73-byte `fixtures/tiny.onnx`.
- Exit code 0/1; JSON at `SPIKE_OUTPUT_JSON` or logged `SPIKE_RESULT_JSON=…`.

```bash
cd spike/electron && npm ci && npm run pack:dir && SPIKE_HEADLESS=1 npm run smoke:packaged
```

---

## Open problems / follow-ups

1. **Dependency pruning** for shipping size (ORT + sharp + transformers dominate).
2. **Laya `worker_threads` + ORT in worker** — not exercised in this spike.
3. **Linux sharp vs Electron glib (#46323)** — only avoided by process separation; not tested with sharp in Electron **main** process on Linux.
4. **`utilityProcess` on Windows/Linux** — works on macOS; not re-run in CI.
5. **`--env-file-if-exists` via `utilityProcess.execArgv`** — not tested; spike passes env from main.
6. **Linux desktop installs** — real users need working sandbox or documented `--no-sandbox` policy (distinct from CI).
7. Server entry path: **`dist/src/server.js`** (backend `tsc` layout).

---

## References

- Prior research: [electron-native-addons.md](https://github.com/ccanalesb/lightroom-tagger/blob/research/electron-native-addons/docs/research/electron-native-addons.md)
- Harness: `spike/electron/`
- CI: `.github/workflows/spike-electron-addons.yml` (push to `spike/electron-addons` only)
