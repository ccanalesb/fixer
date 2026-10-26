# Tauri 2 release pipeline: GitHub Actions → GitHub Releases

Research for wayfinder map [#382](https://github.com/ccanalesb/lightroom-tagger/issues/382) / ticket [#416](https://github.com/ccanalesb/lightroom-tagger/issues/416). Assumes **ADR-0022** shape: Tauri 2 shell, Hono backend as a **Node 24 sidecar** (`bundle.externalBin`), backend `dist/` + production `node_modules` as **bundle resources**, window loads the SPA from loopback. Targets: **macOS arm64**, **Windows x64**, **Linux x64** (best-effort), **unsigned v1**, public **GitHub Releases** from CI. macOS in-app auto-update is **out of scope** for this effort; Windows/Linux in-app update may be in scope.

Builds on unsigned-install research ([#383](https://github.com/ccanalesb/lightroom-tagger/issues/383) / `research/unsigned-electron`), Electron release pipeline ([#407](https://github.com/ccanalesb/lightroom-tagger/issues/407)), Smart App Control ([#408](https://github.com/ccanalesb/lightroom-tagger/issues/408)), and the Tauri sidecar spike ([#413](https://github.com/ccanalesb/lightroom-tagger/issues/413)). Method: **primary sources only** (Tauri v2 docs, `tauri-apps/tauri` and `tauri-action` source, GitHub docs, nodejs.org, Apple/Microsoft docs). **Unconfirmed** where not verified here.

---

## TL;DR

- **CI matrix:** One job per OS on native runners — **`macos-latest`** (Apple Silicon) with `args: '--target aarch64-apple-darwin'`, **`windows-latest`**, **`ubuntu-22.04`** (Tauri’s documented Linux baseline for WebKitGTK 4.1 + glibc; not `ubuntu-latest` 24.04 if you want Debian 12 / Ubuntu 22.04–class compatibility) ([GitHub Actions guide](https://v2.tauri.app/distribute/pipelines/github/), [Debian](https://v2.tauri.app/distribute/debian/), [AppImage](https://v2.tauri.app/distribute/appimage/)). Install Linux deps from the same guide (`libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`, `xdg-utils`). Use **`dtolnay/rust-toolchain@stable`** + **`swatinem/rust-cache@v2`** with `workspaces` pointing at `src-tauri -> target` ([GitHub guide](https://v2.tauri.app/distribute/pipelines/github/)). Expect **long cold builds** (Rust + linking WebKitGTK on Linux + large backend `node_modules`); cached Rust helps; full release matrix runtime is **unconfirmed** for this monorepo until a workflow exists.
- **Publish:** **`tauri-apps/tauri-action@v1`** with `permissions: contents: write`, `GITHUB_TOKEN`, `tagName` / `releaseName`, and usually **`releaseDraft: true`** so humans publish when all matrix legs finish ([`tauri-action` README](https://github.com/tauri-apps/tauri-action/blob/dev/README.md)). Alternative: omit `tagName`/`releaseId` to build-only and upload via a final job (**unconfirmed** merge pattern for this repo). Triggers: push to a release branch, **`push: tags`**, or `workflow_dispatch` ([GitHub guide](https://v2.tauri.app/distribute/pipelines/github/)).
- **Node sidecar in CI:** Per runner, download **nodejs.org** Node **24.x** for that host arch, verify **`SHASUMS256.txt`**, extract `bin/node` (or `node.exe`), rename to **`binaries/node-<TARGET_TRIPLE>[.exe]`** matching `externalBin` ([Sidecar](https://v2.tauri.app/develop/sidecar/)). Triples: `aarch64-apple-darwin`, `x86_64-pc-windows-msvc`, `x86_64-unknown-linux-gnu` (`rustc --print host-tuple` on each runner). Spike script pattern: [`spike/tauri/scripts/fetch-node.mjs`](https://github.com/ccanalesb/lightroom-tagger/blob/spike/tauri-sidecar/spike/tauri/scripts/fetch-node.mjs) (extend with SHA-256 check against [dist `SHASUMS256.txt`](https://nodejs.org/dist/v24.11.0/SHASUMS256.txt)).
- **Updater:** **`tauri-plugin-updater`** requires **minisign** on update artifacts; generate keys with **`tauri signer generate`**, store **`TAURI_SIGNING_PRIVATE_KEY`** (and optional password) in CI secrets, embed **`pubkey`** in config ([Updater](https://v2.tauri.app/plugin/updater/)). Set **`bundle.createUpdaterArtifacts`**: `true` (v2) or `"v1Compatible"` if you need legacy `.tar.gz` wrappers ([Updater → Building](https://v2.tauri.app/plugin/updater/)). **`tauri-action`** can upload **`latest.json`** when the updater is configured (`uploadUpdaterJson`, default true) ([README](https://github.com/tauri-apps/tauri-action/blob/dev/README.md)).
- **Linux artifacts vs updater:** Updater supports **AppImage only** on Linux (not `.deb`) — signatures target AppImage or AppImage `.tar.gz`, not Debian packages ([Updater → Building](https://v2.tauri.app/plugin/updater/)). **`.deb`** is fine for **manual** installs (declares `libwebkit2gtk-4.1-0`, etc.) ([Debian](https://v2.tauri.app/distribute/debian/)). **AppImage** bundles dependencies (including WebKitGTK stack via `linuxdeploy`); size grows sharply with app data ([AppImage](https://v2.tauri.app/distribute/appimage/)). Practical v1 split: **ship `.deb` + AppImage** if you want apt-friendly downloads **and** in-app update; configure updater endpoints to **`releases/latest/download/latest.json`** only if AppImage (or macOS/Windows) updater artifacts are on the release ([Updater → static JSON](https://v2.tauri.app/plugin/updater/)).
- **Windows updater bundle:** Both **NSIS** (`.exe`) and **MSI** are supported; **`tauri-action`** defaults to **MSI-first** in `latest.json` when both exist — set **`updaterJsonPreferNsis: true`** for NSIS-only spikes ([README `updaterJsonPreferNsis`](https://github.com/tauri-apps/tauri-action/blob/dev/README.md)). Unsigned NSIS: same **SmartScreen** story as Electron ([#383](https://github.com/ccanalesb/lightroom-tagger/issues/383)); extra unsigned **`node.exe`** sidecar adds another PE for **Smart App Control** ([#408](https://github.com/ccanalesb/lightroom-tagger/issues/408)).
- **macOS unsigned:** Set **`bundle.macOS.signingIdentity: "-"`** for ad-hoc signing on Apple Silicon downloads ([macOS signing](https://v2.tauri.app/distribute/sign/macos/), [GitHub guide note](https://v2.tauri.app/distribute/pipelines/github/)). User friction matches **#383** (Gatekeeper, **Open Anyway** on Sequoia+, not Control-click). **DMG:** local spike failed on Finder **AppleScript**; bundler passes **`--skip-jenkins` when `CI=true`** to avoid that path ([`tauri-bundler` `dmg/mod.rs`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/macos/dmg/mod.rs)). **GHA DMG success not run here — unconfirmed.** Fallbacks: **`.app` in `.zip`**, or DMG after CI smoke; spike shipped **`app` only** ([#413 spike doc](https://github.com/ccanalesb/lightroom-tagger/blob/spike/tauri-sidecar/docs/research/spike-tauri-sidecar.md)).
- **Rate limits:** **`GET /repos/{owner}/{repo}/releases/latest`** is REST and counts toward **60 requests/hour/IP** unauthenticated ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)). Fetching **`https://github.com/{owner}/{repo}/releases/latest/download/latest.json`** is a **release asset redirect**, not documented as a REST call — **unconfirmed** whether it shares the 60/h REST bucket (GitHub Support has described low limits for anonymous **`github.com/.../releases/download/...`** URLs in third-party reports). **`tauri-action` writes `latest.json` with `https://api.github.com/repos/.../releases/assets/{id}` URLs** for bundles ([`upload-version-json.ts`](https://github.com/tauri-apps/tauri-action/blob/dev/src/upload-version-json.ts)); downloading those uses the **release asset REST endpoint** and **does** count as REST when using `Accept: application/octet-stream` ([Get a release asset](https://docs.github.com/en/rest/releases/assets#get-a-release-asset)). Prefer infrequent update checks; **unconfirmed** whether pointing `latest.json` at `browser_download_url` avoids API quota.

---

## 1. `tauri-action` matrix, runners, caching, build time

### 1.1 Recommended matrix (v1: macOS arm64 only)

| Target | `runs-on` | Tauri CLI `args` | Notes |
|--------|-----------|------------------|--------|
| macOS arm64 | `macos-latest` (Apple Silicon image) | `--target aarch64-apple-darwin` | GitHub labels: [workflow `runs-on`](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#jobsjob_idruns-on); Tauri example uses `macos-latest` + explicit target ([GitHub guide](https://v2.tauri.app/distribute/pipelines/github/)). |
| Windows x64 | `windows-latest` | (default host target) | MSVC toolchain required ([Prerequisites → Windows](https://v2.tauri.app/start/prerequisites/)). |
| Linux x64 | **`ubuntu-22.04`** | (default) | Tauri docs’ workflow example and WebKitGTK 4.1 packages ([GitHub guide](https://v2.tauri.app/distribute/pipelines/github/)). |

The [#413](https://github.com/ccanalesb/lightroom-tagger/issues/413) spike workflow used **`ubuntu-24.04`** and **`windows-2022`** ([`spike-tauri-sidecar.yml`](https://github.com/ccanalesb/lightroom-tagger/blob/spike/tauri-sidecar/.github/workflows/spike-tauri-sidecar.yml)) — fine for CI smoke, but **release builds intended for older glibc should not assume 24.04** without accepting a higher **GLIBC** floor ([Debian limitations](https://v2.tauri.app/distribute/debian/)).

### 1.2 Linux system dependencies

Match Tauri’s GitHub guide `apt-get install` list ([GitHub guide](https://v2.tauri.app/distribute/pipelines/github/)) — same set as [#413](https://github.com/ccanalesb/lightroom-tagger/issues/413) spike (`libwebkit2gtk-4.1-dev`, …). Packaged smoke on Linux may need **`xvfb-run`** ([spike workflow](https://github.com/ccanalesb/lightroom-tagger/blob/spike/tauri-sidecar/.github/workflows/spike-tauri-sidecar.yml)).

### 1.3 Rust and npm caching

| Layer | Mechanism |
|-------|-----------|
| Rust | `swatinem/rust-cache@v2`, `workspaces: './src-tauri -> target'` ([GitHub guide](https://v2.tauri.app/distribute/pipelines/github/)). |
| Node | `actions/setup-node` with `cache: 'npm'` and lockfile path(s) for the desktop package / monorepo install root ([GitHub guide example](https://v2.tauri.app/distribute/pipelines/github/)). |

Separate cache keys per OS are conventional (**unconfirmed** optimal key for this repo’s layout).

### 1.4 Build time (expectations)

Contributors:

- **Cold `cargo tauri build`** on Linux after WebKitGTK deps (Rust link + bundling).
- **Backend prep:** production `npm ci` / install for `node_modules` with native addons (dominates artifact size in [#413](https://github.com/ccanalesb/lightroom-tagger/issues/413)).
- **AppImage** bundling via `linuxdeploy` adds work vs `.deb` alone ([AppImage](https://v2.tauri.app/distribute/appimage/)).

Tauri docs note ~**10 minutes** for a typical AppImage on **`ubuntu-22.04-arm`** ([AppImage → ARM](https://v2.tauri.app/distribute/appimage/)); full product build times **unconfirmed**.

### 1.5 Minimal workflow skeleton (illustrative)

```yaml
permissions:
  contents: write

strategy:
  fail-fast: false
  matrix:
    include:
      - platform: macos-latest
        args: '--target aarch64-apple-darwin'
      - platform: windows-latest
        args: ''
      - platform: ubuntu-22.04
        args: ''

runs-on: ${{ matrix.platform }}

# … checkout, setup-node (24), rust-toolchain, rust-cache, linux deps …
# … fetch + verify Node sidecar, build backend resources …

- uses: tauri-apps/tauri-action@v1
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
  with:
    tagName: app-v__VERSION__
    releaseName: 'App v__VERSION__'
    releaseDraft: true
    args: ${{ matrix.args }}
    updaterJsonPreferNsis: true   # if Windows target is NSIS-only
    projectPath: apps/visualizer/desktop   # when wired; spike uses spike/tauri
```

Source: [GitHub guide](https://v2.tauri.app/distribute/pipelines/github/), [`tauri-action` README](https://github.com/tauri-apps/tauri-action/blob/dev/README.md).

---

## 2. Node sidecar per target triple in CI

### 2.1 Naming contract

`bundle.externalBin: ["binaries/node"]` requires files:

| Platform | Path under `src-tauri/` |
|----------|-------------------------|
| macOS arm64 | `binaries/node-aarch64-apple-darwin` |
| Windows x64 | `binaries/node-x86_64-pc-windows-msvc.exe` |
| Linux x64 | `binaries/node-x86_64-unknown-linux-gnu` |

([Sidecar](https://v2.tauri.app/develop/sidecar/))

Rust sidecar spawn uses the logical name **`node`**, not the suffixed filename ([Sidecar → Running from Rust](https://v2.tauri.app/develop/sidecar/)).

### 2.2 Download URLs (official Node 24)

Archive names follow `node-{version}-{platform}-{arch}.{ext}` on [nodejs.org/dist](https://nodejs.org/dist/):

| Runner | Archive | Extract |
|--------|---------|---------|
| macOS arm64 | `node-v24.x.x-darwin-arm64.tar.gz` | `bin/node` |
| Windows x64 | `node-v24.x.x-win-x64.zip` | `node.exe` |
| Linux x64 | `node-v24.x.x-linux-x64.tar.xz` | `bin/node` |

Pin **`NODE_VERSION`** (e.g. `v24.11.0`) in CI; ADR-0022 assumes Node 24 from nodejs.org.

### 2.3 Pinning and verification

1. Download `https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt` ([example v24.11.0](https://nodejs.org/dist/v24.11.0/SHASUMS256.txt)).
2. Verify the line for your archive (`node-v24.11.0-linux-x64.tar.xz`, etc.) with `sha256sum -c` (or equivalent) **before** extract.
3. Optionally cross-check version availability via [nodejs.org/dist/index.json](https://nodejs.org/dist/index.json).

The spike **`fetch-node.mjs`** does not yet verify SHASUMS — add that in the release workflow ([spike script](https://github.com/ccanalesb/lightroom-tagger/blob/spike/tauri-sidecar/spike/tauri/scripts/fetch-node.mjs)).

### 2.4 Cross-compilation note

Sidecar binaries must match the **Tauri build target**, not the sidecar’s source language. CI should **build on native runners** per arch (matrix above), not rename a single downloaded Node with a wrong triple ([Sidecar](https://v2.tauri.app/develop/sidecar/)).

---

## 3. Updater: `latest.json`, minisign, supported artifacts

### 3.1 Signing (cannot disable)

- Generate: `tauri signer generate -w ~/.tauri/myapp.key` ([Updater → Signing](https://v2.tauri.app/plugin/updater/)).
- CI env: **`TAURI_SIGNING_PRIVATE_KEY`** (path or PEM contents), optional **`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`**; `.env` is **not** read at build time ([Updater → Building](https://v2.tauri.app/plugin/updater/)).
- Config: `plugins.updater.pubkey` = public key string; `endpoints` includes e.g. `https://github.com/user/repo/releases/latest/download/latest.json` ([Updater → Tauri configuration](https://v2.tauri.app/plugin/updater/)).

### 3.2 Updater artifacts by OS

| OS | Installers reused for update | Updater-specific output (when `createUpdaterArtifacts: true`) |
|----|------------------------------|----------------------------------------------------------------|
| Linux | **AppImage** | `.AppImage` + `.AppImage.sig` (or `.AppImage.tar.gz` + sig in v1-compatible mode) — **no `.deb`** ([Updater → Building](https://v2.tauri.app/plugin/updater/)) |
| macOS | `.app` bundle | `.app.tar.gz` + `.app.tar.gz.sig` ([Updater](https://v2.tauri.app/plugin/updater/)) |
| Windows | **NSIS** `.exe` and/or **MSI** | Matching `.sig` files; v1-compatible mode uses `.nsis.zip` / `.msi.zip` ([Updater](https://v2.tauri.app/plugin/updater/)) |

MSRV for updater plugin: **Rust ≥ 1.90** ([Updater](https://v2.tauri.app/plugin/updater/)).

### 3.3 `latest.json` and `tauri-action`

Static JSON schema: `version`, `platforms["OS-ARCH"].url`, `platforms["OS-ARCH"].signature` ([Updater → Static JSON](https://v2.tauri.app/plugin/updater/)).

`tauri-action`:

- Merges platforms across matrix jobs when re-uploading `latest.json` ([`upload-version-json.ts`](https://github.com/tauri-apps/tauri-action/blob/dev/src/upload-version-json.ts)).
- Sets bundle **`url`** to **`{githubBaseUrl}/repos/{owner}/{repo}/releases/assets/{asset_id}`** (default `githubBaseUrl` = `https://api.github.com`) ([same file](https://github.com/tauri-apps/tauri-action/blob/dev/src/upload-version-json.ts)).
- **`updaterJsonPreferNsis`**: default **`false`** → prefers MSI when both NSIS and MSI exist ([README](https://github.com/tauri-apps/tauri-action/blob/dev/README.md)).

If `releaseId` is set without `tagName`, README warns `latest.json` may point at **`releases/latest/download/...`**, which breaks when other releases lack updater assets ([README tips](https://github.com/tauri-apps/tauri-action/blob/dev/README.md)).

---

## 4. Linux: `.deb`, AppImage, or both

| Format | Role | WebKitGTK |
|--------|------|-----------|
| **`.deb`** | `apt install`; declares deps on **`libwebkit2gtk-4.1-0`**, GTK, appindicator ([Debian](https://v2.tauri.app/distribute/debian/)) | Uses **system** WebKitGTK at runtime |
| **AppImage** | Single file, no install; **required for Tauri updater on Linux** ([Updater](https://v2.tauri.app/plugin/updater/)) | Bundles dependencies via AppImage tooling ([AppImage](https://v2.tauri.app/distribute/appimage/)) |

**glibc / base image:** Build on **Ubuntu 22.04 / Debian 12–class** CI to avoid `GLIBC_2.xx not found` on older distros ([Debian limitations](https://v2.tauri.app/distribute/debian/), [AppImage limitations](https://v2.tauri.app/distribute/appimage/)). Building on **24.04** raises the implied glibc floor ([same docs](https://v2.tauri.app/distribute/debian/)).

**AppImage + WebKitGTK caveats:**

- Tauri points to **tauri#1355** and **rust#57497** for glibc / bundling discussion ([Debian](https://v2.tauri.app/distribute/debian/)).
- AppImage size grows with bundled libs; media playback may need `bundleMediaFramework` (gstreamer), mainly tested on Ubuntu build hosts ([AppImage](https://v2.tauri.app/distribute/appimage/)).
- **Cross-compiling** x64 AppImage on arm64 is **not** supported by `linuxdeploy`; arm AppImages need arm runners or slow QEMU ([AppImage → ARM](https://v2.tauri.app/distribute/appimage/), [GitHub guide ARM section](https://v2.tauri.app/distribute/pipelines/github/)).

**Recommendation for this product (unsigned v1, optional Win/Linux updater):**

- **`targets`**: include **`deb`** for manual Linux installs (matches spike) and **`appimage`** if `tauri-plugin-updater` ships on Linux.
- Do **not** expect `.deb` to receive updater signatures.

---

## 5. macOS unsigned, quarantine, DMG on CI

### 5.1 Ad-hoc signing

Configure **`"signingIdentity": "-"`** under `bundle.macOS` ([macOS signing → Ad-Hoc](https://v2.tauri.app/distribute/sign/macos/)). Tauri’s GitHub guide states this reduces “damaged app” behavior for **Apple Silicon builds downloaded from GitHub** ([GitHub guide](https://v2.tauri.app/distribute/pipelines/github/)).

### 5.2 User cost vs Electron (#383)

Same primary sources as [#383](https://github.com/ccanalesb/lightroom-tagger/issues/383): Gatekeeper on first launch; **Sequoia+** requires **Settings → Privacy & Security → Open Anyway** ([Apple Developer News 2024-08-06](https://developer.apple.com/news/?id=saqachfa), [Safely open apps](https://support.apple.com/en-us/102445)). Ad-hoc avoids the **“damaged”** class tied to missing/invalid signatures ([unsigned Electron research](https://github.com/ccanalesb/lightroom-tagger/blob/research/unsigned-electron/docs/research/unsigned-electron-install.md)).

**Quarantine:** Downloaded artifacts carry quarantine metadata; user installs from DMG/ZIP to Applications ([#383](https://github.com/ccanalesb/lightroom-tagger/issues/383)). **Unconfirmed:** whether in-app update replacing `.app` preserves Gatekeeper exceptions.

### 5.3 DMG on CI vs local spike failure

Tauri DMG creation uses **`bundle_dmg.sh`**, which drives **Finder via AppleScript**; local failures often show **`-1743` (Automation not allowed)** ([`dmg/mod.rs` comment](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/macos/dmg/mod.rs)).

When **`CI=true`**, the bundler adds **`--skip-jenkins`** to avoid that AppleScript path ([`dmg/mod.rs`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/macos/dmg/mod.rs)).

[#413](https://github.com/ccanalesb/lightroom-tagger/issues/413) spike: **DMG step failed locally** (Finder AppleScript timeout); **`targets`** were **`app`, `nsis`, `deb`** only — no DMG ([spike doc](https://github.com/ccanalesb/lightroom-tagger/blob/spike/tauri-sidecar/docs/research/spike-tauri-sidecar.md)).

**Unconfirmed:** DMG on **`macos-latest` GHA** with `CI=true` (no empirical run in this ticket).

**Alternatives for Releases:**

- Upload **`.app` tarball** or **`.zip`** of the `.app` (Tauri macOS bundle output under `bundle/macos/`).
- Add **`dmg`** to `bundle.targets` once CI proves DMG; users often expect DMG for drag-to-Applications ([Apple install guide](https://support.apple.com/guide/mac-help/install-and-uninstall-other-apps-mhlp1013/mac)).

macOS **in-app updater** artifacts (`.app.tar.gz` + minisign) can work without Apple signing ([Updater](https://v2.tauri.app/plugin/updater/)); product scope says **macOS auto-update out of scope** for this effort — manual re-download from Releases remains the v1 path.

---

## 6. Windows unsigned (NSIS + extra `node.exe`)

- **NSIS** from spike; SmartScreen **More info → Run anyway** for unsigned installers ([#383](https://github.com/ccanalesb/lightroom-tagger/issues/383), [SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)).
- **Separate `node.exe` sidecar** is an additional **unsigned PE** beside the app (ADR-0022 consequence). SmartScreen may prompt per new hash; **Smart App Control On** can block unsigned code entirely ([#408](https://github.com/ccanalesb/lightroom-tagger/issues/408)).
- **MSI** needs VBScript optional feature on some Windows images ([Prerequisites → VBSCRIPT](https://v2.tauri.app/start/prerequisites/)); spike used **NSIS only**.

Updater on Windows verifies **minisign** on the update package, not Authenticode ([Updater](https://v2.tauri.app/plugin/updater/)).

---

## 7. GitHub rate limits: REST “latest release” vs updater fetches

### 7.1 REST `GET .../releases/latest`

Documented limit: **60 requests/hour/IP** unauthenticated ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)). Used if the app calls the REST API for “new version” notices ([#407](https://github.com/ccanalesb/lightroom-tagger/issues/407)).

### 7.2 Static `latest.json` at `releases/latest/download/latest.json`

Documented linking pattern ([Linking to releases](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)). **Not** listed in REST rate-limit docs as exempt or included — treat bandwidth/throttling separately (**unconfirmed** vs 60/h REST).

Third-party GitHub Support guidance (via community reports) indicates anonymous **`github.com/.../download/...`** can hit **429** under heavy use; authenticated REST asset download gets **5000/h** per user ([rvm#4992 discussion](https://github.com/rvm/rvm/issues/4992) — **secondary** anecdote, not official docs).

### 7.3 Tauri updater with `tauri-action`-generated `latest.json`

1. **Check endpoint:** HTTPS GET to configured `endpoints` (often `releases/latest/download/latest.json`) ([Updater](https://v2.tauri.app/plugin/updater/)).
2. **Download update:** URL inside JSON often **`api.github.com/.../releases/assets/{id}`** ([`upload-version-json.ts`](https://github.com/tauri-apps/tauri-action/blob/dev/src/upload-version-json.ts)) → **REST asset download** ([Get a release asset](https://docs.github.com/en/rest/releases/assets#get-a-release-asset)).

Each update attempt may consume **≥1 REST request** for the binary (plus the manifest fetch). Wide user base + frequent checks + unauthenticated asset API **may** hit **60/h/IP** — **unconfirmed** at scale; mitigations: ship **`browser_download_url`** in custom `latest.json`, CDN mirror, or accept low check frequency.

---

## 8. Draft vs published releases

| Mechanism | Behavior |
|-----------|----------|
| **`releaseDraft: true`** in `tauri-action` | Creates/updates a **draft** release; assets upload while draft ([README `releaseDraft`](https://github.com/tauri-apps/tauri-action/blob/dev/README.md)). |
| **`releaseDraft: false`** | Publishes immediately when the action creates the release ([README](https://github.com/tauri-apps/tauri-action/blob/dev/README.md)). |
| **`GET .../releases/latest`** | **Excludes** drafts and prereleases ([Get the latest release](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)). |

Draft-first matches electron-builder guidance in [#407](https://github.com/ccanalesb/lightroom-tagger/issues/407): attach all matrix artifacts, then publish in the GitHub UI when ready.

**Existing release:** pass **`releaseId`** or matching **`tagName`**; if the release is draft, **`releaseDraft: true`** must match ([README](https://github.com/tauri-apps/tauri-action/blob/dev/README.md)).

---

## 9. Product-specific wiring (from spike → ship)

| Step | Notes |
|------|--------|
| Backend pack | Spike: `prepare-backend` → `backend-pack/` mapped with `bundle.resources` ([spike `tauri.conf.json`](https://github.com/ccanalesb/lightroom-tagger/blob/spike/tauri-sidecar/spike/tauri/src-tauri/tauri.conf.json)). |
| Version source | `tauri.conf.json` `version` drives `__VERSION__` in `tauri-action` `tagName`. |
| macOS unsigned | `signingIdentity: "-"` in bundle config ([macOS signing](https://v2.tauri.app/distribute/sign/macos/)). |
| Windows | `targets` includes **`nsis`**; set **`updaterJsonPreferNsis: true`** if no MSI ([README](https://github.com/tauri-apps/tauri-action/blob/dev/README.md)). |
| Linux | **`ubuntu-22.04`** release job; **`deb` + `appimage`** if updater enabled ([Debian](https://v2.tauri.app/distribute/debian/), [Updater](https://v2.tauri.app/plugin/updater/)). |
| Secrets | `GITHUB_TOKEN` (`contents: write`), `TAURI_SIGNING_PRIVATE_KEY` (+ password if used). |

---

## Primary sources index

| Topic | URL |
|-------|-----|
| Tauri GitHub Actions pipeline | https://v2.tauri.app/distribute/pipelines/github/ |
| `tauri-action` README | https://github.com/tauri-apps/tauri-action/blob/dev/README.md |
| `tauri-action` `latest.json` generator | https://github.com/tauri-apps/tauri-action/blob/dev/src/upload-version-json.ts |
| Sidecar / `externalBin` | https://v2.tauri.app/develop/sidecar/ |
| Updater plugin | https://v2.tauri.app/plugin/updater/ |
| Debian bundle | https://v2.tauri.app/distribute/debian/ |
| AppImage bundle | https://v2.tauri.app/distribute/appimage/ |
| macOS signing (ad-hoc `-`) | https://v2.tauri.app/distribute/sign/macos/ |
| DMG bundler (`CI`, `--skip-jenkins`) | https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/macos/dmg/mod.rs |
| Node.js dist / SHASUMS | https://nodejs.org/dist/ |
| GitHub Actions `runs-on` | https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#jobsjob_idruns-on |
| REST rate limits | https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api |
| Release asset download (REST) | https://docs.github.com/en/rest/releases/assets#get-a-release-asset |
| Linking to release downloads | https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases |
| Get latest release (draft rules) | https://docs.github.com/en/rest/releases/releases#get-the-latest-release |
| SmartScreen (unsigned) | https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation |
| Smart App Control | https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview |
| Apple Gatekeeper / Open Anyway | https://support.apple.com/en-us/102445 |

---

## Open questions (candidate tickets)

1. **Empirical GHA DMG** with `bundle.targets` including `dmg` and `CI=true` — confirm `--skip-jenkins` fixes the [#413](https://github.com/ccanalesb/lightroom-tagger/issues/413) local AppleScript failure.
2. **`latest.json` URL shape:** override `tauri-action` API asset URLs with **`browser_download_url`** or `github.com/.../download/...` links to reduce REST quota exposure (**unconfirmed** benefit; needs updater plugin compatibility test).
3. **Release runner pin:** adopt **`ubuntu-22.04` + `windows-latest` + `macos-latest`** vs spike’s 24.04/2022 for parity with glibc/WebKitGTK baseline — document chosen floor in CI.
4. **Monorepo workflow layout:** `projectPath`, backend pack job, and whether one consolidated publish job replaces per-job `tauri-action` release creation (**unconfirmed** race/retry behavior under concurrent matrix uploads beyond `upload-version-json` merge).
