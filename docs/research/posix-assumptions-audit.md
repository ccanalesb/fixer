# POSIX / macOS assumptions in the visualizer backend (Wayfinder #386)

Research for map [#382](https://github.com/ccanalesb/lightroom-tagger/issues/382). Audit only — fixes belong in [#391](https://github.com/ccanalesb/lightroom-tagger/issues/391). Code references are from `origin/master` at audit time (2026-10-23).

## TL;DR

- **macOS-only today:** native catalog/model folder picker (`osascript`); everything else is typed paths or future Electron ([#328](https://github.com/ccanalesb/lightroom-tagger/issues/328)).
- **NAS / UNC:** Image path resolution understands **`//server/share/...`** (Lightroom-on-macOS style) and macOS **`/Volumes`** autodetect; it does **not** map Windows **`\\server\share`**, drive-letter roots, or `config.yaml` **`mount_point`** (only env **`NAS_MOUNT_POINT`** / **`NAS_PATH_PREFIX`**). Without those env vars, Windows NAS catalogs **break** first-time cache / embed unless paths are already local.
- **Lightroom closed:** Detected via **`.lrcat.lock`** (and **`{basename}.lock`**) next to the catalog — same filenames Adobe documents for Windows and macOS; **no** process list.
- **Sync docstore write-back:** **`{catalog-stem} Sync.lrdata/{Adobe_lrMobileCatalogId}/Managed Catalog.mcat`** beside the `.lrcat` — layout matches Adobe’s sync troubleshooting paths on Windows and macOS.
- **Packaging risk:** **`REPO_ROOT`** is derived from source layout (`apps/visualizer/backend/src` → four levels up); **`uv run`** + POSIX **process-group kill** for Laya install; **`~/.cache/lightroom_tagger/vision`** default cache. Electron must set **`LT_*` env** and replace pickers.
- **Doc drift:** `docs/STORAGE_MOUNT_REQUIREMENTS.md` says the backend copies **`mount_point`** into **`NAS_MOUNT_POINT` on startup** — **not implemented** in TypeScript (grep finds no writer).

---

## Summary table

| Assumption | Where | Windows / Linux equivalent | On Windows today |
|------------|-------|----------------------------|------------------|
| Native file dialog (`osascript`) | `backend/src/utils/native-file-dialog.ts:35-36,63-93` | Electron/`dialog.showOpenDialog`, Win32 `GetOpenFileName`, typed path | **Breaks** (501 / `picker_available: false`); type path |
| `picker_available === darwin` | `backend/src/api/lt-config.ts:94`, `app-models.ts:56` | Same gate until Win dialog exists | **Breaks** for Browse button |
| Frontend path UX (POSIX `/`, `~`) | `frontend/src/hooks/useCatalogPicker.ts:36-48`, `AppModelsSection.tsx:37-38` | `\`, `%USERPROFILE%`, quoted `C:\...` | **Partial** — quote strip works; `C:\` not treated as “path UI” in models section |
| UNC resolve `//…` only | `backend/src/utils/path-resolve.ts:49-50,73-84` | `\\host\share`, mapped drive `Z:\`, `NAS_MOUNT_POINT` + prefix | **Breaks** for `\\` paths unless files exist at literal DB string |
| macOS `/Volumes` scan | `path-resolve.ts:75-80` | `net use Z:`, WSL `/mnt/...`, explicit env mapping | **N/A** on Windows (skipped); needs env |
| `mount_point` in config | `config.ts:186`, `images/common.ts:74-77` | Same idea: letter or UNC mount | **Partial** — used for **thumbnail allowlist only**, **not** `resolveFilepath` |
| `NAS_*` env only for resolve | `path-resolve.ts:52-53`; no `process.env.NAS_*` writers in repo | Set in service / Electron bootstrap | **Works** if user sets env; **unknown** if they only set `mount_point` in yaml |
| `realpath` + `root + sep` containment | `backend/src/api/images/common.ts:43-57` | Same pattern with `path.win32.sep` via Node `sep` | **Works** when roots and file paths share Windows syntax |
| Path traversal guard uses `/` | `backend/src/api/perspectives.ts:308` | `base + sep` | **Risk** on Windows if mixed separators (unconfirmed in prod) |
| `~` expansion | `config.ts:19-20,243-244`; `reader.ts:72-74` | `%USERPROFILE%` / `os.homedir()` | **Works** for `~/…` via Node `path.join` + `homedir()` |
| Default vision cache under `~/.cache/...` | `config.ts:159,192-195` | `%LOCALAPPDATA%` or `%USERPROFILE%\.cache` | **Works** (creates under user profile); not XDG on Linux if user expects `$XDG_CACHE_HOME` |
| `REPO_ROOT` from module path | `config.ts:15-17,170,206` | Install dir / `import.meta.url` / env overrides | **Breaks** if app is bundled without repo tree unless **`LT_CONFIG_YAML`**, **`LIBRARY_DB`**, etc. are set |
| Default DB/config paths relative to repo | `config.ts:54-70,170` | Same with explicit env in package | **Works** in dev clone; **unknown** in Electron |
| Catalog lock = LR closed | `lightroom/writer.ts:43-64` | Adobe `.lrcat.lock` ([helpx](https://helpx.adobe.com/lightroom-classic/kb/preference-file-and-other-file-locations.html)) | **Works** (same filenames) |
| No LR process enumeration | (not present) | Optional: tasklist / WMI | N/A — lock file only |
| Sync docstore path | `lightroom/cloud-sync/docstore.ts:55-61` | `<stem> Sync.lrdata\…\Managed Catalog.mcat` ([helpx sync KB](https://helpx.adobe.com/lightroom-classic/kb/local-sync-database.html)) | **Works** if sync enabled (path logic is OS-agnostic `join`) |
| `.lrcat` filepath = `absolutePath` + `pathFromRoot` + name | `lightroom/reader.ts:217-227` | LR stores `C:\…\` or `\\NAS\…` in `AgLibraryRootFolder.absolutePath` | **Unknown** format in Windows `.lrcat` corpus; concat assumes LR’s stored separators |
| Read-only catalog URI / locking pragmas | `lightroom/reader.ts:27-77` | Same SQLite; SMB/NAS caveats | **Unknown** on SMB from Windows |
| No WAL on `.lrcat` writes | `lightroom/writer.ts:136-140` | Same | **Works** |
| WAL on `library.db` / jobs DB | `db/connection.ts:29-30`, `db/jobs/jobs.ts:60` | SQLite WAL on NTFS | **Works** locally; **unknown** on network DB path |
| `spawn('uv', …)` | `jobs/handlers/laya-install.ts:65-68` | `uv.exe` on PATH ([uv install](https://docs.astral.sh/uv/getting-started/installation/)) | **Works** if `uv` installed; **breaks** if not |
| Process group kill (`detached`, `-pid`) | `laya-install.ts:50,67,84,113-114` | `taskkill /T` tree | **Breaks / partial** — Node: Windows throws if `pid` used to kill a process group ([process.kill](https://nodejs.org/api/process.html#processkillpid-signal)) |
| `SIGINT` / `SIGTERM` shutdown | `server.ts:65-73` | `SIGINT` Ctrl+C; `SIGBREAK`; no POSIX SIGTERM | **Partial** — graceful shutdown on Ctrl+C; SIGTERM semantics differ |
| `#!/usr/bin/env node` CLI | `cli/bin.ts:1` | npm `.cmd` shim | **Works** via npm; not a direct `./bin` on Windows |
| Dev shell scripts | `scripts/dev-cull-ui.sh`, `scripts/verify-contract.sh` | PowerShell / manual env | Dev-only; not runtime |
| Default port 5001 (AirPlay) | `config.ts:31-34`, `server.ts:4-5` | 5000 fine on Windows | **Works** (harmless default) |
| Laya folder source must match `/^[/~.]/` | `laya/install.ts:47-50` | `C:\` or `\\` folder paths | **Breaks** for typical Windows pasted paths |
| Finder “Copy as Pathname” quotes | `useCatalogPicker.ts:36-48`, `laya/install.ts:38-42` | Explorer copy path | **Partial** — quotes yes; Windows path shape in model parser no |

---

## Lightroom Classic on Windows (primary sources)

Adobe documents **default catalog folder**, **lock file**, and related sidecar paths on Windows (custom locations stay valid if the user moved the catalog):

| Artifact | Default Windows location (Adobe) |
|----------|----------------------------------|
| Catalog (`.lrcat`) | `C:\Users\[user name]\Pictures\Lightroom\Lightroom Catalog.lrcat` |
| Catalog folder | `C:\Users\[user name]\Pictures\Lightroom` |
| Lock file | `…\Lightroom Catalog.lrcat.lock` while LR is open |
| Previews | `…\Lightroom Catalog Previews.lrdata` |
| Sync data folder | **`{catalog name} Sync.lrdata`** next to the `.lrcat` (same folder as catalog) |

Sources:

- [Preference file and other file locations (Lightroom Classic)](https://helpx.adobe.com/lightroom-classic/kb/preference-file-and-other-file-locations.html) — catalog, lock, previews, journal, backups.
- [Catalog FAQ — default catalog folder](https://helpx.adobe.com/lightroom-classic/kb/catalog-faq-lightroom.html) — `\Users\[user name]\Pictures\Lightroom`.
- [Error: catalog cannot be opened (`.lrcat.lock`)](https://helpx.adobe.com/lightroom-classic/kb/lightroom-error-catalog-cannot-be-opened-lrcat-lock.html) — lock file behavior on quit vs crash.
- [Local sync database damaged](https://helpx.adobe.com/lightroom-classic/kb/local-sync-database.html) — `… Sync.lrdata\…\Managed Catalog.mcat` / `.wfindex` under the catalog directory.

**Backend alignment:** `catalogLockCandidates()` builds `{stem}.lrcat-lock` and `{fullBasename}.lock` (`writer.ts:43-47`), matching Adobe’s `Lightroom Catalog.lrcat.lock` pattern. Cloud docstore uses `{stem} Sync.lrdata/{Adobe_lrMobileCatalogId}/Managed Catalog.mcat` (`docstore.ts:55-61`), matching Adobe’s “beside the catalog” sync layout.

---

## Details by area

### 1. Native catalog / folder picker (macOS-only)

ADR [0019](../adr/0019-backend-is-always-local-only-the-ui-travels.md) explicitly adopts `POST /api/config/catalog/pick` via **`osascript`** (macOS-only). Implementation:

- Availability: `process.platform === 'darwin'` (`native-file-dialog.ts:35-36`).
- Dialog: `execFile('osascript', …)` with AppleScript `choose file` / `choose folder` (`native-file-dialog.ts:53-93`).
- API: returns **501** when unavailable (`lt-config.ts:116-124`); **`picker_available`** on GET catalog (`lt-config.ts:94`).
- Frontend gates the button with **`picker_available && browserIsOnBackendHost`** (`useCatalogPicker.ts:82-84`) — loopback-only co-location heuristic.

**Windows equivalent:** Electron `dialog.showOpenDialog` or typed path (already supported by PUT `/api/config/catalog` with `expandUserPath` validation).

**Linux:** Same as Windows — type path; no native dialog in backend.

### 2. Path handling, UNC, mounts, containment

**Stored image paths** come from Lightroom as concatenated roots (`reader.ts:225-227`). Production macOS/NAS corpora use **`//host/share/...`** (see ADR 0019). **`resolveFilepath`** (`path-resolve.ts:49-86`):

1. Returns non-`//` paths unchanged (so **`C:\`**, **`\\NAS\`**, and local paths pass through verbatim).
2. For `//…`, maps via **`NAS_PATH_PREFIX`** + **`NAS_MOUNT_POINT`**, else scans **`/Volumes`** (macOS only).
3. If nothing matches, returns configured guess or original `//…` (caller must check existence — documented in `STORAGE_MOUNT_REQUIREMENTS.md`).

**Gap — `mount_point` in `config.yaml`:** Loaded as `LibraryConfig.mountPoint` (`config.ts:186`) and included in **thumbnail root allowlist** (`images/common.ts:74-77`) but **never** copied into `process.env.NAS_MOUNT_POINT`. The storage doc’s “on startup, copy mount_point” statement is **not implemented** in the TS backend (only `path-resolve.ts` reads `NAS_*`). Users who only set yaml **`mount_point`** get thumbnail serving under that root but **not** automatic UNC resolution for jobs.

**Windows UNC:** Catalogs that store **`\\10.x.x.x\share\...`** will not enter the `//` branch; resolution depends on the path being directly readable (drive mapping) or manual env mapping designed for `//` prefix (may require prefix alignment — **unconfirmed** for mixed corpora).

**Containment (`isPathUnderAllowedRoots`):** Uses `realpathSync` and `startsWith(root + sep)` (`images/common.ts:43-57`). Node’s `sep` is `\` on Windows — correct for same-format paths. Symlink escape is handled on platforms where `realpathSync` works.

**`resolveCatalogPath` naming:** Resolves **image filepaths**, not the `.lrcat` path (`CONTEXT.md` glossary).

### 3. `AgLibraryRootFolder.absolutePath` on Windows

The reader does not normalize separators; it trusts Lightroom’s stored `absolutePath` and `pathFromRoot` (`reader.ts:217-227`). Adobe docs describe **where files live on disk**, not the exact SQLite string format.

**Unconfirmed:** Whether Windows catalogs always use backslashes, drive letters, or `\\` UNC in `absolutePath` for NAS volumes. Internal plan notes reference a catalog at `C:\Users\…\Pictures\Lightroom\…` via WSL (`docs/plans/2026-03-18-lightroom-writer-fix.md`) but do not quote `absolutePath` rows.

**Cross-platform catalog reuse:** A catalog last synced on macOS may still contain `//10.x/...` paths while the Windows host expects `\\10.x\...` or `Z:\` — resolver and existence checks behave differently (**likely pain point** for #382).

### 4. Lightroom closed detection

- **Mechanism:** Presence of lock files (`writer.ts:59-64`), checked before writes (`raiseIfCatalogLocked`) and during write-back batches (`writeback.ts:147-148`).
- **Not used:** Process list, Lightroom executable name, or SQLite “database locked” as “LR open” (SQLite lock is handled separately in `catalog-sync.ts` for concurrent access while LR runs).

Adobe: lock file created while catalog open, removed on normal quit ([lock file KB](https://helpx.adobe.com/lightroom-classic/kb/lightroom-error-catalog-cannot-be-opened-lrcat-lock.html)).

### 5. Sync docstore (write-back cloud revisions)

Write-back opens **`Managed Catalog.mcat`** via `cloudDocstorePath()` (`docstore.ts:55-61`) using catalog variable **`Adobe_lrMobileCatalogId`**. Backups of `.mcat` sit **next to** catalog backups, not inside `Sync.lrdata` (`docstore.ts:64-72`). Requires Lightroom **closed** (same lock gate as `.lrcat`).

Windows path shape: same relative layout under the catalog directory ([local sync database KB](https://helpx.adobe.com/lightroom-classic/kb/local-sync-database.html)).

### 6. Config, `~`, defaults, `REPO_ROOT`

- **`expandUserPath`:** Leading `~` only (`config.ts:19-20`) — not full `~user` POSIX form.
- **Relative paths** in yaml resolve against **`REPO_ROOT`** (`config.ts:23-26`) — e.g. `library.db`, `models`, `config.yaml`.
- **`REPO_ROOT`:** Four directories above `backend/src` (`config.ts:15-17`). Prompts, Laya script path, and seeds use it (`bootstrap.ts:593`, `laya-install.ts:22`, `providers/registry.ts:16`).
- **Vision cache default:** `join(homedir(), '.cache', 'lightroom_tagger', 'vision')` (`config.ts:159`) — XDG **`$XDG_CACHE_HOME`** not honored unless user sets **`vision_cache_dir`**.

### 7. `uv`, Python script, signals, locking

- **Laya install:** `spawn('uv', ['run', join(REPO_ROOT, 'scripts/laya/export_onnx.py'), …], { cwd: REPO_ROOT, detached: true })` (`laya-install.ts:22-68`).
- **Cancel:** `process.kill(-pid, 'SIGTERM')` on process group (`laya-install.ts:47-54,84,113-114`). Node documents that **using `pid` to kill a process group throws on Windows** ([process.kill](https://nodejs.org/api/process.html#processkillpid-signal)).
- **Server shutdown:** `SIGINT` / `SIGTERM` handlers (`server.ts:65-73`); POSIX-centric but Ctrl+C works on Windows console.
- **SQLite:** App DBs use WAL + busy timeout (`connection.ts:29-33`). Lightroom `.lrcat` writes avoid WAL mode switch (`writer.ts:136-140`). Catalog **reads** use readonly URI by default (`reader.ts:27-30`).

### 8. Frontend path assumptions

- Catalog paste normalization: macOS Finder quotes (`useCatalogPicker.ts:36-48`).
- Model source display: paths starting with **`/`** or **`~`** only (`AppModelsSection.tsx:37-38`) — Windows **`C:\`** shows as plain text (cosmetic).
- No hardcoded `/Users` in production frontend paths (tests use POSIX examples).

### 9. Scripts spawned by backend vs dev-only

| Script | Role | Windows |
|--------|------|---------|
| `osascript` | Runtime picker | Not used |
| `uv run scripts/laya/export_onnx.py` | Runtime model install | Needs `uv` + Python; paths via `REPO_ROOT` |
| `dev-cull-ui.sh`, `verify-contract.sh` | Dev/CI | Bash — not invoked by backend |

---

## Unconfirmed / needs empirical Windows run

1. Exact **`AgLibraryRootFolder.absolutePath`** strings for local disk vs NAS on Lightroom Classic Windows (same catalog as macOS `//10.88…` corpus).
2. Whether **`realpathSync`** + thumbnail roots behave when **`library.db` paths use `/`** but disk uses `\` (or vice versa).
3. **SQLite WAL** on `library.db` / `visualizer.db` when Electron puts them on OneDrive / SMB.
4. **Process-group cancellation** of `uv` on Windows (likely broken today).
5. End-to-end **write-back + cloud docstore** on a Windows-default **`Pictures\Lightroom`** catalog with sync enabled.

---

## Related docs

- [ADR 0019 — backend local-only, osascript picker](../adr/0019-backend-is-always-local-only-the-ui-travels.md)
- [Catalog read vs write](../CATALOG_READ_WRITE.md)
- [Storage and mount requirements](../STORAGE_MOUNT_REQUIREMENTS.md) (note `mount_point` → env claim vs code)
- [Visualizer CONTEXT](../../apps/visualizer/CONTEXT.md)
