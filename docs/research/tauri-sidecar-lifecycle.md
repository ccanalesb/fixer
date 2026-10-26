# Sidecar lifecycle and data directories in Tauri 2 (wayfinder #382 / research #417)

Research date: **2026-10-26**. Context: [ADR-0022](https://github.com/ccanalesb/lightroom-tagger/blob/master/docs/adr/0022-desktop-app-is-tauri-with-a-node-sidecar.md) — Tauri 2 shell, Hono backend as a **Node 24 `externalBin` sidecar** (`tauri-plugin-shell`), SPA loaded from the backend loopback origin. Prior art: [electron-local-server.md](https://github.com/ccanalesb/lightroom-tagger/blob/research/electron-local-server/docs/research/electron-local-server.md) (#402), [desktop-data-dirs.md](https://github.com/ccanalesb/lightroom-tagger/blob/research/desktop-data-dirs/docs/research/desktop-data-dirs.md) (#403), [spike-tauri-sidecar.md](https://github.com/ccanalesb/lightroom-tagger/blob/spike/tauri-sidecar/docs/research/spike-tauri-sidecar.md) (#413), [posix-assumptions-audit.md](https://github.com/ccanalesb/lightroom-tagger/blob/research/posix-assumptions/docs/research/posix-assumptions-audit.md) (#386). **No product decision here** — facts, trade-offs, and implementation patterns for grilling.

---

## TL;DR

- **`CommandChild::kill()` without `set_process_group(true)` kills only the direct sidecar process** (Node): POSIX uses `SharedChild::kill()` ([Rust `Child::kill`](https://doc.rust-lang.org/std/process/struct.Child.html#method.kill)); Windows uses `Child::kill()` ([tauri-plugin-shell `process/mod.rs`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/process/mod.rs)). **`set_process_group(true)`** enables **`killpg(…, SIGKILL)`** (POSIX) or **`TerminateJobObject`** on a Windows job ([same file](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/process/mod.rs), [`job_object.rs`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/process/job_object.rs)). Defaults are **`process_group: false`**, **`kill_on_drop: false`** ([`Command::new`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/process/mod.rs)). The #413 spike calls plain `kill()` on exit ([`lib.rs`](https://github.com/ccanalesb/lightroom-tagger/blob/spike/tauri-sidecar/spike/tauri/src-tauri/src/lib.rs)).
- **`uv` model conversions use `detached: true` and their own POSIX process group** ([`app-model-install.ts`](../../apps/visualizer/backend/src/jobs/handlers/app-model-install.ts)); they are **not** in the Node sidecar’s process group. **macOS experiment (2026-10-26):** `SIGKILL` on Node left a **detached `sleep` child running** (`/tmp`, not this repo). Graceful shutdown should **`SIGTERM` the sidecar** so `server.ts` drains jobs ([`server.ts`](../../apps/visualizer/backend/src/server.ts)), and the backend should **`stopRunningConversions()` on shutdown** (today only on `process.on('exit')`, not on `SIGTERM` — see §1). **`worker_threads`** die with Node (in-process).
- **Rust host crash / `kill -9` on Tauri:** no `RunEvent::Exit`, no guaranteed `CommandChild` drop — **sidecar and detached `uv` can orphan** unless the OS reaps them (no Tauri `PR_SET_PDEATHSIG` wiring found). **Product host** should own sidecar spawn/kill; backend owns cooperative shutdown and POSIX **`uv`** cleanup when it receives signals.
- **`tauri-plugin-single-instance`:** Windows **named mutex** + hidden window + `WM_COPYDATA`; Linux **D-Bus** well-known name; macOS **`/tmp/{identifier}_si.sock`** ([platform sources](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/single-instance/src/platform_impl)). Second instance **forwards argv/cwd and `exit(0)`** without starting the main loop ([`lib.rs`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/single-instance/src/lib.rs)). Register **first** in the plugin list ([README](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/single-instance/README.md)). Align with backend **`refuseIfPortInUse`** ([`server.ts`](../../apps/visualizer/backend/src/server.ts)).
- **Loopback port (#402 for Tauri):** **Fixed `127.0.0.1:5001`** keeps dev parity and a stable **“open in browser”** URL ([ADR-0019](https://github.com/ccanalesb/lightroom-tagger/blob/master/docs/adr/0019-backend-is-always-local-only-the-ui-travels.md)); **single-instance + port refuse** cover double-launch. Ephemeral port + persisted **`server-url` / port file** remains valid if collisions matter; spike used ephemeral ([#413](https://github.com/ccanalesb/lightroom-tagger/blob/spike/tauri-sidecar/docs/research/spike-tauri-sidecar.md)).
- **Sidecar crash:** listen on the async **`CommandEvent::Terminated`** channel ([`TerminatedPayload`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/process/mod.rs)); **do not blind-restart** while jobs/SQLite WAL may be mid-flight — user-visible error, optional bounded restart when idle ([#402](https://github.com/ccanalesb/lightroom-tagger/blob/research/electron-local-server/docs/research/electron-local-server.md)).
- **Data dirs (#403 for Tauri):** Tauri **`app_local_data_dir`** → **`%LOCALAPPDATA%\<identifier>`** on Windows ([`localDataDir` / `path.ts`](https://github.com/tauri-apps/tauri/blob/dev/packages/api/src/path.ts)); **`app_data_dir`** → **Roaming `%APPDATA%`** on Windows ([`dataDir`](https://github.com/tauri-apps/tauri/blob/dev/packages/api/src/path.ts)). **`app_cache_dir`** uses **`cacheDir`** → **LocalAppData** on Windows (unlike Electron `userCache` in Roaming — [#403](https://github.com/ccanalesb/lightroom-tagger/blob/research/desktop-data-dirs/docs/research/desktop-data-dirs.md)). Put **SQLite WAL + models** under **`app_local_data_dir`** (Win/Linux); **vision cache** under **`app_cache_dir`**; small **`config.yaml`** can live under **`app_config_dir`** or beside DBs via env ([`config.ts`](../../apps/visualizer/backend/src/config.ts)).

---

## 1. Sidecar kill and child processes (`tauri-plugin-shell`)

### 1.1 What `CommandChild::kill` does (source)

| OS | `process_group == false` (default) | `process_group == true` |
|----|-------------------------------------|-------------------------|
| **POSIX** | `self.inner.kill()` on the sidecar PID only ([`send_kill`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/process/mod.rs)) | `killpg(pgid, SIGKILL)` where `pgid` is the child’s PID ([same](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/process/mod.rs)) — group created via `CommandExt::process_group(0)` at spawn |
| **Windows** | `Child::kill()` on the sidecar only | Child started **`CREATE_SUSPENDED`**, assigned to a **Job object**, resumed; kill calls **`TerminateJobObject`** ([`job_object.rs`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/process/job_object.rs)) |

`kill()` then **`wait()`**s on the direct child ([`CommandChild::kill`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/process/mod.rs)). **`kill_on_drop(true)`** calls the same `send_kill` on `Drop` but does not wait ([docs on `kill_on_drop`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/process/mod.rs)).

**Plugin exit hook:** `tauri-plugin-shell` **`RunEvent::Exit`** kills only children recorded from the **JavaScript `spawn` IPC** ([`lib.rs` `on_event`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/lib.rs)). **Rust `sidecar().spawn()` is not auto-registered** — the host must keep `CommandChild` and kill it (as in the #413 spike [`RunEvent::Exit`](https://github.com/ccanalesb/lightroom-tagger/blob/spike/tauri-sidecar/spike/tauri/src-tauri/src/lib.rs)).

### 1.2 Backend children relevant to this app

| Child | Mechanism | Killed when sidecar gets default `kill()`? |
|-------|-----------|---------------------------------------------|
| **Job handlers / ONNX in `worker_threads`** | In-process | **Yes** (Node dies) |
| **`uv run … export_onnx.py`** | `spawn(..., { detached: true })`, separate process group; cancel via `process.kill(-pid, 'SIGTERM')` ([`app-model-install.ts`](../../apps/visualizer/backend/src/jobs/handlers/app-model-install.ts)) | **No on POSIX** if Node is **`SIGKILL`**ed before `exit` handlers run; **not in Node’s pgid** even with `set_process_group(true)` on the sidecar |
| **Future subprocesses** | Same pattern as today’s `uv` | Treat as **out-of-tree** unless spawned non-detached inside Node’s group |

**Backend shutdown today:** `SIGINT` / `SIGTERM` → `stopJobProcessor()`, socket.io close, `server.close` ([`server.ts`](../../apps/visualizer/backend/src/server.ts)). **`stopRunningConversions`** is registered on **`process.on('exit')`** only ([`app-model-install.ts`](../../apps/visualizer/backend/src/jobs/handlers/app-model-install.ts)), not on the `SIGTERM` path — on graceful `SIGTERM`, **`exit` still runs after `process.exit(0)`**, so **`uv` should be signalled**; on **`SIGKILL`**, Node docs note **`exit` is not emitted for external signals like `SIGKILL`** ([`process` events](https://nodejs.org/api/process.html#event-exit)) — **`uv` can orphan**.

**Windows note (#386):** Node **`process.kill(-pid, …)` for process groups throws on Windows** ([`process.kill`](https://nodejs.org/api/process.html#processkillpid-signal)); backend cancellation of **`uv`** is already POSIX-oriented. **`set_process_group(true)` + job object** on the sidecar is the Tauri-side tree kill for **descendants that remain in the job**. Whether **`detached: true`** `uv` stays in the job is **unconfirmed** (depends on Node/Win32 creation flags; see [Job objects — nested processes](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)).

### 1.3 macOS local experiment (detached child)

In `/tmp` on macOS arm64 (2026-10-26): Node spawned `sleep 300` with **`detached: true`**, then Node received **`SIGKILL`**. **Result:** `sleep` **kept running**. Confirms detached **`uv`** class is **not** cleaned up by killing Node alone without backend **`exit`**/group kill logic.

With **`set_process_group(true)`** on the sidecar, **non-detached** children that share the sidecar’s pgid can be killed via **`killpg`** (plugin unit test [`test_cmd_process_group_kill`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/process/mod.rs)).

### 1.4 App exit paths (window close, Cmd+Q, kill, crash)

| Event | Sidecar cleanup if host implements spike pattern | Risk |
|-------|--------------------------------------------------|------|
| Normal quit (`RunEvent::Exit`) | Manual `CommandChild::kill()` in handler | Use **`SIGTERM` first** (custom signal to Node) then **`kill()`** / group kill — plain `kill()` uses **`SIGKILL`-class** behaviour on Unix ([`Child::kill`](https://doc.rust-lang.org/std/process/struct.Child.html#method.kill)) |
| **`tauri-plugin-shell` JS spawns** | Auto-kill on `RunEvent::Exit` | N/A for Rust sidecar |
| **Force-kill Tauri (SIGKILL, crash)** | **`RunEvent::Exit` may not run**; `CommandChild` **`Drop` may not run** | **Orphan Node + detached `uv`** |
| **User kills Node only** | Tauri may still run | Webview broken; host should watch **`CommandEvent::Terminated`** |

**Where tree kill should live**

| Layer | Responsibility |
|-------|----------------|
| **Rust host** | Spawn sidecar with **`set_process_group(true)`**; on quit: optional **`SIGTERM`** to Node → timeout → **`CommandChild::kill()`**; keep **`CommandChild` until exit**; handle **`Terminated`** while running |
| **Backend** | **`SIGTERM`/`SIGINT` graceful shutdown** (existing); call **`stopRunningConversions()`** from shutdown path, not only `exit`; long-term **Windows-safe cancel** for `uv` (#386) |
| **Not recommended** | Rely on **`PR_SET_PDEATHSIG`** in Node without product design — **unconfirmed** benefit when host dies without signalling |

---

## 2. Single instance and loopback port

### 2.1 `tauri-plugin-single-instance` (per OS)

| OS | Mechanism | Second instance |
|----|-----------|-----------------|
| **Windows** | `CreateMutexW` named `{identifier}-sim`; hidden message window `{identifier}-siw` | Finds window, **`AllowSetForegroundWindow`**, sends **`WM_COPYDATA`**, **`cleanup_before_exit`**, **`exit(0)`** ([`windows.rs`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/single-instance/src/platform_impl/windows.rs)) |
| **Linux** | Session D-Bus name `{identifier}.SingleInstance` (override via **`dbus_id`**) | **`NameTaken`** → D-Bus **`ExecuteCallback`** on primary, then **`exit(0)`** ([`linux.rs`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/single-instance/src/platform_impl/linux.rs)). No session bus → **warn and run normally** |
| **macOS** | Unix socket **`/tmp/{identifier}_si.sock`** (`.`/`-` → `_` in name) | Connect + send cwd/args → **`exit(0)`**; else bind listener ([`macos.rs`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/single-instance/src/platform_impl/macos.rs)) |

Lock released in **`AppHandle::cleanup_before_exit`** after **`RunEvent::Exit`** ([plugin docs on `destroy`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/single-instance/src/lib.rs)). **Flatpak/Snap:** set **`DBUS_ID`** when identifier ≠ package id ([README](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/single-instance/README.md)).

**macOS caveat:** socket path must stay **&lt; 100 chars** ([comment in `macos.rs`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/single-instance/src/platform_impl/macos.rs)); long **`identifier`** values need scrutiny.

### 2.2 Combination with backend port handling

Backend **`refuseIfPortInUse`** exits **1** if the listen port is taken ([`server.ts`](../../apps/visualizer/backend/src/server.ts)) — aligns with **one backend per machine** for SQLite.

| Scenario | Expected behaviour |
|----------|-------------------|
| Double-click while first instance up | **Single-instance** forwards to first; **second never spawns sidecar** (if second exits before setup) |
| Race: second sidecar starts before mutex | **First backend holds port**; second **exits 1** — host should **surface error** and quit |
| Dev CLI backend on **5001** + packaged app on **5001** | **Collision** — dev or app must use different port |

### 2.3 Fixed vs free port (#402 revisited)

| Strategy | Tauri + browser mode |
|----------|----------------------|
| **Fixed `127.0.0.1:5001`** | Same URL as dev docs; **`FRONTEND_ORIGINS`** includes webview origin; **single-instance** reduces double backend; collision with **dev server** or other apps remains |
| **Ephemeral + persist** | #413 spike pattern; needs **UI “copy server URL”** or **`port` file** under data dir ([Caretaker pattern in #402](https://github.com/ccanalesb/lightroom-tagger/blob/research/electron-local-server/docs/research/electron-local-server.md)) |
| **Hybrid** | Default **5001**; fallback to **`listen(0)`** only when probe fails — **unconfirmed** UX |

---

## 3. Crash detection and sidecar restart

### 3.1 What Tauri exposes

- Async channel from **`Command::spawn()`**: **`CommandEvent::Stdout` / `Stderr` / `Error` / `Terminated(TerminatedPayload)`** ([`CommandEvent`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/process/mod.rs)).
- **`TerminatedPayload`**: `{ code: Option<i32>, signal: Option<i32> }` ( **`signal` Unix only** ).

There is **no** built-in “restart sidecar” API — host policy.

### 3.2 Suggested restart policy (pattern)

1. **`app_shutting_down` flag** — set before intentional `kill()`; ignore **`Terminated`** for restart.
2. **Unexpected `Terminated`** (non-zero **code**, or **signal** on Unix): log stderr tail, **disable webview** or show **“Backend stopped”** with **Retry**.
3. **Auto-restart:** at most **N** attempts with **backoff** only when **no in-flight jobs** (query `/api/jobs` or IPC) — blind restart risks **duplicate job workers** and WAL contention ([#402](https://github.com/ccanalesb/lightroom-tagger/blob/research/electron-local-server/docs/research/electron-local-server.md)).
4. **Persistent crash loop:** stop restarting; point user at **`app_log_dir`** ([`path.ts` `appLogDir`](https://github.com/tauri-apps/tauri/blob/dev/packages/api/src/path.ts)).

---

## 4. Data directories (Tauri v2 path API)

**Bundle identifier:** `tauri.conf.json` **`identifier`** (e.g. `com.example.app`) is appended for **`app_*_dir`** paths ([`app_data_dir` Rust](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/path/desktop.rs), [`path.ts`](https://github.com/tauri-apps/tauri/blob/dev/packages/api/src/path.ts)). Override via **`app > appDirectoriesOverride`** ([config reference](https://v2.tauri.app/reference/config/#appdirectoriesoverride)).

### 4.1 Base directories (Tauri `path.ts` platform notes)

| API | Linux | macOS | Windows |
|-----|-------|-------|---------|
| **`configDir`** | `$XDG_CONFIG_HOME` or `~/.config` | `~/Library/Application Support` | **`FOLDERID_RoamingAppData`** ([`path.ts`](https://github.com/tauri-apps/tauri/blob/dev/packages/api/src/path.ts)) |
| **`dataDir`** | `$XDG_DATA_HOME` or `~/.local/share` | `~/Library/Application Support` | **`FOLDERID_RoamingAppData`** |
| **`localDataDir`** | `$XDG_DATA_HOME` or `~/.local/share` | `~/Library/Application Support` | **`FOLDERID_LocalAppData`** |
| **`cacheDir`** | `$XDG_CACHE_HOME` or `~/.cache` | `~/Library/Caches` | **`FOLDERID_LocalAppData`** |

**Roaming on Windows:** only **`app_data_dir`** / **`app_config_dir`** (via **`dataDir` / `configDir`**) sit under **`%APPDATA%`**. **`app_local_data_dir`** and **`app_cache_dir`** use **Local** ([Microsoft Known Folders](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid)).

**macOS:** Tauri maps both **`dataDir`** and **`localDataDir`** to **Application Support** ([`path.ts`](https://github.com/tauri-apps/tauri/blob/dev/packages/api/src/path.ts)) — unlike Windows, no Roaming/Local split; still avoid **iCloud-synced** paths ([#403](https://github.com/ccanalesb/lightroom-tagger/blob/research/desktop-data-dirs/docs/research/desktop-data-dirs.md)).

**Linux vs Electron:** Tauri **`app_data_dir`** follows **`dataDir`** (`~/.local/share`), **not** Electron’s `~/.config` **`userData`** ([#403](https://github.com/ccanalesb/lightroom-tagger/blob/research/desktop-data-dirs/docs/research/desktop-data-dirs.md)).

### 4.2 App-scoped paths

| API | Resolves to |
|-----|-------------|
| **`app_config_dir`** | `configDir/identifier` |
| **`app_data_dir`** | `dataDir/identifier` |
| **`app_local_data_dir`** | `localDataDir/identifier` |
| **`app_cache_dir`** | `cacheDir/identifier` |
| **`app_log_dir`** | macOS: `~/Library/Logs/identifier`; Win/Linux: `localDataDir/identifier/logs` ([`path.ts` `appLogDir`](https://github.com/tauri-apps/tauri/blob/dev/packages/api/src/path.ts)) |

**Webview storage:** **`app_local_data_dir`** is documented as the **default webview data directory on Windows and Linux** ([`app_local_data_dir` Rust doc](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/path/desktop.rs)).

### 4.3 Mapping app artifacts (#403 rules → Tauri)

| Artifact | Tauri suggestion | Rationale |
|----------|------------------|-----------|
| **`library.db` / `visualizer.db` (WAL)** | **`app_local_data_dir`** (Win); **`app_data_dir`** or **`app_local_data_dir`** (mac — same base); **`app_local_data_dir`** (Linux) | **Never Roaming** on Windows ([#403](https://github.com/ccanalesb/lightroom-tagger/blob/research/desktop-data-dirs/docs/research/desktop-data-dirs.md)); SQLite on local FS ([WAL](https://www.sqlite.org/wal.html)) |
| **`config.yaml`** (small) | **`app_config_dir`** or subdir of local data | Roaming OK on Windows for **small** config; or colocate with library root (**Option C** #403) |
| **`models/`** | Under **`app_local_data_dir`** (e.g. `models/`) | Large, durable, non-roaming |
| **Vision cache (~GB)** | **`app_cache_dir/vision`** (or `config.yaml` `vision_cache_dir`) | Tauri **`app_cache_dir`** → **Local** on Windows (contrast Electron `userCache` in Roaming — [#403](https://github.com/ccanalesb/lightroom-tagger/blob/research/desktop-data-dirs/docs/research/desktop-data-dirs.md)) |
| **Optional user library root** | Still **`config.yaml`** + env (`LT_CONFIG_YAML`, `DATABASE_PATH`, …) | Same as CLI; desktop shell writes paths at first run |

Pass absolute paths to the sidecar via **env** (spike pattern: `DATABASE_PATH`, `LIBRARY_DB`, `LT_CONFIG_YAML` in [`lib.rs`](https://github.com/ccanalesb/lightroom-tagger/blob/spike/tauri-sidecar/spike/tauri/src-tauri/src/lib.rs)).

---

## 5. Primary sources index

- **tauri-plugin-shell:** [`process/mod.rs`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/process/mod.rs), [`job_object.rs`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/process/job_object.rs), [`lib.rs`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/lib.rs)
- **tauri-plugin-single-instance:** [`lib.rs`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/single-instance/src/lib.rs), [`platform_impl/`](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/single-instance/src/platform_impl)
- **Tauri paths:** [`packages/api/src/path.ts`](https://github.com/tauri-apps/tauri/blob/dev/packages/api/src/path.ts), [`crates/tauri/src/path/desktop.rs`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/path/desktop.rs)
- **Rust / Node process:** [`Child::kill`](https://doc.rust-lang.org/std/process/struct.Child.html#method.kill), [Node `process.kill`](https://nodejs.org/api/process.html#processkillpid-signal), [Node `exit` event](https://nodejs.org/api/process.html#event-exit)
- **Windows jobs:** [Job objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- **This repo:** [ADR-0022](https://github.com/ccanalesb/lightroom-tagger/blob/master/docs/adr/0022-desktop-app-is-tauri-with-a-node-sidecar.md), backend [`server.ts`](../../apps/visualizer/backend/src/server.ts), [`app-model-install.ts`](../../apps/visualizer/backend/src/jobs/handlers/app-model-install.ts)

---

## Unconfirmed / doc gaps

- Whether **`detached: true`** `uv` on **Windows** remains in the sidecar **job object** when `set_process_group(true)`.
- Whether **Storage Sense** or similar ever reclaims Tauri **`app_cache_dir`** trees on Windows (same class of gap as [#403](https://github.com/ccanalesb/lightroom-tagger/blob/research/desktop-data-dirs/docs/research/desktop-data-dirs.md)).
- **macOS** automatic purge of **`~/Library/Caches/{identifier}`** under disk pressure (Apple documents regenerable semantics, not janitor guarantees — [#403](https://github.com/ccanalesb/lightroom-tagger/blob/research/desktop-data-dirs/docs/research/desktop-data-dirs.md)).
- **Single-instance** behaviour when **macOS socket** bind fails (plugin **logs and runs normally** — second instance possible).
- Exact **signal** sent by `SharedChild::kill` vs explicit **`killpg(SIGKILL)`** ordering when **`process_group`** is true and the group leader already exited (plugin handles **`ESRCH`** — [source](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/process/mod.rs)).
