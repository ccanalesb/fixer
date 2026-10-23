# Native addons and Node version inside Electron (wayfinder #382 / research #384)

Research date: **2026-10-23**. Question: can the visualizer backend’s native stack run inside a packaged Electron app on **macOS arm64**, **Windows x64**, and **Linux x64**?

Method: Electron releases/docs, Node.js docs, upstream package readmes and npm tarballs, GitHub issues. No changes were made to application code; npm `pack --dry-run` inspected tarball layouts.

---

## TL;DR

**Yes, with packaging work** — all listed dependencies can run in a desktop bundle on the three target platforms, but **do not assume “npm install in Electron” is enough**. You need **ASAR unpacking for every native artifact**, a deliberate **install/rebuild policy** (`@electron/rebuild` vs N-API prebuilds), and a **Linux-specific plan for `sharp`** because Electron + prebuilt libvips in the **same process** is a known crash class (glib symbol collision).

**Electron stable (Oct 2026):** npm `electron@latest` → **45.0.0**, which ships **Node v24.22.0** ([Electron v45.0.0 release notes](https://github.com/electron/electron/releases/tag/v45.0.0)). That satisfies the backend `engines: { "node": ">=24" }` and supports **`--env-file-if-exists`** (stable in Node since v24.10.0; [Node CLI docs](https://nodejs.org/api/cli.html#--env-file-if-exists)).

**Backend runtime facts:** the backend uses **`better-sqlite3`**, not `node:sqlite`. CI’s “node:sqlite-era” comment refers to the **Node 24 toolchain/flags**, not a `node:sqlite` import in `apps/visualizer/backend/src`.

**Recommended host for the Hono backend:** a **child process** (bundled **Node 24** binary *or* `ELECTRON_RUN_AS_NODE=1` on the Electron executable) started from the main process or via [`utilityProcess.fork`](https://www.electronjs.org/docs/latest/api/utility-process), **not** inside the renderer. **`node:worker_threads`** (Laya ONNX worker) is ordinary Node API and is expected to work in that child; it is separate from renderer **`nodeIntegrationInWorker`**.

| Dependency | Native? | Electron / ABI | Rebuild? | Must unpack from ASAR (minimum) | Platform notes |
|---|---|---|---|---|---|
| **better-sqlite3** ^13 | `.node` (N-API v10) | N-API; platform prebuilds in tarball | Often works without rebuild; upstream still documents **`electron-rebuild`** + unpack ([troubleshooting](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md)) | `**/node_modules/better-sqlite3/**` (at least `prebuilds/**` or `build/Release/*.node`) | Sync SQLite in HTTP thread is existing design; unchanged for Electron |
| **sharp** ^0.34.5 (+ `@img/*`) | `.node` + **libvips** | Node-API v9+ ([sharp install](https://sharp.pixelplumbing.com/install/)) | Prebuilds target **Node**, not Electron; rebuild or validate per Electron version | Official: `sharp` + **`@img/**`** ([sharp Electron section](https://sharp.pixelplumbing.com/install/#electron)) | **macOS:** keep **one** sharp/libvips copy (existing npm override). **Linux + Electron same process:** **high risk** — [electron#46323](https://github.com/electron/electron/issues/46323), [sharp#4351](https://github.com/lovell/sharp/issues/4351); **plain Node child often OK** (reporters run `node app.js` successfully). Workarounds: separate Node backend, `@img/sharp-wasm32`, community patched builds — **unverified on this stack** |
| **sqlite-vec** ^0.1.9 | **Loadable** `vec0.{dylib,so,dll}` | Extension loaded via `better-sqlite3` `loadExtension` | No compile; platform optional packages | `**/node_modules/sqlite-vec-*/vec0.*` | Loader uses `import.meta.resolve` → path must exist on disk ([`index.mjs`](https://unpkg.com/sqlite-vec@0.1.9/index.mjs)) |
| **onnxruntime-node** 1.24.3 | `.node` + **`libonnxruntime`** (+ Win DirectML DLLs if used) | **`napi-v6`** layout; docs: Node 16+ / **Electron 15+ (recommend 28+)** ([README](https://github.com/microsoft/onnxruntime/blob/v1.24.3/js/node/README.md)) | N-API prebuilds; still follow Electron native-module guidance | `**/node_modules/onnxruntime-node/bin/**` | CPU EP for wayfinder targets; CoreML EP available on macOS arm64 per upstream table — **not required for feasibility** |
| **@huggingface/transformers** ^4.2 | Indirect (**sharp**, **onnxruntime-node**) | Same as dependencies | Pin **with** `onnxruntime-node` (already enforced in `package.json`) | Same as sharp + ORT | Tokenizer/CLIP paths in backend; no separate native binding |
| **libraw-wasm** ^1.6 | **Wasm** only | N/A | N/A | Optional: keep `.wasm` readable if bundled from ASAR | Uses `node:worker_threads` shims in-repo; no `.node` |

**Node ≥24 in Electron:** satisfied by **Electron 45** today. Pin Electron in the desktop app and re-check on each Electron major bump (Node majors track Electron semver policy — [Electron versioning](https://www.electronjs.org/docs/latest/tutorial/electron-versioning)).

**Alternative — bundled Node 24 child (not Electron’s Node):** **Pros:** stock npm prebuilds, simpler mental model for N-API addons, **avoids Linux sharp↔Electron glib clash** by process isolation. **Cons:** second runtime (~tens of MB), separate security/update cadence, packaging/signing two executables. **`ELECTRON_RUN_AS_NODE`:** reuses one binary ([env docs](https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node)); native addons must match **Electron’s** Node ABI; Linux sharp issue **still applies** in that process.

---

## Backend dependency context (repo)

From `apps/visualizer/backend/package.json`:

- **`engines.node >= 24`**
- **`onnxruntime-node`** pinned to **1.24.3** to dedupe with `@huggingface/transformers`
- **`overrides.sharp`** forces a **single** sharp/libvips (macOS duplicate ObjC class issue with two libvips copies)

Dev/CI starts the server with:

`node --env-file-if-exists=.env --import tsx src/server.ts` (see `scripts/dev-up.sh`, `scripts/restart-backend.sh`). Production desktop should run **compiled `dist/`** without `tsx`; pass `--env-file-if-exists` via the child’s **`execArgv`** (supported on [`utilityProcess.fork`](https://www.electronjs.org/docs/latest/api/utility-process)) or equivalent spawn args.

**`node:sqlite`:** not used. SQLite access is **`better-sqlite3`** + **`sqlite-vec.load(db)`** in `src/db/connection.ts`.

**Worker threads:** Laya spawns `node:worker_threads` workers (`src/laya/runtime.ts`, `src/laya/worker.ts`) that load **`onnxruntime-node`** inside the worker. This is independent of Electron renderer workers.

---

## Electron native module policy (general)

Electron documents that native addons target a different ABI than stock Node and typically require **`@electron/rebuild`** (or install-time `npm_config_runtime=electron`), except when prebuilds explicitly support Electron ([Using native node modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)).

**N-API:** Node documents ABI stability for addons built **only** against N-API ([N-API introduction](https://nodejs.org/api/n-api.html#node-api)). **Caveat:** Electron has had N-API edge cases (e.g. external buffers — [electron#35801](https://github.com/electron/electron/issues/35801)); treat “no rebuild” as **hypothesis until CI proves load + inference on Electron 45**.

**ASAR:** Native `.node` files and libraries loaded via `dlopen` / `loadExtension` must live on a **real filesystem path**. [`ELECTRON_NO_ASAR`](https://www.electronjs.org/docs/latest/api/environment-variables#electron_no_asar) applies to forked/`ELECTRON_RUN_AS_NODE` children. [electron-forge `auto-unpack-natives`](https://www.electronforge.io/config/plugins/auto-unpack-natives) unpacks `*.node` automatically; **this repo’s stack also needs non-`.node` libraries unpacked** (see table above).

---

## Per-addon detail

### better-sqlite3 (^13.0.3)

- **Binding:** `NAPI_VERSION=10` in upstream `binding.gyp` (v13.0.3 tag).
- **Prebuilds shipped:** `prebuilds/{darwin,linux,linuxmusl,win32}-{arm64,x64}.node` (npm pack dry-run).
- **Electron:** troubleshooting guide requires **`electron-rebuild`** and unpacked natives in ASAR apps ([docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md)).
- **sqlite-vec interaction:** extension load is separate (below); DB file paths are user data — unaffected by ASAR.

### sharp (^0.34.5) and `@img/*`

- **Prebuilds:** platform-specific `@img/sharp-*` and `@img/sharp-libvips-*` packages (sharp install docs).
- **Electron packaging:** official **`asarUnpack`** for `sharp` and `@img` ([sharp install — electron](https://sharp.pixelplumbing.com/install/#electron)).
- **Linux breakage (critical for wayfinder “best-effort Linux”):** Electron’s Linux build dynamically links **glib** and can **leak symbols** into the process; **sharp’s bundled libvips also uses glib**, causing crashes/assertions ([electron#46323](https://github.com/electron/electron/issues/46323), open/stale as of Oct 2026). Reproducers note **`node app.js` works** while Electron fails — strongly supports **isolating the backend in a non-Electron Node process on Linux** or adopting a maintainer workaround (e.g. community **`sharp-electron`** / wasm fallback — **not evaluated in this repo**).
- **macOS:** enforce **one** sharp copy (repo override); still unpack `@img` trees.

### sqlite-vec (^0.1.9)

- **Not a Node addon:** thin JS wrapper calls `db.loadExtension(path)` ([source](https://unpkg.com/sqlite-vec@0.1.9/index.mjs)).
- **Binaries:** optional packages `sqlite-vec-{darwin,linux,windows}-{arm64,x64}` ship **`vec0.dylib` / `vec0.so` / `vec0.dll`** (e.g. `sqlite-vec-darwin-arm64@0.1.9` → `vec0.dylib`, npm pack dry-run).
- **Electron:** must unpack platform package; **loading from inside ASAR will fail** (extension path must be readable).
- **Linux arm64:** optional package exists; wayfinder target is **x64** only.

### onnxruntime-node (1.24.3)

- **Layout:** `require(\`../bin/napi-v6/${platform}/${arch}/onnxruntime_binding.node\`)` ([`dist/binding.js`](https://unpkg.com/onnxruntime-node@1.24.3/dist/binding.js)).
- **Shipped artifacts (tarball):** per platform under `bin/napi-v6/...` — e.g. macOS arm64: `onnxruntime_binding.node` + `libonnxruntime.1.24.3.dylib`; linux x64: `.node` + `libonnxruntime.so.1`; win32 x64: `.node` + `onnxruntime.dll` + DirectML-related DLLs (npm pack dry-run).
- **Electron:** upstream claims Electron **15+** with prebuilds; recommend **28+** ([README](https://github.com/microsoft/onnxruntime/blob/v1.24.3/js/node/README.md)). Wayfinder should use **CPU EP** unless explicitly adding GPU EP packaging.
- **Workers:** Laya loads ORT in a **`worker_threads` worker**; each worker loads native code — unpack once in `node_modules`, ensure worker `execArgv`/cwd still resolves `bin/napi-v6/...` (**unconfirmed in Electron utilityProcess**; standard Node behavior).

### @huggingface/transformers (^4.2.0)

- Used for CLIP / tokenizer paths (`src/imaging/clip-embed.ts`, `src/laya/sessions.ts`).
- **Native surface:** transitive **`sharp`** and **`onnxruntime-node`** only; no additional `.node` beyond those dependencies.
- **Version coupling:** keep **`onnxruntime-node`** pin aligned with transformers (documented in backend `package.json`).

### libraw-wasm (^1.6.0)

- **Wasm** (`dist/libraw.wasm`) + JS; optional worker script in package.
- **Electron:** no native rebuild; ensure wasm assets are reachable if read via filesystem from ASAR (often fine when `readFile` from unpacked path or `fetch` from `file://` — **packaging-dependent, unconfirmed**).

---

## Hosting models (trade-offs)

### A. Backend in `utilityProcess` / `ELECTRON_RUN_AS_NODE` (Electron’s Node)

- **Size:** one runtime binary.
- **ABI:** follow [Electron native module](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules) rebuild guidance; validate N-API prebuilds on **Electron 45** in CI.
- **Linux sharp:** treat as **blocker-class** unless tested on target distros; prefer **B** on Linux or wasm/patched sharp.
- **Flags:** `utilityProcess.fork(..., { execArgv: ['--env-file-if-exists=...'] })`; avoid relying on **`NODE_OPTIONS`** in packaged apps ([limited allowlist](https://www.electronjs.org/docs/latest/api/environment-variables#node_options)).
- **Worker threads:** supported in principle (full Node in utility process); Laya’s ONNX worker should run here — **needs integration test**.

### B. Backend as bundled **Node 24** `child_process` (separate binary)

- **Size:** +Node distribution per platform (arm64/x64 variants).
- **ABI:** use normal `npm ci` prebuilds for Node 24.22+ (match or exceed Electron’s Node for consistency).
- **Linux sharp:** **Electron glib collision avoided** when sharp runs only in the Node child ([electron#46323](https://github.com/electron/electron/issues/46323) discussion).
- **Ops:** two runtimes to patch; clear separation for long-running job processor + SQLite WAL writers.

### C. Renderer / main-process Node integration

**Not recommended** for this backend (native modules, threads, long CPU work, SQLite). Keep UI in renderer; backend in **A or B**.

---

## Suggested `asarUnpack` glob (electron-builder / forge)

Starting point (merge with forge `auto-unpack-natives` for `*.node`):

```json
"asarUnpack": [
  "**/node_modules/better-sqlite3/**",
  "**/node_modules/sharp/**",
  "**/node_modules/@img/**",
  "**/node_modules/onnxruntime-node/**",
  "**/node_modules/sqlite-vec-*/**"
]
```

Adjust after choosing monorepo layout (`apps/visualizer/backend/node_modules` vs hoisted root).

---

## Verification checklist (for implementation tickets)

1. **Smoke load** each native module in **Electron 45** on macOS arm64, Windows x64, Linux x64 (utilityProcess and/or bundled Node).
2. **Laya:** worker starts, ORT `ready`, one inference.
3. **sqlite-vec:** `loadExtension` + vec0 KNN query on fixture DB.
4. **sharp:** decode + resize path used in imaging jobs.
5. **Linux:** explicit distro matrix (e.g. Ubuntu LTS + one rolling) for sharp — expect failures in-process with Electron until workaround chosen.
6. **Package size:** measure ORT + libvips + optional Node binary.

---

## Citations (primary)

| Topic | URL |
|---|---|
| Electron 45.0.0 / Node 24.22.0 | https://github.com/electron/electron/releases/tag/v45.0.0 |
| Electron native modules | https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules |
| `ELECTRON_RUN_AS_NODE` | https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node |
| `utilityProcess` | https://www.electronjs.org/docs/latest/api/utility-process |
| Node `--env-file-if-exists` | https://nodejs.org/api/cli.html#--env-file-if-exists |
| Node N-API ABI | https://nodejs.org/api/n-api.html#node-api |
| sharp install / Electron ASAR | https://sharp.pixelplumbing.com/install/#electron |
| better-sqlite3 Electron troubleshooting | https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md |
| onnxruntime-node README (v1.24.3) | https://github.com/microsoft/onnxruntime/blob/v1.24.3/js/node/README.md |
| sqlite-vec loader (v0.1.9) | https://unpkg.com/sqlite-vec@0.1.9/index.mjs |
| Electron Linux sharp / glib | https://github.com/electron/electron/issues/46323 |

---

## Unconfirmed / needs desktop CI

- N-API prebuilds (**better-sqlite3**, **onnxruntime-node**, **sharp**) load **without** `@electron/rebuild` on **Electron 45.0.0** for all three OS targets.
- `utilityProcess` + `worker_threads` + onnxruntime in worker on Windows (path to DLL dependencies).
- `libraw-wasm` wasm loading when backend lives in ASAR-only tree without unpack.
- Whether **`--env-file-if-exists`** behaves identically when passed via `utilityProcess` `execArgv` in signed macOS builds.
