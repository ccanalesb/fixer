# Tauri 2 + Node 24 sidecar vs Electron 45 (wayfinder #412)

Research date: **2026-10-24**. Question: re-check [#328](https://github.com/ccanalesb/lightroom-tagger/issues/328)’s Tauri rejection now that [#401](https://github.com/ccanalesb/lightroom-tagger/issues/401) measured **~798 MB / ~859 MB / ~1.1 GB** Electron 45 packages with the backend as a child process. **No product build in this ticket** — parallel spike [#413](https://github.com/ccanalesb/lightroom-tagger/issues/413) will measure a real Tauri sidecar artifact.

Method: map research branches, Tauri 2 / Electron 45 primary docs, Microsoft / Apple distribution docs, and labeled secondary benchmarks. **Unconfirmed** where not measured on this repo.

---

## TL;DR

- **#328 still holds on size:** packaged weight is dominated by **backend `node_modules`** (onnxruntime-node, sharp/libvips, sqlite stack), not the UI shell. Electron 45’s **Chromium stack is ~115–151 MB compressed** per platform ([Electron v45.0.0 release assets](https://github.com/electron/electron/releases/tag/v45.0.0)); unpacked in a full app it is often **~180–250+ MB** of the total (**unconfirmed** split inside our spike tree). Tauri drops bundled Chromium but must ship a **standalone Node 24 binary (~53 MB compressed per [nodejs.org dist](https://nodejs.org/dist/v24.22.1/))** plus the **same** native `node_modules` tree. Expect **~15–25% smaller installers**, not half — **model until #413 lands**.
- **Memory:** ONNX + job workers + SQLite in the **Node sidecar** dominate RSS either way. System-webview shells save UI RAM on **macOS/Linux** in many benchmarks; on **Windows** WebView2 (Chromium) often makes Tauri ≈ Electron for idle UI (**secondary sources**, [Hopp Apr 2025](https://www.gethopp.app/blog/tauri-vs-electron), [web-to-desktop-framework-comparison](https://github.com/Elanis/web-to-desktop-framework-comparison)). Treat “Tauri is lighter” as **shell-only**, not end-to-end for this app.
- **Best SPA fit for this product:** load **`http://127.0.0.1:<port>`** from the webview (`WebviewUrl::External` in Tauri; `BrowserWindow.loadURL` in Electron) so the **same Hono + static SPA + socket.io** path as “open in browser” ([#402](https://github.com/ccanalesb/lightroom-tagger/issues/402)). Avoid `tauri://` / custom-protocol-only UI unless you want split-origin CORS work ([Tauri CSP](https://v2.tauri.app/security/csp/)).
- **Native catalog picker:** both can return real paths — Electron `dialog.showOpenDialog` ([#328](https://github.com/ccanalesb/lightroom-tagger/issues/328)); Tauri `tauri-plugin-dialog` returns `FilePath::Path(PathBuf)` on desktop ([docs.rs `FilePath`](https://docs.rs/tauri-plugin-dialog/latest/tauri_plugin_dialog/enum.FilePath.html)).
- **Unsigned v1 updates:** **Electron** — in-app auto-update **closed on macOS** (Squirrel / `autoUpdater` needs proper signing) per [unsigned Electron research](https://github.com/ccanalesb/lightroom-tagger/blob/research/unsigned-electron/docs/research/unsigned-electron-install.md); **open on Windows NSIS + Linux AppImage** with manifest signing. **Tauri** — **`tauri-plugin-updater` always verifies minisign** on update artifacts ([Updater plugin](https://v2.tauri.app/plugin/updater/)); that is **independent of Apple/Authenticode**, so **in-app update can work on unsigned/ad-hoc macOS** if CI holds `TAURI_SIGNING_PRIVATE_KEY` — but **Gatekeeper may still challenge a replaced `.app`** (**unconfirmed** for semver bumps + same bundle ID; plan user docs like “Open Anyway” on [#383](https://github.com/ccanalesb/lightroom-tagger/issues/383)).
- **Gatekeeper / SmartScreen / SAC:** **No meaningful advantage to Tauri** for unsigned v1 — same ad-hoc / SmartScreen friction; SAC still blocks unsigned PE trees ([#408](https://github.com/ccanalesb/lightroom-tagger/issues/408)). Tauri must set **`bundle.macOS.signingIdentity: "-"`** to avoid “damaged” bundles ([macOS code signing](https://v2.tauri.app/distribute/sign/macos/), [hole#364](https://github.com/bindreams/hole/issues/364)).
- **Sidecar mechanics:** Tauri **`externalBin`** requires **`name-$TARGET_TRIPLE[.exe]`** per arch ([Sidecar](https://v2.tauri.app/develop/sidecar/)); **`bundle.resources`** (or macOS `files`) holds **`node_modules` + backend `dist/`**, not the sidecar list. Windows **process-tree kill** (`taskkill /T`) still required for `uv`/job children ([#402](https://github.com/ccanalesb/lightroom-tagger/issues/402)). **`tauri-plugin-single-instance`** matches backend `refuseIfPortInUse` ([Single Instance](https://v2.tauri.app/plugin/single-instance/)).
- **CI / toolchain:** Tauri adds **Rust + `webkit2gtk-4.1-dev`** on Linux ([Prerequisites](https://v2.tauri.app/start/prerequisites/)), **`tauri-apps/tauri-action`**, longer cold builds vs **electron-builder-only** matrix ([#407](https://github.com/ccanalesb/lightroom-tagger/issues/407)). Electron spike already **passes all three OSes** without `@electron/rebuild` ([#401](https://github.com/ccanalesb/lightroom-tagger/issues/401)).
- **Recommendation:** **Stay on Electron 45** for v1 destination ([#382](https://github.com/ccanalesb/lightroom-tagger/issues/382)). The map’s research, spike, and `ELECTRON_RUN_AS_NODE` child model are paid for; Tauri trades **modest size** for **Rust/Linux webview/CI complexity** without removing Node. **Do not change the map destination** on this ticket alone; revisit only if **#413** shows larger savings or a hard Electron blocker.

---

## Comparison table (Oct 2026 facts)

| Topic | Electron 45 (this app’s planned shape) | Tauri 2 + Node 24 sidecar | Notes |
|--------|----------------------------------------|-----------------------------|--------|
| **Stable stack** | Electron **45.0.0**, Chromium **156**, Node **24.22** ([releases](https://releases.electronjs.org/release/v45.0.0)) | Tauri **2.x** stable; plugins on **MSRV ≥ 1.90** ([Updater](https://v2.tauri.app/plugin/updater/)) | |
| **Packaged size (measured / modeled)** | **~798 / ~859 / ~1.1 GB** dir packages ([#401 spike](https://github.com/ccanalesb/lightroom-tagger/blob/spike/electron-addons/docs/research/spike-electron-addons.md)) | **Unmeasured here**; model **~650–900 MB** same backend + **~100 MB Node** + **~10–30 MB** Rust shell − **~150–250 MB** no bundled Chromium | **#413** |
| **Chromium / web engine in artifact** | **Bundled** (~**115 MB** arm64 mac zip, **~118 MB** linux, **~151 MB** win — [GitHub assets](https://github.com/electron/electron/releases/tag/v45.0.0)) | **Not bundled**; uses **WKWebView** (macOS), **WebView2** (Windows), **WebKitGTK 4.1** (Linux) | WebView2 often preinstalled Win11 ([Microsoft distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)) |
| **Node runtime in artifact** | **Embedded** in Electron; backend via **`ELECTRON_RUN_AS_NODE`** child ([#401](https://github.com/ccanalesb/lightroom-tagger/issues/401)) | **Separate** `node-v24.x-*` sidecar **~53 MB** `.tar.gz` ([nodejs.org](https://nodejs.org/dist/v24.22.1/)) | Sidecar naming: [Sidecar](https://v2.tauri.app/develop/sidecar/) |
| **Backend natives** | Stock npm prebuilds in **`Resources/backend/`** ([#401](https://github.com/ccanalesb/lightroom-tagger/issues/401)) | Same tree beside sidecar; **no Electron ABI** (cleaner than renderer, same as bundled Node option in [#402](https://github.com/ccanalesb/lightroom-tagger/issues/402)) | |
| **Idle UI memory** | Chromium renderer + GPU + browser process | System webview + small Rust host | **Backend dominates**; UI delta **platform-dependent** ([issue #5889](https://github.com/tauri-apps/tauri/issues/5889)) |
| **SPA + socket.io** | Full Chromium feature set | **Prefer `http://127.0.0.1`** in webview ([`WebviewUrl::External`](https://docs.rs/tauri/latest/tauri/enum.WebviewUrl.html)) | `@tauri-apps/plugin-websocket` is **not** socket.io — use browser WS in webview |
| **Devtools** | Built-in | Debug by default; release needs **`devtools` feature** ([Debug](https://v2.tauri.app/develop/debug/)) | |
| **File dialog → path** | `dialog.showOpenDialog` | `tauri-plugin-dialog` → **`PathBuf`** ([FilePath](https://docs.rs/tauri-plugin-dialog/latest/tauri_plugin_dialog/enum.FilePath.html)) | |
| **In-app updater (unsigned v1)** | macOS **no** (Squirrel); Win/Linux **yes** w/ Ed25519 manifest ([#383](https://github.com/ccanalesb/lightroom-tagger/issues/383)) | **minisign** on `.tar.gz` / NSIS / AppImage ([Updater](https://v2.tauri.app/plugin/updater/)); **macOS in-app plausible** without Apple signing | Gatekeeper after replace: **unconfirmed** |
| **SmartScreen / SAC** | Same unsigned story ([#408](https://github.com/ccanalesb/lightroom-tagger/issues/408)) | Same; **more PE files** if separate `node.exe` + sidecars | Sign **all** binaries for SAC |
| **Single instance** | `app.requestSingleInstanceLock` (Electron) | `tauri-plugin-single-instance` ([plugin](https://v2.tauri.app/plugin/single-instance/)) | |
| **CI** | `macos-15`, `windows-latest`, `ubuntu-latest` + electron-builder ([#407](https://github.com/ccanalesb/lightroom-tagger/issues/407)) | Above + **Rust toolchain**, **tauri-action**, Linux **webkit2gtk-4.1** deps | Debian baseline **12 / Ubuntu 22.04+** ([Debian guide](https://v2.tauri.app/distribute/debian/)) |
| **Maturity for this architecture** | **Spike proven** ([#401](https://github.com/ccanalesb/lightroom-tagger/issues/401)), extensive map research | Official [Node sidecar guide](https://v2.tauri.app/learn/sidecar-nodejs/) targets **`pkg`** bundles — **full `node_modules` + ONNX is app-specific** | |

---

## 1. Package and installed size

### What we know (Electron, measured)

The [#401](https://github.com/ccanalesb/lightroom-tagger/issues/401) spike packaged **Electron 45.0.0** with the real backend `node_modules` under `Resources/backend/` (child via `ELECTRON_RUN_AS_NODE`):

| Platform | Dir package |
|----------|-------------|
| macOS arm64 | **~798 MB** |
| Windows x64 | **~859 MB** |
| Linux x64 | **~1.1 GB** |

Weight is **dominated by onnxruntime-node, sharp/libvips, and the rest of the dependency tree** — not the Electron main stub ([spike doc](https://github.com/ccanalesb/lightroom-tagger/blob/spike/electron-addons/docs/research/spike-electron-addons.md)).

### Chromium / Electron runtime alone (upstream artifacts)

Official **compressed** Electron **45.0.0** runtime zips ([GitHub release API](https://github.com/electron/electron/releases/tag/v45.0.0)):

| Asset | Size (bytes) | ≈ MiB |
|-------|----------------|-------|
| `electron-v45.0.0-darwin-arm64.zip` | 120,706,020 | **~115** |
| `electron-v45.0.0-linux-x64.zip` | 123,909,792 | **~118** |
| `electron-v45.0.0-win32-x64.zip` | 158,223,852 | **~151** |

Unpacked in an `.app` / `win-unpacked`, the Chromium framework alone is commonly **~180 MB+** on Apple Silicon ([example commit noting 183 MB framework](https://github.com/jcyrus/browserport/commit/6c33a43c3023fce03c672b9febe5570e3caa68a8)) — **unconfirmed** for Electron 45 specifically.

### Node + `node_modules` cost in *both* shells

| Piece | Electron 45 (this spike) | Tauri + sidecar |
|-------|--------------------------|-----------------|
| Backend **`node_modules`** | **~majority of ~800 MB–1.1 GB** | **Same** (must ship beside sidecar) |
| Node runtime | **Inside Electron** (also used for `ELECTRON_RUN_AS_NODE` child) | **Extra** official Node **24.x** distro **~53 MB** `.tar.gz` per platform ([nodejs.org v24.22.1 index](https://nodejs.org/dist/v24.22.1/)); **~80–100 MB+** unpacked **unconfirmed** |
| UI engine | **Bundled Chromium** (see above) | **OS webview** (not in download; **Linux deps** on target distros) |
| Shell binary | Electron + helper processes | **Tauri Rust binary** (often **~8–25 MB** for typical apps — **unconfirmed** for this stack) |

**Net:** Tauri removes **one bundled Chromium/Electron tree** but **adds explicit Node** (where Electron reused embedded Node). #328’s intuition — **“Node ships anyway; size win evaporates”** — is **directionally correct**: expect **hundreds of MB**, not gigabytes, of savings. **Quantitative delta awaits #413.**

Optional: shipping **`pkg`-bundled** sidecar ([Tauri Node guide](https://v2.tauri.app/learn/sidecar-nodejs/)) does **not** eliminate native `.node` addons (sharp, ORT, sqlite) — still need a **`node_modules` resource tree** or per-platform native rebuild inside the bundle.

---

## 2. Memory

**Process model (either shell):** lightweight **UI process** + **Node backend** (Hono, socket.io, SQLite, ONNX `worker_threads`). Peak RSS is driven by **inference**, **thumbnail decode**, and **DB caches**, not React.

**UI shell only (secondary benchmarks, not this app):**

- Demo apps with **six windows**: Tauri **~172 MB** vs Electron **~409 MB** on macOS ([Hopp blog](https://www.gethopp.app/blog/tauri-vs-electron)) — **N=1**.
- **Single window**, Windows 11: Tauri **~142 MB** private vs Electron **~149 MB** ([dawloom.com](https://dawloom.com/blog/tauri-vs-electron-vs-wpf-benchmark/)) — **~same** because **WebView2 is Chromium**.
- Tauri maintainers: **memory is workload-dependent**; PSS/USS can favor Electron on Linux for real sites ([#5889](https://github.com/tauri-apps/tauri/issues/5889)).

**Conclusion:** Choosing Tauri for **this** app is **not** a reliable memory win; choosing Electron is **not** a reliable loss — **measure with backend running** if memory becomes a requirement.

---

## 3. System webviews and this React / socket.io SPA

### Recommended loading model (both shells)

Align with [#402](https://github.com/ccanalesb/lightroom-tagger/issues/402): **backend serves built SPA + `/api` + `/socket.io` on loopback**; desktop window navigates to **`http://127.0.0.1:5001`** (or dynamic port). Preserves **browser parity**, relative `/api`, and **socket.io** without swapping transports.

**Tauri:** `WebviewUrl::External(Url::parse("http://127.0.0.1:5001")?)` ([`WebviewUrl`](https://docs.rs/tauri/latest/tauri/enum.WebviewUrl.html)). **CSP** in `tauri.conf.json` must allow `connect-src` to that origin ([CSP](https://v2.tauri.app/security/csp/)).

**Electron:** `mainWindow.loadURL('http://127.0.0.1:5001')` — same origin as external browser tab.

### `tauri://` / asset protocol vs localhost

Serving only from **`tauri://localhost`** / **`https://tauri.localhost`** makes API calls **cross-origin** unless CSP/`FRONTEND_ORIGINS` include those schemes or the UI hard-codes `http://127.0.0.1` for API/socket ([#402](https://github.com/ccanalesb/lightroom-tagger/issues/402)). **Windows `use_https_scheme(true)`** blocks **mixed content** to `http://` backends ([`WebviewBuilder::use_https_scheme`](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html)). **Prefer loopback HTTP** for this product.

### Platform web engines

| OS | Engine | Implications for modern React 18 + Vite + Tailwind + socket.io |
|----|--------|-------------------------------------------------------------------|
| **macOS** | **WKWebView** (Safari engine) | Generally strong ES/CSS; **min macOS** configurable ([bundle macOS](https://v2.tauri.app/distribute/macos-application-bundle/)). Electron uses same engine on macOS but **pinned Chromium** elsewhere. |
| **Windows** | **WebView2** (Evergreen Chromium) | **Shared runtime** on most Win10/11 ([distribution doc](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)); **~2 MB bootstrapper** online or **standalone offline installer**. Behavior close to Electron **on Windows only**. |
| **Linux (best-effort)** | **WebKitGTK 4.1** | Tauri **2 requires `webkit2gtk-4.1`** — effectively **Ubuntu 22.04+ / Debian 12+** build baselines ([Debian](https://v2.tauri.app/distribute/debian/), [Prerequisites](https://v2.tauri.app/start/prerequisites/)). **Older distros / glibc** → **runtime failures** (`GLIBC_2.xx not found`) if built on too-new CI. **Feature gaps vs Chromium** for bleeding-edge CSS/JS **unconfirmed** for our exact bundle — **smoke-test on oldest target distro**. |

### WebSocket / socket.io

In the **loopback HTTP** model, **socket.io-client uses the webview’s built-in WebSocket** (same as Chrome). The **`@tauri-apps/plugin-websocket`** Rust bridge ([plugin](https://v2.tauri.app/plugin/websocket/)) is **not** drop-in for socket.io framing — **avoid** unless rewriting transport.

### Devtools

- **Electron:** Chromium DevTools in dev; `--inspect` patterns well known.
- **Tauri:** Inspector on in **debug** builds; **release** requires **`tauri` `devtools` feature** ([Debug](https://v2.tauri.app/develop/debug/)). macOS: Safari Develop menu; Windows: Edge DevTools for WebView2.

---

## 4. Native dialogs (`tauri-plugin-dialog`)

- **Electron:** `dialog.showOpenDialog` → **`string[]` absolute paths** ([#328](https://github.com/ccanalesb/lightroom-tagger/issues/328)).
- **Tauri 2:** `@tauri-apps/plugin-dialog` / Rust `FileDialogBuilder` return **`FilePath`**, typically **`PathBuf` on desktop**; use **`into_path()`** for a filesystem path ([`FilePath`](https://docs.rs/tauri-plugin-dialog/latest/tauri_plugin_dialog/enum.FilePath.html), [Dialog plugin](https://v2.tauri.app/plugin/dialog/)). **Yes — real paths** for `.lrcat` picking behind `useCatalogPicker`.

**IPC:** Tauri needs a **command** from frontend → Rust to open dialog and return path; Electron uses **preload + ipcMain**. Both fit the existing hook seam.

---

## 5. Updater (`tauri-plugin-updater` vs electron-updater)

| | Electron (unsigned v1 per [#383](https://github.com/ccanalesb/lightroom-tagger/issues/383)) | Tauri 2 ([Updater](https://v2.tauri.app/plugin/updater/)) |
|---|---------------------------------------------------------------------------------------------|-------------------------------------------------------------|
| **Update trust** | **Ed25519** `latest*.yml` (electron-builder v27+) + optional Authenticode | **minisign** (`.sig` files); **cannot disable** |
| **macOS in-app** | **No** — Squirrel / `autoUpdater` needs **properly signed** app ([Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)) | **Yes, in principle** — verifies **minisign** on `.app.tar.gz`, **not** Apple code signing |
| **Windows** | NSIS + `verifyUpdateCodeSignature: false` | NSIS/MSI + minisign |
| **Linux** | AppImage SHA-512 in manifest | AppImage + minisign (or tar.gz in v1-compatible mode) |
| **Secrets** | `ELECTRON_BUILDER_UPDATE_SIGN_KEY` ([#407](https://github.com/ccanalesb/lightroom-tagger/issues/407)) | `TAURI_SIGNING_PRIVATE_KEY` |

**Unsigned macOS after in-app replace:** Update integrity is **minisign**, but **Gatekeeper/quarantine** may still prompt on **new/modified bundle** ([Apple — safely open apps](https://support.apple.com/en-us/102445)) — **unconfirmed** whether security exception persists across Tauri updater swaps. **Updater 2.13.2** (Oct 2026) improved **failed macOS install rollback** ([updater changelog](https://v2.tauri.app/release/updater/all-versions/)).

**Surprise vs map:** Tauri **can** ship **macOS in-app updates** without Apple Developer ID; Electron **cannot** with stock Squirrel. Both still face **first-install** Gatekeeper friction ([#383](https://github.com/ccanalesb/lightroom-tagger/issues/383)).

---

## 6. Gatekeeper / SmartScreen / Smart App Control

**No shell escapes unsigned v1 friction:**

- **macOS:** Ad-hoc **`signingIdentity: "-"`** required for Tauri ([signing doc](https://v2.tauri.app/distribute/sign/macos/)) — same class of **“Open Anyway”** flow as electron-builder `mac.sign.identity: "-"` ([#383](https://github.com/ccanalesb/lightroom-tagger/issues/383)).
- **Windows SmartScreen:** **Run anyway** when SAC off ([#383](https://github.com/ccanalesb/lightroom-tagger/issues/383)).
- **SAC On:** **Hard block** unsigned PE/DLL — **Tauri adds `node.exe` and sidecars** to the signing surface ([#408](https://github.com/ccanalesb/lightroom-tagger/issues/408)).

Apple **notarization** and **Authenticode** remain **future** work for either shell.

---

## 7. Sidecar mechanics (Tauri)

### `externalBin` naming

From [Embedding External Binaries](https://v2.tauri.app/develop/sidecar/):

- Config: `"externalBin": ["binaries/node-server"]`
- Files: `src-tauri/binaries/node-server-x86_64-unknown-linux-gnu`, `…-aarch64-apple-darwin`, `…-x86_64-pc-windows-msvc.exe`
- Triple from `rustc --print host-tuple` or **`TAURI_ENV_TARGET_TRIPLE`** in CI ([env vars](https://v2.tauri.app/reference/environment-variables/))
- Spawn: `@tauri-apps/plugin-shell` **`Command.sidecar('binaries/node-server', args)`**

**Node as sidecar:** Ship **`node-$triple`** (or a wrapper script) pointing at **`Resources/backend/dist/...`**. **`node_modules`** via **`bundle.resources`** ([macOS bundle resources](https://v2.tauri.app/distribute/macos-application-bundle/)) — mirror electron-builder **`extraResources`** split ([#401](https://github.com/ccanalesb/lightroom-tagger/issues/401)).

### Lifecycle

- Start sidecar on **`setup`**, poll **`GET /api/status`**, load webview when ready (same as [#402](https://github.com/ccanalesb/lightroom-tagger/issues/402)).
- **Shutdown:** listen for **`Command` exit**; **`kill()`** on app exit; on Windows **`taskkill /T /F`** if backend spawned **`uv`/workers** ([#402](https://github.com/ccanalesb/lightroom-tagger/issues/402)). **Unconfirmed:** whether Tauri shell plugin always tears down **grandchild** processes without tree kill.
- **Single instance:** register **`tauri-plugin-single-instance` first** ([plugin doc](https://v2.tauri.app/plugin/single-instance/)).

**Electron equivalent already researched:** `utilityProcess` / `ELECTRON_RUN_AS_NODE` ([#402](https://github.com/ccanalesb/lightroom-tagger/issues/402), [#401](https://github.com/ccanalesb/lightroom-tagger/issues/401)).

---

## 8. CI and toolchain cost

| Cost | Electron 45 | Tauri 2 |
|------|-------------|---------|
| **Languages** | TypeScript / Node | **+ Rust** |
| **Linux build deps** | electron-builder, standard Node | **`libwebkit2gtk-4.1-dev`**, GTK stack ([Prerequisites](https://v2.tauri.app/start/prerequisites/)) |
| **GitHub Actions** | `electron-builder --publish …` ([#407](https://github.com/ccanalesb/lightroom-tagger/issues/407)) | **`tauri-apps/tauri-action`**, Rust cache, same OS matrix |
| **Cross-compile** | Build on native OS per target | Same; **no Win cross-build from macOS** for either |
| **Cold build time** | Faster (TS-only product code) | **Slower** — Rust compile + frontend ([anecdotal benchmarks](https://www.gethopp.app/blog/tauri-vs-electron)) |
| **Release artifacts** | DMG/NSIS/AppImage + `latest*.yml` | DMG/NSIS/AppImage + **`latest.json`** + minisign |

---

## 9. Maturity, ecosystem, and risk

**Electron (for this repo):**

- **Proven** packaged natives + HTTP backend on **macOS arm64, Windows x64, Linux x64** ([#401](https://github.com/ccanalesb/lightroom-tagger/issues/401)).
- Map already has **unsigned install**, **SAC**, **release pipeline**, **local server** research.
- **Risk:** package size, Linux **`--no-sandbox`** in headless CI (not necessarily end-user), Chromium **CVE** cadence — acceptable for a desktop photo tool.

**Tauri 2:**

- **Mature** for **webview + plugins** (dialog, updater, single-instance, shell); **2.x** stable ecosystem.
- **Risk for this app:** **Node + heavy natives** is **not** the happy-path `pkg` sidecar from [Node sidecar guide](https://v2.tauri.app/learn/sidecar-nodejs/); **Linux webview** variance on **best-effort** tier; **team pays Rust** on every native/desktop change; **fewer** reference apps at **onnx + sqlite + socket.io** scale (**unconfirmed** count).

---

## Conclusion

**Recommend Electron 45** as the v1 shell for [#382](https://github.com/ccanalesb/lightroom-tagger/issues/382): the **size win from Tauri is real but modest** once **Node 24 + full backend `node_modules`** ship beside the UI; **memory is backend-bound**; **Linux webview + Rust CI** add risk on a **best-effort** tier; and the **Electron spike + map research** are already **validated**.

**Map destination:** **No change** on this research alone. **Optional note for a future ticket:** Tauri **minisign updater** is the one **material upside** over Electron for **unsigned macOS** in-app updates — weigh after **#413** size numbers land.

---

## Primary sources (quick index)

- Tauri: [Sidecar](https://v2.tauri.app/develop/sidecar/), [Node sidecar](https://v2.tauri.app/learn/sidecar-nodejs/), [CSP](https://v2.tauri.app/security/csp/), [Updater](https://v2.tauri.app/plugin/updater/), [Dialog](https://v2.tauri.app/plugin/dialog/), [Single Instance](https://v2.tauri.app/plugin/single-instance/), [macOS signing](https://v2.tauri.app/distribute/sign/macos/), [Debian/Linux](https://v2.tauri.app/distribute/debian/), [Prerequisites](https://v2.tauri.app/start/prerequisites/)
- Electron: [v45.0.0 release](https://github.com/electron/electron/releases/tag/v45.0.0), [releases.electronjs.org](https://releases.electronjs.org/release/v45.0.0), [autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)
- Microsoft: [WebView2 distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)
- Apple: [Safely open apps](https://support.apple.com/en-us/102445)
- Node: [v24.22.1 dist index](https://nodejs.org/dist/v24.22.1/)
- Repo map: [spike-electron-addons.md](https://github.com/ccanalesb/lightroom-tagger/blob/spike/electron-addons/docs/research/spike-electron-addons.md), [electron-local-server.md](https://github.com/ccanalesb/lightroom-tagger/blob/research/electron-local-server/docs/research/electron-local-server.md), [unsigned-electron-install.md](https://github.com/ccanalesb/lightroom-tagger/blob/research/unsigned-electron/docs/research/unsigned-electron-install.md)
