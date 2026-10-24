# Desktop app data directories (Electron, macOS / Windows / Linux)

Research for Wayfinder ticket [#403](https://github.com/ccanalesb/lightroom-tagger/issues/403) (map [#382](https://github.com/ccanalesb/lightroom-tagger/issues/382)). Final placement is for grilling ticket [#388](https://github.com/ccanalesb/lightroom-tagger/issues/388).

**Today (CLI / dev):** repo-root `config.yaml`, SQLite DBs beside it, vision cache default `~/.cache/lightroom_tagger/vision` ([`apps/visualizer/backend/src/config.ts`](../../apps/visualizer/backend/src/config.ts)).

**Desktop payload (order of magnitude):** `config.yaml` (small), `library.db` (~600 MB, WAL), `visualizer.db`, `models/` (~0.4–0.8 GB each), vision cache (~4 GB, ~43k JPEGs, regenerable but expensive).

---

## TL;DR

- **Electron defaults put almost everything under Roaming `%APPDATA%` on Windows** (`userData`, and also `userCache` — see below). That folder is a poor home for **600 MB+ SQLite WAL** and **multi‑GB caches**: roaming profiles, Folder Redirection, and OneDrive/Desktop backup can sync or relocate it; SQLite explicitly warns against network and unreliable locking paths ([lockingv3](https://www.sqlite.org/lockingv3.html), [WAL](https://www.sqlite.org/wal.html), [FAQ #5](https://www.sqlite.org/faq.html)).
- **Electron’s own docs say:** do not put large files in `userData`; some environments back it up to cloud ([`app.getPath`](https://www.electronjs.org/docs/latest/api/app#appgetpathname)). Redirect **`sessionData`** away from `userData` before `ready` so Chromium’s disk cache does not bloat the same tree ([same doc](https://www.electronjs.org/docs/latest/api/app#appgetpathname)).
- **`cache` / `userCache` still exist in Electron’s implementation** but are **omitted from the public `getPath` name list** in current docs; paths are defined in source ([`electron_api_app.cc`](https://github.com/electron/electron/blob/main/shell/browser/api/electron_api_app.cc), [`electron_paths.cc`](https://github.com/electron/electron/blob/main/shell/common/electron_paths.cc)).
- **macOS:** durable data → `Application Support`; regenerable bulk → `Caches` ([Apple Library guide](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/MacOSXDirectories/MacOSXDirectories.html)). Apple treats cache as **regenerable; apps must not rely on files persisting** — no documented guarantee that the OS will purge `~/Library/Caches` under disk pressure for third-party apps (**unconfirmed** for arbitrary purge behavior; see Apple `Caches` row in linked doc).
- **Windows Storage Sense** cleans **user temporary files not in use** (typically `%LOCALAPPDATA%\Temp`), not arbitrary `%LOCALAPPDATA%\YourApp` trees ([Storage Sense](https://learn.microsoft.com/en-us/windows/configuration/storage/storage-sense), [AllowStorageSenseTemporaryFilesCleanup](https://learn.microsoft.com/en-us/windows/client-management/mdm/policy-csp-storage)). Do not store durable DBs under `app.getPath('temp')`.
- **Linux / AppImage:** Electron maps `appData` → `$XDG_CONFIG_HOME` (~/.config), not `$XDG_DATA_HOME` ([Electron docs](https://www.electronjs.org/docs/latest/api/app#appgetpathname); [XDG summary](https://wiki.archlinux.org/title/XDG_Base_Directory)). AppImage does not relocate data unless **portable mode** dirs exist ([portable mode](https://docs.appimage.org/user-guide/portable-mode.html)). Uninstall = delete the AppImage; **user data remains** in XDG dirs ([FAQ](https://docs.appimage.org/user-guide/faq.html)).
- **Uninstall:** **DMG / drag-to-trash** → `.app` only; **NSIS** removes install dir; **`deleteAppDataOnUninstall`** (one-click only, default `false`) removes **`%APPDATA%\<app names>`** only — not `%LOCALAPPDATA%` ([NSIS options](https://www.electron.build/nsis.html), [uninstaller template](https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/templates/nsis/uninstaller.nsh)).
- **User-chosen folder:** `app.setPath('userData', …)` / `--user-data-dir` before `ready`; or keep a **single “library root”** path in `config.yaml` (already used for `vision_cache_dir`, `catalog_path`) while leaving Electron defaults for UI-only state.
- **Never** place SQLite WAL on iCloud Drive, OneDrive, Dropbox, or SMB/NFS paths used like a local disk ([SQLite WAL](https://www.sqlite.org/wal.html), [lockingv3](https://www.sqlite.org/lockingv3.html)).

### Placement options (for #388)

| Option | Idea | Pros | Cons |
|--------|------|------|------|
| **A — Electron defaults + subdirs** | Small config under `userData`; put `library.db`, `models/`, vision cache in `userData/data/` (or `userCache` on macOS/Linux only) | Familiar paths; easy support | **Windows:** defaults = Roaming; multi-GB in `%APPDATA%` fights profile sync/redirect; `userCache` == `userData` on Windows (same Roaming subfolder per source) |
| **B — OS-native heavy data** | Config in `userData`; **durable/large** under `%LOCALAPPDATA%\<App>\` (Win), `~/Library/Application Support/<id>/` (mac), `$XDG_DATA_HOME/<id>/` (Linux) via explicit paths (not Electron’s default `userData` on Win) | Matches Microsoft “local app data” intent ([store app data](https://learn.microsoft.com/en-us/windows/apps/develop/data/store-and-retrieve-app-data)); avoids Roaming | Must implement path helper; don’t assume `app.getPath('userData')` for DBs on Windows |
| **C — User library root** | One picker (NAS-friendly): `config.yaml`, both DBs, `models/`, vision cache under e.g. `~/Pictures/LightroomTagger/` | Matches pro photo workflows; same as today’s mental model | User must choose/back up; must block cloud-synced folders; onboarding required |

**Research lean:** **B + optional C override** — default heavy data to **local, non-roaming, non-synced** OS locations; allow **C** for NAS/power users; keep Electron `userData` for small app prefs + redirect `sessionData`.

---

## 1. Electron `app.getPath` (documented names)

Source of truth: [Electron `app.getPath` / `app.setPath`](https://www.electronjs.org/docs/latest/api/app#appgetpathname) (retrieved 2026-10-24) and [Electron path implementation](https://github.com/electron/electron/blob/main/shell/common/electron_paths.cc).

Let `<AppName>` = `app.getName()` (from `package.json` `name` / `productName` rules in docs).

| Name | macOS | Windows | Linux |
|------|-------|---------|-------|
| **`appData`** | `~/Library/Application Support` | `%APPDATA%` → `~\AppData\Roaming` ([FOLDERID_RoamingAppData](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid#folderid_roamingappdata)) | `$XDG_CONFIG_HOME` or `~/.config` |
| **`userData`** | `appData/<AppName>` | `%APPDATA%\<AppName>` | `~/.config/<AppName>` |
| **`sessionData`** | defaults to **`userData`** | same | same |
| **`temp`** | OS temp dir | `%TEMP%` / `%TMP%` (typically under `%LOCALAPPDATA%\Temp`) | `$TMPDIR` etc. |
| **`logs`** | `~/Library/Logs/<AppName>` if `setAppLogsPath()` default | `<userData>/logs` | `<userData>/logs` |
| **`home`**, **`documents`**, **`downloads`**, … | Standard user folders | Standard KNOWNFOLDER paths | XDG/user dirs |

**Documented guidance (Electron):**

- Prefer a **subdirectory** of `userData` for app files; avoid colliding with Chromium’s `Cache`, `GPUCache`, `Local Storage`.
- **Not recommended** to write **large** files to `userData` — **may be backed up to cloud** in some environments.
- Set **`sessionData`** to another location before `app.ready` if you do not need browser storage — Chromium may write **very large** cache under `sessionData`.

**CLI:** Chromium/Electron honor **`--user-data-dir=`** (absolute); Electron applies it to `userData` ([`app.ts` init](https://github.com/electron/electron/blob/main/lib/browser/api/app.ts) via `_setDefaultAppPaths` in bundled code path — see Electron source tree).

---

## 2. `cache` and `userCache` (implementation; underdocumented)

These names are wired in [`GetPathConstant`](https://github.com/electron/electron/blob/main/shell/browser/api/electron_api_app.cc) and [`DIR_USER_CACHE`](https://github.com/electron/electron/blob/main/shell/common/electron_paths.cc) but **are not listed** in the current online `app.getPath` bullet list ([docs gap](https://www.electronjs.org/docs/latest/api/app#appgetpathname)).

| Name | macOS | Windows | Linux |
|------|-------|---------|-------|
| **`cache`** | `~/Library/Caches` ([`NSCachesDirectory`](https://github.com/chromium/chromium/blob/main/base/base_paths_mac.mm)) | **`%APPDATA%`** (Roaming root — “no universal cache location”) | `$XDG_CACHE_HOME` or `~/.cache` |
| **`userCache`** | `~/Library/Caches/<AppName>` | **`%APPDATA%\<AppName>`** (same Roaming subtree as `userData`) | `~/.cache/<AppName>` |

**Windows surprise:** Electron stores **`userCache` under Roaming `%APPDATA%`**, not `%LOCALAPPDATA%`, explicitly because “there’s no OS-level centralized location for caches” ([`electron_paths.cc` comment](https://github.com/electron/electron/blob/main/shell/common/electron_paths.cc)). So **`userData` and `userCache` resolve to the same directory on Windows** (both `%APPDATA%\<AppName>`).

**Implication for this app:** Do **not** assume `app.getPath('userCache')` gives a LocalAppData cache on Windows. For multi-GB vision cache, use an **app-defined path** under `%LOCALAPPDATA%` (Option B) or user library (Option C).

---

## 3. Windows: Roaming vs Local, profiles, and size

| Variable / folder | Typical path | Roams / redirects? | Fit for this app |
|-------------------|--------------|--------------------|------------------|
| **`%APPDATA%`** (Electron `appData`, `userData`) | `~\AppData\Roaming` | Yes — default target for **Folder Redirection “AppData/Roaming”** ([GPO list](https://learn.microsoft.com/en-us/windows-server/storage/folder-redirection/folder-redirection-using-group-policy)); enterprise roaming copies at logoff | **Bad** for 600 MB DB + GB caches (slow logon, quota policies) |
| **`%LOCALAPPDATA%`** | `~\AppData\Local` | **Does not roam** with classic profiles ([Vista+ AppData structure](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-vista/cc766489(v=ws.10))) | **Good** for SQLite + large cache ([local app data guidance](https://learn.microsoft.com/en-us/windows/apps/develop/data/store-and-retrieve-app-data)) |
| **`%TEMP%`** | Usually `~\AppData\Local\Temp` | N/A | **Ephemeral** — Storage Sense deletes unused temp files ([policy CSP](https://learn.microsoft.com/en-us/windows/client-management/mdm/policy-csp-storage)) |

**Roaming profile size:** Administrators can set **“Limit profile size”** (MB) via Group Policy; exceeding limits can block profile sync at logoff ([2003 profile GPO doc](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2003/cc781862(v=ws.10)), [slow-link tuning](https://learn.microsoft.com/en-us/troubleshoot/windows-server/user-profiles-and-logon/manage-profile-service-slow-link-detection)). Exact limits are **org-specific**, not a fixed OS cap.

**UWP note:** “Roaming data” for Store apps is deprecated (Windows 11+); **LocalSettings / LocalFolder** recommended for durable prefs ([store app data](https://learn.microsoft.com/en-us/windows/apps/develop/data/store-and-retrieve-app-data)). Electron is not UWP but the **Local vs Roaming** split still applies to `%APPDATA%` vs `%LOCALAPPDATA%`.

**Storage Sense vs app data:** Documented cleanup targets include **temporary files**, Recycle Bin, Downloads (optional), cloud offload — **not** generic `%LOCALAPPDATA%\Publisher\App` trees ([Storage Sense overview](https://learn.microsoft.com/en-us/windows/configuration/storage/storage-sense)). **Disk Cleanup (`cleanmgr`)** is separate from Storage Sense (**unconfirmed** overlap for custom app folders; community answers say Storage Sense does not run legacy “device cleanup handlers”).

---

## 4. macOS: Application Support vs Caches vs purge behavior

Apple’s [Library directory guide](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/MacOSXDirectories/MacOSXDirectories.html):

- **`Application Support/<bundle id>/`** — app-specific **data and support**; user data; app creates as needed.
- **`Caches/<bundle id>/`** — **regenerable** cache; **“Apps should never rely on the existence of cache files.”**

**Logs:** Electron defaults to `~/Library/Logs/<AppName>` ([`app.setAppLogsPath`](https://www.electronjs.org/docs/latest/api/app#appsetapplogspathpath)).

**Purge under storage pressure:** Apple documents purgeable **memory** caches ([Caching and Purgeable Memory](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/ManagingMemory/Articles/CachingandPurgeableMemory.html)); **disk** cache eviction for third-party `~/Library/Caches` is **not** specified in the cited File System Programming Guide (**unconfirmed** whether macOS deletes arbitrary app cache files when disk is full). Treat vision cache as **precious unless user opts into “cache” location**.

**iCloud:** Placing `Application Support` or `Documents` under iCloud Desktop & Documents sync is equivalent to a **cloud-backed filesystem** for SQLite — avoid ([SQLite network guidance](https://www.sqlite.org/lockingv3.html)).

---

## 5. Linux: XDG and AppImage

**XDG base dirs** ([ArchWiki summary of spec](https://wiki.archlinux.org/title/XDG_Base_Directory)):

| XDG | Default | Typical use |
|-----|---------|-------------|
| `XDG_CONFIG_HOME` | `~/.config` | Config (Electron **`appData` / `userData`**) |
| `XDG_DATA_HOME` | `~/.local/share` | Databases, models ( **not** Electron default for `userData`) |
| `XDG_CACHE_HOME` | `~/.cache` | Regenerable cache (Electron **`cache` / `userCache`**) |
| `XDG_STATE_HOME` | `~/.local/state` | Logs/state (spec default) |

**AppImage:**

- Binary can live anywhere ([FAQ](https://docs.appimage.org/user-guide/faq.html)).
- **No uninstall step** — removing the file removes the app; **data stays** in `$HOME` / XDG paths.
- **Portable mode:** sibling dirs `<AppImage>.config` → sets `XDG_CONFIG_HOME`; `<AppImage>.home` → sets `HOME` ([portable mode](https://docs.appimage.org/user-guide/portable-mode.html)). Does **not** automatically relocate `$XDG_DATA_HOME` or `$XDG_CACHE_HOME` unless `.home` redirects all of `$HOME`.

**FHS alignment for Option B on Linux:** store `library.db`, `models/`, vision cache under `$XDG_DATA_HOME/<app-id>/` and `$XDG_CACHE_HOME/<app-id>/vision` rather than under `~/.config/<AppName>/`.

---

## 6. SQLite (WAL) on network and cloud-synced folders

| Source | Guidance |
|--------|----------|
| [WAL](https://www.sqlite.org/wal.html) | **“WAL does not work over a network filesystem.”** Requires shared memory (`wal-index`) on one host. |
| [lockingv3](https://www.sqlite.org/lockingv3.html) | **“Your best defense is to not use SQLite for files on a network filesystem.”** POSIX locks broken on many NFS implementations; **Windows network locking “very buggy”**. |
| [FAQ #5](https://www.sqlite.org/faq.html) | Avoid SQLite on **NFS**; **Windows network file locking** unreliable for multi-process access. |

**Cloud sync clients** (iCloud, OneDrive, Dropbox): treat as **unsafe** for live WAL — same class as network FS (file locking + partial sync + conflict copies). **Unconfirmed:** single-writer, fully local sync with no other devices might work in practice; **not supported** by SQLite guidance.

**NAS:** Acceptable only if the OS presents a **local** filesystem with working POSIX/fcntl locks and **no** cloud sync layer; still higher risk than local SSD. Prefer **Option C** with explicit user acknowledgment.

---

## 7. Letting the user choose a data folder (patterns)

| Mechanism | Source | Notes |
|-----------|--------|-------|
| **`app.setPath('userData', absPath)`** before `ready` | [Electron `setPath`](https://www.electronjs.org/docs/latest/api/app#appsetpathname-path) | Moves **entire** Electron profile (Chromium dirs too) |
| **`--user-data-dir=`** | Electron/Chromium | Same as above; useful for support |
| **Config key for “library root”** | This repo already (`catalog_path`, `vision_cache_dir` in `config.yaml`) | Backend stays path-driven ([`config.ts`](../../apps/visualizer/backend/src/config.ts)); desktop shell writes YAML |
| **Native folder picker** | Platform API via Electron `dialog.showOpenDialog` | **Unconfirmed** in repo; standard Electron pattern (not duplicated here — see Electron dialog docs if implementing) |
| **AppImage portable dirs** | [Portable mode](https://docs.appimage.org/user-guide/portable-mode.html) | USB / self-contained **config** only unless `.home` used |

**Validation to implement (product, not research):** reject paths under known sync roots where detectable; warn on SMB/NFS; document single-writer expectation.

---

## 8. What uninstall removes

| Installer | App binary | User data |
|-----------|------------|-----------|
| **macOS DMG** (drag to Applications, trash) | `.app` bundle removed | **`~/Library/Application Support/<AppName>`** and caches **remain** (no electron-builder uninstall hook unless separate) — standard macOS expectation; Apple stores durable data under Application Support ([Library guide](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/MacOSXDirectories/MacOSXDirectories.html)) |
| **NSIS** (electron-builder) | `$INSTDIR` removed ([uninstaller](https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/templates/nsis/uninstaller.nsh)) | **`deleteAppDataOnUninstall: true`** → `RMDir /r "$APPDATA\${APP_FILENAME}"` (+ product/package name variants). **Only `%APPDATA%` (Roaming).** Default **`false`** ([NSIS doc](https://www.electron.build/nsis.html)). **One-click installer only.** Does **not** remove `%LOCALAPPDATA%` custom paths |
| **AppImage** | Delete file | XDG / `$HOME` data **unchanged** ([FAQ](https://docs.appimage.org/user-guide/faq.html)) |
| **zip** (mac/win portable) | Delete folder | Same as DMG/manual — data wherever app wrote it |

If heavy data lives under **`%LOCALAPPDATA%`** (Option B), **NSIS will not delete it** unless you add custom NSIS macros ([customUnInstall](https://www.electron.build/nsis.html)).

---

## 9. Mapping this app’s artifacts (draft)

| Artifact | Regenerable? | Suggested class | Default location sketch |
|----------|--------------|-----------------|-------------------------|
| `config.yaml` | No | Config | With library root (C) or small prefs in `userData` |
| `library.db` (+ `-wal`, `-shm`) | No | Durable local DB | **Local** FS only; Option B or C |
| `visualizer.db` | No | Durable local DB | Same |
| `models/` | Re-downloadable | Large durable / semi-cache | Local disk; not Roaming |
| Vision cache (~4 GB) | Yes (expensive) | Cache | `userCache` OK on **macOS/Linux**; on **Windows** use `%LOCALAPPDATA%\<id>\cache\vision` not `%APPDATA%` |
| Electron/Chromium session cache | Yes | Cache | Separate `sessionData` dir ([Electron guidance](https://www.electronjs.org/docs/latest/api/app#appgetpathname)) |
| Logs | Yes | Logs | Electron `logs` path |

---

## 10. Citations index

- Electron: https://www.electronjs.org/docs/latest/api/app#appgetpathname  
- Electron source: https://github.com/electron/electron/blob/main/shell/common/electron_paths.cc , https://github.com/electron/electron/blob/main/shell/browser/api/electron_api_app.cc  
- Apple Library: https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/MacOSXDirectories/MacOSXDirectories.html  
- Windows folders: https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid  
- Windows local/roaming app data: https://learn.microsoft.com/en-us/windows/apps/develop/data/store-and-retrieve-app-data  
- Folder Redirection: https://learn.microsoft.com/en-us/windows-server/storage/folder-redirection/folder-redirection-using-group-policy  
- Storage Sense: https://learn.microsoft.com/en-us/windows/configuration/storage/storage-sense  
- XDG (summary): https://wiki.archlinux.org/title/XDG_Base_Directory  
- AppImage portable: https://docs.appimage.org/user-guide/portable-mode.html , FAQ: https://docs.appimage.org/user-guide/faq.html  
- SQLite: https://www.sqlite.org/wal.html , https://www.sqlite.org/lockingv3.html , https://www.sqlite.org/faq.html  
- electron-builder NSIS: https://www.electron.build/nsis.html , uninstaller: https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/templates/nsis/uninstaller.nsh  

---

## Unconfirmed / doc gaps

- Whether **macOS** automatically deletes third-party files in `~/Library/Caches` under **disk** pressure (Apple only clearly documents regenerable *semantics*, not OS janitor behavior).
- Whether **Storage Sense** ever touches non-temp directories under `%LOCALAPPDATA%` for desktop Win32 apps (primary docs emphasize temp/recycle/downloads/cloud).
- Exact **`cache` / `userCache`** stability as public API given omission from Electron doc name list (still present in source as of 2026-10-24).
