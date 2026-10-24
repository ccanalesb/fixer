# How Electron apps run a local Node server (wayfinder #382 / research #402)

Research date: **2026-10-24**. Question: for a desktop shell around the existing Hono + socket.io backend (`apps/visualizer/backend`) and React SPA (`apps/visualizer/frontend`), how should the backend be hosted, how should loopback URLs be chosen, how should the UI be loaded, and how do other apps do it?

Method: Electron and Node primary docs/source, ADR-0019, this repo’s backend entrypoints, and five open-source reference implementations. Prior related research: [electron-native-addons.md](https://github.com/ccanalesb/lightroom-tagger/blob/research/electron-native-addons/docs/research/electron-native-addons.md) on native addons and child-process hosting (#384). **No product decision here** — options and trade-offs only (#387 grills).

---

## TL;DR

- **Three ways to run “Node with your backend” beside Electron:** [`utilityProcess.fork`](https://www.electronjs.org/docs/latest/api/utility-process) (Chromium Services API, full Node in a utility child), [`child_process.spawn`/`fork`](https://nodejs.org/api/child_process.html) with a **bundled Node 24** binary, or **`spawn(process.execPath, …)` + `ELECTRON_RUN_AS_NODE=1`** (Electron’s embedded Node — [`child_process.fork` in Electron already sets this](https://github.com/electron/electron/blob/main/lib/node/init.ts)). Lifecycle is similar (spawn → `exit` / `utilityProcess` `exit`); shutdown is **not guaranteed instant**: POSIX sends `SIGTERM` via `kill()`; Windows **terminates** the process ([utilityProcess `kill()`](https://www.electronjs.org/docs/latest/api/utility-process)). The visualizer backend already handles **`SIGINT`/`SIGTERM`** for graceful shutdown (`server.ts`).
- **Crash detection:** listen for child **`exit`** (non-zero) and/or [`app` `child-process-gone`](https://www.electronjs.org/docs/latest/api/app#event-child-process-gone) (`type: 'Utility'`, `reason: 'crashed' | 'abnormal-exit'`, …). **Auto-restart** is a product choice (SQLite WAL + job processor make blind restart risky). **Windows dev servers** often need **`taskkill /T`** to drop subprocess trees ([marimo bridge](https://github.com/soakaye/obsidian-marimo-bridge/blob/main/src/server-manager.ts)).
- **Port strategy:** dev today uses **fixed 5001** (`config.ts`, AirPlay avoids 5000). Packaged app can keep **5001 on `127.0.0.1`** (simple browser URL) or pick a **free port** (`listen(0)` / probe) and persist it (e.g. `~/.caretaker/port`) so a **local browser** and Electron window both load `http://127.0.0.1:<port>`. Align **`FRONTEND_ORIGINS`** / socket.io CORS with whatever origin serves the SPA. Backend **refuses a second listener** on the same port (`refuseIfPortInUse` in `server.ts`) — **single-instance lock** at the Electron layer is strongly aligned with that.
- **Serving the SPA:** **same HTTP server as the API** (Vite build as static files + `/api` + `/socket.io`) best preserves **“open in browser”**, relative `/api` URLs, cookies, and socket.io without CORS gymnastics. **`file://`** breaks normal web security assumptions (Chromium treats many `file://` paths as same-origin; cookies/storage differ). **`protocol.handle('app', …)`** can serve static assets but the page origin is **`app://`** — API calls become **cross-origin** unless the backend CORS list includes `app://…` or the UI uses absolute `http://127.0.0.1:…` for API/socket (split-origin UI).
- **Prior native-addon research (#384)** favors a **non-renderer child**; **bundled Node 24** avoids Electron’s Node ABI and Linux **sharp ↔ Electron glib** collision class; **`utilityProcess` / `ELECTRON_RUN_AS_NODE`** reuse one binary but still run Electron’s Node (native rebuild / Linux sharp risk remains). **`NODE_OPTIONS`** is **restricted in packaged apps** — pass `--env-file-if-exists` via **`execArgv`** on `utilityProcess.fork`, not via env ([Electron env docs](https://www.electronjs.org/docs/latest/api/environment-variables#node_options)).
- **Reference apps:** [Caretaker](https://github.com/Hyperwindmill/caretaker-cli/blob/main/packages/desktop/src/main.ts) (`utilityProcess` + Hono, free port file), [Logseq](https://github.com/logseq/logseq/blob/master/src/electron/electron/server.cljs) (Fastify **in main**, default `127.0.0.1:12315`), [llm desktop](https://github.com/ank1015/llm/blob/main/apps/desktop/src/main/server/embedded-server.ts) (`ELECTRON_RUN_AS_NODE` child), [Obsidian marimo bridge](https://github.com/soakaye/obsidian-marimo-bridge/blob/main/src/server-manager.ts) (`child_process`, `127.0.0.1`, Windows tree kill), [Standard Notes](https://github.com/standardnotes/desktop/issues/453#issuecomment-566789684) (local HTTP vs `file://` for separate origins).

---

## Repo context (ground truth)

| Topic | Fact | Source |
|--------|------|--------|
| Bind address | `HOST_DEFAULT = 'localhost'` (`FLASK_HOST`) | `apps/visualizer/backend/src/config.ts` |
| Default port | **5001** (not 5000 — macOS AirPlay) | `config.ts`, `server.ts` |
| Second backend | **Exit 1** if port in use (SQLite lock contention) | `server.ts` `refuseIfPortInUse` |
| Shutdown | `SIGINT` / `SIGTERM` → stop jobs, close socket.io, `server.close` | `server.ts` |
| CORS | `/api/*` — `config.FRONTEND_ORIGINS` (default `http://localhost:5173,http://localhost:5174`) | `app.ts` |
| socket.io | Same HTTP server; CORS `origin: FRONTEND_ORIGINS`, `credentials: true` | `server.ts` |
| Dev UI | Vite **5173**, proxies **`/api`** and **`/socket.io`** to backend | `apps/visualizer/frontend/vite.config.ts` |
| Loopback UX | Catalog picker shown only when `browserIsOnBackendHost(hostname)` (`localhost`, `127.0.0.1`, `::1`) | ADR-0019, `useCatalogPicker.ts` |
| Packaging goal | Backend never leaves the machine; UI may be reached remotely later with auth | ADR-0019 |

Electron is expected to **co-locate** UI and backend on loopback so ADR-0019’s picker affordance works without LAN ambiguity.

---

## Option A: `utilityProcess.fork`

**What it is:** Main process starts a [utility process](https://www.electronjs.org/docs/latest/api/utility-process) — Node enabled, optional MessagePort to renderers ([process model](https://www.electronjs.org/docs/latest/tutorial/process-model)).

| Aspect | Behavior | Notes |
|--------|----------|--------|
| Start | `utilityProcess.fork(modulePath, args, { env, execArgv, stdio: 'pipe', cwd })` | `execArgv` supports e.g. [`--env-file-if-exists=.env`](https://nodejs.org/api/cli.html#--env-file-if-existspath) |
| Ready | Poll loopback TCP, parse stderr (`backend listening on…`), or IPC/`postMessage` if added | Caretaker polls `127.0.0.1:PORT` ([source](https://github.com/Hyperwindmill/caretaker-cli/blob/main/packages/desktop/src/main.ts)) |
| Crash | `'exit'` with code ≠ 0; [`child-process-gone`](https://www.electronjs.org/docs/latest/api/app#event-child-process-gone) with `type: 'Utility'` | Distinguish graceful kill (POSIX `SIGTERM` may surface as exit 0 after Electron normalization — [utility process source](https://github.com/electron/electron/blob/main/shell/browser/api/electron_api_utility_process.cc)) |
| Stop | `child.kill()` → SIGTERM (POSIX) or terminate (Windows) | Backend must exit on SIGTERM (already does). **Unconfirmed:** whether `utilityProcess` + long-running `worker_threads` (Laya ONNX) matches plain Node without integration tests (#384). |
| Logging | `stdio: 'pipe'` → `'stdout'` / `'stderr'` events on child | Default `inherit` merges into Electron’s console |
| ASAR / natives | Same as any Node child: unpack natives; `ELECTRON_NO_ASAR` in forked children per [env docs](https://www.electronjs.org/docs/latest/api/environment-variables#electron_no_asar) | #384 |

**Pros:** Official Electron path for “Node sidecar”; no second runtime binary; Chromium reaps utility children.

**Cons:** Native modules target **Electron’s Node ABI**; Linux **sharp + Electron same process** risk (#384); slightly different API than raw `child_process` (no built-in IPC channel unless MessagePort used).

---

## Option B: `child_process` + bundled Node 24

**What it is:** Ship `node` (or `node.exe`) per platform next to the app; `spawn(nodePath, [backendEntry], { env, stdio })`.

| Aspect | Behavior |
|--------|----------|
| ABI | Stock **Node 24** prebuilds from `npm ci` (#384) |
| Linux sharp | Backend-only Node process **avoids** Electron glib collision ([#46323](https://github.com/electron/electron/issues/46323) class, per #384) |
| Size | Extra tens of MB per platform |
| Packaging | Two binaries to sign/update |

**Pros:** Matches backend `engines.node >= 24` without `@electron/rebuild`; clearest separation for SQLite + job processor + ONNX workers.

**Cons:** Second runtime; must resolve `node` path inside packaged layout (`process.resourcesPath`, etc.).

---

## Option C: `child_process` + `ELECTRON_RUN_AS_NODE`

**What it is:** `spawn(process.execPath, [scriptPath], { env: { …, ELECTRON_RUN_AS_NODE: '1' } })` — [documented env](https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node). Electron’s patched [`child_process.fork`](https://github.com/electron/electron/blob/main/lib/node/init.ts) sets this automatically when forking from **inside** an Electron main process.

| Aspect | Behavior |
|--------|----------|
| **Packaged app pitfall** | Spawning `process.execPath` **without** a dedicated entry argv may relaunch the **GUI** instead of a script; apps use **`--start-server`** argv dispatch or only pass the server script as first Node arg ([Stack Overflow / Electron maintainer explanation](https://stackoverflow.com/questions/46554634/child-process-fork-not-starting-an-express-server-inside-of-packaged-electron-ap/46608130)) |
| macOS | Fork may use `process.helperExecPath` ([init.ts](https://github.com/electron/electron/blob/main/lib/node/init.ts)) |
| Fuses | If [`runAsNode` fuse](https://www.electronjs.org/docs/latest/tutorial/fuses) disabled, env ignored |

**Reference:** [llm `embedded-server.ts`](https://github.com/ank1015/llm/blob/main/apps/desktop/src/main/server/embedded-server.ts) spawns Next standalone `server.js` with `ELECTRON_RUN_AS_NODE: '1'`, `HOSTNAME`/`PORT` on loopback. [Hermes workspace `electron/main.cjs`](https://github.com/outsourc-e/hermes-workspace/blob/e1470084/electron/main.cjs) uses `spawn(process.execPath, [prod-server.cjs, …])` with `ELECTRON_RUN_AS_NODE: '1'` and IPC `{ type: 'ready', port }`.

**Pros:** One shipped binary; no separate Node download.

**Cons:** Same native-module and Linux sharp constraints as Option A; packaged argv routing must be designed explicitly.

---

## Lifecycle comparison (summary)

| Concern | utilityProcess | child_process (Node or RUN_AS_NODE) |
|---------|----------------|-------------------------------------|
| Spawn API | `utilityProcess.fork` | `spawn` / `fork` |
| Exit signal | `'exit'` on child | `'exit'` on `ChildProcess` |
| Kill on quit | `kill()` | `kill('SIGTERM')` / `process.kill(pid)` |
| Windows SIGTERM | Terminate via Chromium ([docs](https://www.electronjs.org/docs/latest/api/utility-process)) | Node emulates: `SIGTERM` → unconditional termination ([Node process docs](https://nodejs.org/api/process.html#signal-events)) |
| Subprocess trees | **Unconfirmed** for utilityProcess + job workers | Use **`taskkill /T /F`** on Windows when backend spawns children ([marimo bridge](https://github.com/soakaye/obsidian-marimo-bridge/blob/main/src/server-manager.ts)) |
| Restart policy | App-defined; listen `exit` + backoff | Same |
| Logging | pipe / inherit / electron-log file | Same |

**Suggested shutdown sequence (pattern, not a decision):** set quitting flag → `backendProc.kill()` → wait for `exit` (timeout) → on Windows optionally tree-kill if port still bound → `app.quit()`. Register **`before-quit`** / **`window-all-closed`** so tray-only apps still stop the backend ([Caretaker](https://github.com/Hyperwindmill/caretaker-cli/blob/main/packages/desktop/src/main.ts)).

**Backend alignment:** `server.ts` already drains jobs and closes socket.io on SIGTERM; Electron should send SIGTERM once, not SIGKILL immediately, unless timeout exceeded.

---

## Loopback port: fixed vs ephemeral

| Strategy | Pros | Cons |
|----------|------|------|
| **Fixed `127.0.0.1:5001`** | Matches dev docs/scripts; user can bookmark `http://127.0.0.1:5001`; matches `PORT_DEFAULT` | Collides with dev backend, other apps, or [WSL2 mirrored-network port ranges](https://github.com/standardnotes/forum/issues/3913) (**unconfirmed** for 5001 specifically) |
| **Free port + persist** | Avoids `EADDRINUSE`; Caretaker writes `port` under data dir ([main.ts](https://github.com/Hyperwindmill/caretaker-cli/blob/main/packages/desktop/src/main.ts)) | Browser user must read port file or copy URL from app; CLI/docs must not assume 5001 |
| **Free port per session only** | Simple | External browser tab from yesterday’s URL breaks |

**Discovery for Electron window:** load `http://127.0.0.1:${port}` after readiness probe (TCP connect or HTTP GET `/api/…`).

**Discovery for local browser:** same URL if fixed port; if dynamic, expose via **About / Copy server URL**, **`~/.config/…/port` file**, or system tray — **unconfirmed** which UX wayfinder wants (#387).

**Constraint #382 (loopback only):** bind backend to **`127.0.0.1` / `localhost`**, not `0.0.0.0`. Logseq defaults host `127.0.0.1` ([server.cljs](https://github.com/logseq/logseq/blob/master/src/electron/electron/server.cljs)). Standard Notes moved extension server to localhost after binding all interfaces ([issue #453](https://github.com/standardnotes/desktop/issues/453)).

**CORS / socket.io:** whatever origin serves the SPA must appear in `FRONTEND_ORIGINS` (env `FRONTEND_URL`). Dev uses separate origins (5173 → 5001) with CORS + Vite proxy. Production **single-origin** (`http://127.0.0.1:5001` for both static and API) minimizes config.

---

## Where to serve the SPA

| Approach | Origin seen by React | `/api` + cookies | socket.io | “Use as web page” in Chrome/Safari |
|----------|----------------------|------------------|-----------|-------------------------------------|
| **Backend serves static build** (same port as Hono) | `http://127.0.0.1:5001` | Same-origin; cookies work if set | Same-origin WebSocket | **Natural:** same URL as Electron |
| **Vite dev (status quo)** | `http://localhost:5173` | Proxied (browser sees 5173) | Proxied WS | Already supported |
| **`file://` + absolute API URL** | opaque `file://` | Cross-origin to API; CORS required | Cross-origin; CORS + WS headers | Awkward URL; ADR loopback checks use **page hostname**, not API host |
| **`protocol.handle('app://…')`** | `app://` custom scheme | Cross-origin to `http://127.0.0.1` unless CORS extended | Cross-origin; must allow `app://` in socket.io CORS (**unverified** config) | Browser **cannot** open `app://` like a normal site |
| **Separate static server in Electron** | second port | Two origins — same as dev proxy | Two origins | Possible but duplicates port/CORS work |

**Chromium note:** [`protocol.handle`](https://www.electronjs.org/docs/latest/api/protocol) can mimic `file://` serving; Standard Notes documented that **`file://` treats paths as same-origin** while extensions needed **`http://127.0.0.1:…`** ([issue #453 comment](https://github.com/standardnotes/desktop/issues/453#issuecomment-566789684)).

**Implication for visualizer:** Today the backend does **not** serve the SPA (API-only `createApp()`). Electron packaging likely adds static middleware **or** keeps a tiny second server — **decision for #387**. Single HTTP server matches Vite-less “open in browser” and simplest socket.io.

---

## Single-instance lock

[`app.requestSingleInstanceLock()`](https://www.electronjs.org/docs/latest/api/app#apprequestsingleinstancelockadditionaldata): first instance `true`, duplicates `false` → **`app.quit()`** immediately (use **`app.exit(0)`** if duplicate must not run `before-quit` wallet/server teardown — [Pearl wallet PR narrative](https://github.com/pearl-research-labs/pearl/pull/239)).

Primary instance: [`second-instance`](https://www.electronjs.org/docs/latest/api/app#event-second-instance) → focus window.

**Why it matters here:** `server.ts` **refuses** double bind on the same port; without lock, second launch fails with stderr message or races SQLite. Lock should run **before** spawning backend ([Hermes](https://github.com/outsourc-e/hermes-workspace/blob/e1470084/electron/main.cjs), [Caretaker](https://github.com/Hyperwindmill/caretaker-cli/blob/main/packages/desktop/src/main.ts)).

---

## Open-source reference implementations

| Project | Pattern | Loopback / port | Notable files |
|---------|---------|-----------------|---------------|
| **Caretaker** | `utilityProcess.fork` → Hono CLI; BrowserWindow → `http://127.0.0.1:PORT` | Free port if `PORT=0`; **`port` file** in data dir | [`packages/desktop/src/main.ts`](https://github.com/Hyperwindmill/caretaker-cli/blob/main/packages/desktop/src/main.ts) |
| **Logseq** | Fastify **in Electron main** (not a child); optional separate **`child_process`** for Python embedding server | Configurable `127.0.0.1`, default **12315**; auth tokens | [`server.cljs`](https://github.com/logseq/logseq/blob/master/src/electron/electron/server.cljs), [`embedding_server.cljs`](https://github.com/logseq/logseq/blob/master/src/electron/electron/embedding_server.cljs) |
| **llm (ank1015)** | `spawn(process.execPath, [server.js])` + **`ELECTRON_RUN_AS_NODE`** | `HOSTNAME`/`PORT` env on child | [`embedded-server.ts`](https://github.com/ank1015/llm/blob/main/apps/desktop/src/main/server/embedded-server.ts) |
| **Obsidian marimo bridge** | Plugin: `child_process.spawn` marimo **`--host 127.0.0.1`** | Port conflict detection / reuse; **Windows `taskkill /T`** | [`server-manager.ts`](https://github.com/soakaye/obsidian-marimo-bridge/blob/main/src/server-manager.ts) |
| **Standard Notes (desktop, historical)** | Main app **`file://`**; extensions via **local HTTP** (45653) | Separate origins by design; later **localhost-only** bind | [Issue #453](https://github.com/standardnotes/desktop/issues/453) (maintainer explains `extServer.js`) |

**Not a local-server host:** archived [Jellyfin Desktop Electron](https://github.com/jellyfin-archive/jellyfin-desktop-electron) is a **remote** client to Jellyfin — useful contrast only.

---

## Cross-cutting constraints (from #384 + Electron docs)

- **`NODE_OPTIONS`:** largely **disabled packaged** except allowlist; use **`utilityProcess.fork` `execArgv`** for `--env-file-if-exists` ([env vars](https://www.electronjs.org/docs/latest/api/environment-variables#node_options)).
- **Native stack:** `better-sqlite3`, `sharp`, `onnxruntime-node`, `sqlite-vec` require unpack paths and possibly `@electron/rebuild` when using Electron’s Node (#384).
- **Dev vs prod:** pattern from reference apps — **do not spawn** packaged backend when `ELECTRON_DEV_URL` / external Vite already running ([agent-config main-process reference](https://github.com/brianlovin/agent-config/blob/HEAD/skills/electron-wrapper/references/main-process.md)).

---

## Unconfirmed / needs integration proof

- `utilityProcess` + backend **`worker_threads`** (Laya) + ONNX load on Electron 45.
- socket.io CORS with custom scheme **`app://`** if SPA served off-protocol.
- Whether fixed **5001** conflicts with common Windows/WSL mirrored port reservations (Standard Notes saw this class on **45653**).
- Auto-restart backend after crash without corrupting in-flight jobs / SQLite WAL.

---

## Citations (primary)

- Electron: [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process), [process model](https://www.electronjs.org/docs/latest/tutorial/process-model), [environment variables](https://www.electronjs.org/docs/latest/api/environment-variables), [app / single instance](https://www.electronjs.org/docs/latest/api/app), [protocol.handle](https://www.electronjs.org/docs/latest/api/protocol), [child-process-gone](https://www.electronjs.org/docs/latest/api/app#event-child-process-gone)
- Electron source: [`lib/node/init.ts`](https://github.com/electron/electron/blob/main/lib/node/init.ts) (fork + `ELECTRON_RUN_AS_NODE`), [utility process kill/exit](https://github.com/electron/electron/blob/main/shell/browser/api/electron_api_utility_process.cc)
- Node: [child_process](https://nodejs.org/api/child_process.html), [signal events / Windows](https://nodejs.org/api/process.html#signal-events), [`--env-file-if-exists`](https://nodejs.org/api/cli.html#--env-file-if-existspath)
- Repo: ADR [0019](../adr/0019-backend-is-always-local-only-the-ui-travels.md), [#384 electron-native-addons](https://github.com/ccanalesb/lightroom-tagger/blob/research/electron-native-addons/docs/research/electron-native-addons.md)
