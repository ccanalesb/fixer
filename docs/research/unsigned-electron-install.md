# Unsigned / ad-hoc Electron distribution: install friction and auto-update (v1)

Research for wayfinder map [#382](https://github.com/ccanalesb/lightroom-tagger/issues/382) / ticket [#383](https://github.com/ccanalesb/lightroom-tagger/issues/383).

Scope: **macOS Apple Silicon** (current Gatekeeper on macOS 15 Sequoia and later, including **macOS 27** per Apple Support), **Windows 11 x64** (SmartScreen + Smart App Control), **Linux AppImage** (best-effort). Distribution model: **GitHub Releases**, **electron-builder**-style artifacts, **v1 unsigned** (no Developer ID + notarization, no Windows Authenticode).

Method: primary sources only (Apple, Microsoft, Electron, electron-builder). Anything not confirmed in those sources is marked **unconfirmed**.

---

## TL;DR

- **macOS (ad-hoc-signed `.app`, not notarized):** Expect Gatekeeper on first launch—not a silent double-click. Since **macOS Sequoia**, the **Control-click → Open** bypass is **removed**; users must try to open the app, then use **System Settings → Privacy & Security → Open Anyway**, confirm again, and enter their password. After that, the app is remembered until the bundle changes materially. **Do not ship arm64 builds with signing fully skipped:** invalid/missing signatures often produce **“is damaged”**, which Apple documents as a **non-bypassable** class of block (distinct from “unidentified developer”). **electron-builder does not ad-hoc sign automatically**—set `mac.sign.identity: "-"` on macOS CI (or sign locally) so users get the bypassable “unverified developer” path instead of “damaged.”
- **Windows 11 (unsigned NSIS):** **SmartScreen** shows **“Windows protected your PC”** on first run of the installer and often each new unsigned build; users choose **More info → Run anyway** ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)). This is annoying but workable for power users. **Smart App Control (SAC) in enforcement (“On”)** can **block unsigned apps entirely**—not fixable with “Run anyway” ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)). SAC is off on many enterprise-managed PCs; on consumer PCs it may be in Evaluation and auto-disable, or On.
- **Auto-update when unsigned:**
  - **Windows (NSIS + electron-updater):** **Yes**, with config: unsigned Authenticode is OK if `win.verifyUpdateCodeSignature: false` (or no `publisherName` in `app-update.yml`—**fail-open today, fail-closed in electron-builder v28**). Separate from Authenticode: **electron-builder v27** expects **Ed25519-signed `latest*.yml`** when publishing unless `updateManifest: false`.
  - **Linux (AppImage + electron-updater):** **Yes**—updates verify **SHA-512** from the manifest, not code signatures ([`AppImageUpdater.ts`](https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/src/AppImageUpdater.ts)).
  - **macOS (stock electron-updater / Electron `autoUpdater`):** **No** for install-on-quit—**Squirrel.Mac requires a properly signed app** ([Electron `autoUpdater` docs](https://www.electronjs.org/docs/latest/api/auto-updater)). **`update.electronjs.org` also requires macOS builds to be code-signed** ([README](https://github.com/electron/update.electronjs.org/blob/main/README.md)). Unsigned v1 macOS users **re-download from GitHub** or need a **custom** update path (out of scope for stock tooling).

---

## macOS (Apple Silicon): what users see and do

### What Apple requires (Gatekeeper + notarization)

- Apps from outside the App Store are checked for **Developer ID** signature and (since Catalina) **notarization** ([Safely open apps on your Mac](https://support.apple.com/en-us/102445)).
- Software that is **not signed and not notarized** can still be run only after **manual approval**—Apple warns this is the common malware path ([open a Mac app from an unknown developer](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac), [override security settings](https://support.apple.com/guide/mac-help/open-an-app-by-overriding-security-settings-mh40617/mac)).

### Sequoia and later: no Control-click / right-click Open

Apple states that in **macOS Sequoia**, users **can no longer Control-click to override Gatekeeper** for incorrectly signed or non-notarized software; they must use **System Settings → Privacy & Security** ([Apple Developer News, 2024-08-06](https://developer.apple.com/news/?id=saqachfa)).

**Unconfirmed:** Apple has **not** published a separate Gatekeeper change note for **macOS 27** beyond the same **Open Anyway** flow documented in [Safely open apps on your Mac](https://support.apple.com/en-us/102445) (updated **2026-05-27**, references macOS 27 in the user guide). Assume **Sequoia+ behavior** until Apple documents otherwise.

### Documented first-launch flow (ad-hoc or Developer ID without notarization)

Use this in end-user docs (DMG or ZIP → `.app` in **Applications**):

1. Download the release artifact from GitHub (Safari/Chrome/Firefox applies **`com.apple.quarantine`** to downloaded files—**unconfirmed** in Apple Support for this exact attribute name; Apple describes “downloaded from the internet” checks in [Safely open apps on your Mac](https://support.apple.com/en-us/102445)).
2. Open the **DMG** (or extract the **ZIP**) and drag **`YourApp.app`** to **Applications** (standard drag-install; Apple documents installing non–App Store apps under [Install and uninstall other apps](https://support.apple.com/guide/mac-help/install-and-uninstall-other-apps-mchlp1013/mac)).
3. **First launch:** double-click the app in Applications.
4. If Gatekeeper blocks with **“cannot check for malicious software”** / **unverified developer** (expected for **ad-hoc** or **Developer ID without notarization**):
   - **Do not** rely on **Control-click → Open** on **macOS Sequoia+** ([Apple Developer News](https://developer.apple.com/news/?id=saqachfa)).
   - Open **System Settings → Privacy & Security**, scroll to **Security**, click **Open Anyway** (available for about **one hour** after the failed launch) ([unknown developer](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac)).
   - Enter the **login password** when prompted ([override security settings](https://support.apple.com/guide/mac-help/open-an-app-by-overriding-security-settings-mh40617/mac)).
   - When the warning appears again, click **Open** ([Safely open apps on your Mac](https://support.apple.com/en-us/102445)).
5. **Later launches:** double-click normally—the app is stored as a **security exception** ([unknown developer](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac)).

**After updates:** If Gatekeeper treats the updated bundle as new or modified, users may need **Open Anyway** again ([Safely open apps on your Mac](https://support.apple.com/en-us/102445) — alerts for modified/damaged software). **Unconfirmed:** whether a semver bump with the same `CFBundleIdentifier` always preserves the exception.

### “App is damaged” vs “unverified developer” (quarantine + arm64 Electron)

| Symptom | Typical cause | User fix |
|--------|----------------|----------|
| **“App is damaged and can’t be opened”** / **Move to Trash** | Apple: software **modified, corrupted, or bad signature** ([Safely open apps on your Mac](https://support.apple.com/en-us/102445)). On **Electron arm64**, **unsigned or broken signatures** after download often land here—not a corrupt ZIP ([electron-builder PR #9007](https://github.com/electron-userland/electron-builder/pull/9007)). | **Not** the normal **Open Anyway** path ([PR #9007](https://github.com/electron-userland/electron-builder/pull/9007)). **Prevention:** ship a valid **ad-hoc** signature (`codesign -s -`). **Unconfirmed** in Apple docs: `xattr -d com.apple.quarantine` as end-user workaround. |
| **Unverified / unidentified developer** | No (or ad-hoc) **Developer ID** + not notarized ([Safely open apps on your Mac](https://support.apple.com/en-us/102445)). | **Open Anyway** flow above. |

### electron-builder: ad-hoc signing on arm64

**Current official behavior (electron-builder):**

- If **no certificate** is found, signing is **skipped**—**no automatic ad-hoc signature** ([Code Signing for macOS](https://github.com/electron-userland/electron-builder/blob/master/website/docs/features/code-signing/code-signing-mac.md)).
- **Opt in** to ad-hoc: `mac.sign.identity: "-"` ([mac platform docs](https://www.electron.build/mac.html), [code-signing-mac.md](https://github.com/electron-userland/electron-builder/blob/master/website/docs/features/code-signing/code-signing-mac.md)).
- Ad-hoc builds need **`disable-library-validation`** (electron-builder applies a bundled ad-hoc entitlements template when identity is `"-"`) ([code-signing-mac.md](https://github.com/electron-userland/electron-builder/blob/master/website/docs/features/code-signing/code-signing-mac.md)).
- **Note:** The mac docs line that ad-hoc apps “only run on the machine that built it” ([mac.html](https://www.electron.build/mac.html)) conflicts with Apple’s ad-hoc (`-`) semantics; **distribution intent** is ad-hoc for **Gatekeeper quarantine**, not machine binding—**unconfirmed** which doc is authoritative.

**CI recommendation for v1 unsigned macOS arm64:** build on **macOS**, set **`mac.sign.identity: "-"`**, publish **DMG** (+ **ZIP** if you ever sign for updates). Do **not** set `identity: null` for release artifacts intended for Apple Silicon users.

---

## Windows 11: what users see and do

### SmartScreen (typical consumer experience)

For **unsigned** installers/exes, Microsoft documents:

- First-download behavior: **“Windows protected your PC”** / unrecognized app; user must proceed deliberately ([SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)).
- **No signature:** same warning class as self-signed; user must choose **Run anyway** (via **More info**) ([SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)).
- **Each new unsigned build** rebuilds **file hash reputation from zero**; certificate reputation does **not** carry over without signing ([SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)).
- SmartScreen evaluates downloads from **any browser** ([Microsoft Defender SmartScreen overview](https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/)).

**Documented install steps (NSIS `.exe` from GitHub Releases):**

1. Download the installer (e.g. `App-x64.exe`).
2. Run the installer. If SmartScreen appears: click **More info**, then **Run anyway** ([SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)).
3. Complete the NSIS wizard (install location, shortcuts).
4. Launch the app from Start or the desktop shortcut.
5. **Repeat SmartScreen** may appear on **each version** until reputation builds ([SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)).

### Smart App Control (separate, stricter)

- SAC **blocks malware, PUA, and unknown unsigned code** by default in **enforcement** mode ([Smart App Control overview](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)).
- In **On** mode, apps run only if **Microsoft intelligence recognizes them** or they are signed with a cert from the **Microsoft Trusted Root Program** ([Smart App Control overview](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)).
- SAC may start in **Evaluation** and **turn off automatically** for “developer-like” usage ([Smart App Control overview](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)).
- **Enterprise-managed** devices: SAC is **disabled**; orgs use App Control for Business instead ([Application Control / Smart App Control](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/appcontrol)).
- **Implication for unsigned v1:** SAC-**On** home users may be **unable to run** the app at all—not just warned. **Unconfirmed:** prevalence of SAC **On** vs Evaluation vs Off on fresh Windows 11 installs in 2026.

**Unconfirmed:** Whether SAC blocks **only at process launch** or also blocks the **NSIS installer** before SmartScreen—Microsoft describes blocking “apps and binaries” in enforcement ([Smart App Control overview](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)).

---

## Linux (AppImage): install (best-effort)

Primary sources focus on packaging, not distro Gatekeeper analogs.

**Practical user steps:**

1. Download `*.AppImage` from GitHub Releases.
2. Mark executable (`chmod +x`)—required on most distros (**unconfirmed** as a single canonical doc; AppImage convention).
3. Run `./App-Version.AppImage` (or integrate via desktop file if the build provides one).

No Microsoft/Apple-style signing step for AppImage in electron-builder’s updater ([`AppImageUpdater.ts`](https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/src/AppImageUpdater.ts)).

---

## Auto-update mechanisms when unsigned

### Summary table

| Platform | Stock **electron-updater** (NSIS / AppImage / MacUpdater) | **Electron `autoUpdater`** / **update.electronjs.org** |
|----------|--------------------------------------------------------------|--------------------------------------------------------|
| **Windows NSIS** | **Works** without Authenticode if installer verification is off or `publisherName` absent (see below). Manifest **Ed25519** separate (`updateManifest`). | **update.electronjs.org** targets **Squirrel.Windows** by default ([README](https://github.com/electron/update.electronjs.org/blob/main/README.md))—**not NSIS**. **Unconfirmed** for unsigned Squirrel on SmartScreen. |
| **Linux AppImage** | **Works**—SHA-512 checks, replace AppImage on quit ([`AppImageUpdater.ts`](https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/src/AppImageUpdater.ts)). | **Not supported**—no Linux in `autoUpdater` ([Electron docs](https://www.electronjs.org/docs/latest/api/auto-updater)). |
| **macOS** | **Install path fails**—`MacUpdater` delegates to **`Squirrel.Mac` via `electron.autoUpdater`**, which requires signing ([`MacUpdater.ts`](https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/src/MacUpdater.ts), [Electron `autoUpdater`](https://www.electronjs.org/docs/latest/api/auto-updater)). | **Requires code-signed macOS builds** ([update.electronjs.org README](https://github.com/electron/update.electronjs.org/blob/main/README.md)). |

### Windows NSIS + electron-updater (details)

- **`win.verifyUpdateCodeSignature`** defaults to **`true`**: embeds publisher name and verifies Authenticode on downloaded updates ([win.html](https://www.electron.build/win.html)).
- Set **`win.verifyUpdateCodeSignature: false`** when updates are **not** Authenticode-signed ([win.html](https://www.electron.build/win.html)).
- At runtime, if **`publisherName`** is missing from `app-update.yml`, verification is **skipped** with a warning; **electron-builder v28** will **fail closed** ([`NsisUpdater.ts`](https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/src/NsisUpdater.ts), [win.html](https://www.electron.build/win.html)).
- **`win.sign: false`** disables Authenticode on shipped artifacts ([win.html](https://www.electron.build/win.html)); SmartScreen friction remains.

### Update manifest signing (electron-builder v27, all platforms)

Independent of OS code signing:

- Publishing builds that emit **`latest*.yml`** requires an **Ed25519** update key unless **`updateManifest: false`** ([win.html](https://www.electron.build/win.html), [linux.html](https://www.electron.build/linux.html)).
- **`electron-builder create-update-key`** + env **`ELECTRON_BUILDER_UPDATE_SIGN_KEY`** ([win.html](https://www.electron.build/win.html)).
- This is **not** Apple/Microsoft code signing—it is **project-controlled** manifest integrity for electron-updater.

### macOS: why Squirrel blocks unsigned

- Electron: **“Your application must be signed for automatic updates on macOS. This is a requirement of Squirrel.Mac.”** ([auto-updater.md](https://github.com/electron/electron/blob/main/docs/api/auto-updater.md)).
- Same requirement called out under **macOS APIs that require code signing** ([Code Signing tutorial](https://www.electronjs.org/docs/latest/tutorial/code-signing)).
- **electron-updater `MacUpdater`** pipes the downloaded ZIP to native **`autoUpdater`** / Squirrel ([`MacUpdater.ts`](https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/src/MacUpdater.ts)).

**v1 product implication:** Plan **manual macOS updates** (GitHub Releases) or budget **Developer ID + notarization** before advertising in-app macOS updates.

---

## Copy-paste user documentation (minimal)

### macOS (ad-hoc-signed DMG)

1. Download the **macOS arm64 DMG** from GitHub Releases.
2. Open the DMG and drag the app into **Applications**.
3. Open the app from **Applications**. If macOS blocks it, open **System Settings → Privacy & Security**, click **Open Anyway**, authenticate, then click **Open** when asked again ([Safely open apps on your Mac](https://support.apple.com/en-us/102445)).
4. On **macOS Sequoia and later**, **Control-click → Open** is **not** available for this case ([Apple Developer News](https://developer.apple.com/news/?id=saqachfa)).
5. If you see **“damaged”** instead, the build was likely **not ad-hoc-signed**—download a fixed release or report the issue (see [electron-builder PR #9007](https://github.com/electron-userland/electron-builder/pull/9007)).

### Windows 11 (unsigned NSIS)

1. Download the **Windows x64 installer** (`.exe`) from GitHub Releases.
2. Run the installer. If you see **Windows protected your PC**, click **More info**, then **Run anyway** ([SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)).
3. Finish setup and launch the app.
4. If the app **never starts** and Windows Security shows **Smart App Control** is **On**, you may need a **signed build** or to turn SAC off in **Windows Security → App & browser control** ([Smart App Control overview](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview))—**turning SAC off is a one-way choice via Settings** (**unconfirmed** exact UX string; see Microsoft Q&A linked from SAC docs).

### Linux (AppImage)

1. Download the **AppImage** from GitHub Releases.
2. `chmod +x YourApp-*.AppImage`
3. Run it. In-app updates require the AppImage build to ship **`app-update.yml`** and use **electron-updater** ([`AppImageUpdater.ts`](https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/src/AppImageUpdater.ts)).

---

## References

- Apple Gatekeeper Sequoia change: https://developer.apple.com/news/?id=saqachfa  
- Apple Support — safely open apps / Open Anyway: https://support.apple.com/en-us/102445  
- Apple Support — unknown developer: https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac  
- Apple Support — override security: https://support.apple.com/guide/mac-help/open-an-app-by-overriding-security-settings-mh40617/mac  
- Microsoft SmartScreen reputation: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation  
- Microsoft Defender SmartScreen overview: https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/  
- Microsoft Smart App Control: https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview  
- Electron `autoUpdater` (Squirrel.Mac signing requirement): https://www.electronjs.org/docs/latest/api/auto-updater  
- Electron code signing (Squirrel.Mac): https://www.electronjs.org/docs/latest/tutorial/code-signing  
- update.electronjs.org requirements: https://github.com/electron/update.electronjs.org/blob/main/README.md  
- electron-builder mac / ad-hoc: https://www.electron.build/mac.html  
- electron-builder mac code signing: https://github.com/electron-userland/electron-builder/blob/master/website/docs/features/code-signing/code-signing-mac.md  
- electron-builder win / verifyUpdateCodeSignature: https://www.electron.build/win.html  
- electron-builder ad-hoc vs damaged (PR #9007): https://github.com/electron-userland/electron-builder/pull/9007  
- electron-updater MacUpdater: https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/src/MacUpdater.ts  
- electron-updater NsisUpdater: https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/src/NsisUpdater.ts  
- electron-updater AppImageUpdater: https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/src/AppImageUpdater.ts  
