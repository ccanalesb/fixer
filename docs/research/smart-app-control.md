# Smart App Control (SAC) and unsigned Electron on Windows 11

Research for wayfinder map [#382](https://github.com/ccanalesb/lightroom-tagger/issues/382) / ticket [#408](https://github.com/ccanalesb/lightroom-tagger/issues/408). Builds on [#383](https://github.com/ccanalesb/lightroom-tagger/issues/383) unsigned-install research (`docs/research/unsigned-electron-install.md` on branch `research/unsigned-electron`).

Scope: **Windows 11 x64**, **electron-builder NSIS** installer from **GitHub Releases**, **v1 unsigned** (no Authenticode). Child processes/binaries typical of this stack: main `*.exe`, bundled **`node.exe`**, **`.node`** native addons, **`uv.exe`**, **`python.exe`**.

Method: primary sources (Microsoft Learn, Microsoft Support, Azure docs, SignPath/Certum). Secondary analysis (BSI study, Eric Lawrence MOTW blog) labeled where not Microsoft-official. Unconfirmed items marked **unconfirmed**.

---

## TL;DR

- **SAC “On” (enforcement)** is stricter than SmartScreen: for code the cloud cannot confidently predict safe, **unsigned or invalidly signed binaries are blocked**—not a “More info → Run anyway” flow. Microsoft documents **no per-app bypass** except turning SAC off or getting the app **properly signed** ([SAC FAQ](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions), [overview](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)).
- **Unsigned v1 Electron NSIS + installed tree:** Expect **hard blocks** on SAC-On machines for the **installer** and **each unsigned executable/DLL** loaded at runtime unless Microsoft’s intelligence later recognizes them (**unconfirmed** for a niche OSS app). SmartScreen-style warnings apply when SAC is **Off** ([SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)).
- **Evaluation mode** does **not** block; it may later flip to **On** or **Off** based on usage ([Support — App & browser control](https://support.microsoft.com/en-us/windows/security/windows-security/app-browser-control-in-the-windows-security-app)). **Enterprise-managed** PCs: SAC disabled ([Application Control](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/appcontrol)).
- **Prevalence:** Microsoft does **not** publish SAC-On adoption rates. **Estimate (unconfirmed):** SAC-On is a **minority** of all Windows 11 PCs (many in-place upgrades never get SAC; evaluation disables for “developer-like” use; enterprise off)—but **non-zero** on **clean-install consumer** Win11 22H2+.
- **Signing fixes the SAC gap** if **all** shipped binaries are signed with a cert from the [Microsoft Trusted Root Program](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control): **SignPath Foundation (free OSS)**, **Azure Artifact Signing (~$9.99/mo)**, **Certum Open Source (~€69)**, or **standard OV** (~$150–300/yr)—not self-signed. **Sign the installer and every `.exe`/`.dll`/`.node`**, not just the NSIS entry point ([Security Book](https://learn.microsoft.com/en-us/windows/security/book/application-security-application-and-driver-control), [test with SAC](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control)).
- **MOTW:** Browser downloads get `Zone.Identifier` (Mark of the Web). SAC adds **extra ShellExecute blocks** for many **script/archive types with MOTW**; **`.exe` is not** on that extension list (**unconfirmed** for SAC policy changes after 2024). SAC still evaluates **loaded PE images** regardless; installed files usually **lose MOTW** after NSIS copy (**unconfirmed** edge cases with stream-preserving copy tools).
- **Re-enable SAC after turning off:** As of **2026**, recent Windows 11 updates (e.g. **KB5079391** preview / **KB5086672**, March 2026) allow toggling SAC **On/Off without clean reinstall** on supported builds; older docs still mention one-way/off-by-reset behavior—users should be on current 24H2/25H2 + updates ([KB5079391](https://support.microsoft.com/en-us/servicing/os/windows-11/2026/03/march-26-2026-kb5079391-os-builds-26200.8116-and-26100.8116-preview), [SAC FAQ](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions)).

---

## How SAC decides: block, allow, or warn

Microsoft’s documented decision order when SAC is in **enforcement (“On”)**:

1. **Cloud intelligence** — if confidently **safe**, run; if **malicious/PUA**, block.
2. If **no confident prediction** — require a **valid Authenticode signature** from a CA in the **Microsoft Trusted Root Program**; otherwise treat as **untrusted** and **block** ([SAC FAQ — “How does Smart App Control work?”](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions), [overview](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)).

There is **no** documented “warn but allow” tier for untrusted unsigned code under SAC-On—users see a **block notification** ([BSI study citing Microsoft UX](https://www.bsi.bund.de/SharedDocs/Downloads/EN/BSI/Publications/Studies/Smart_App_Control/Studie_Smart_App_Control.pdf) — independent validation of enforcement UX; align with [FAQ — no per-app bypass](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions)).

**User bypass without turning SAC off:** **None** per Microsoft ([SAC FAQ](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions)). Workarounds that disable SAC (Settings → Windows Security → App & browser control → Smart App Control → **Off**) are the supported escape hatch; **re-enabling** is supported on **recent 2026 updates** without reinstall ([SAC FAQ](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions), [KB5079391 SAC note](https://support.microsoft.com/en-us/servicing/os/windows-11/2026/03/march-26-2026-kb5079391-os-builds-26200.8116-and-26100.8116-preview)).

**Malware/PUP predicted unsafe** stays blocked even if signed ([overview](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)).

---

## Unsigned NSIS installer and installed Electron app

### NSIS `.exe` installer (from GitHub Releases)

| SAC mode | Expected behavior (unsigned installer) |
|----------|----------------------------------------|
| **Off** | **SmartScreen** “Windows protected your PC”; **More info → Run anyway** ([SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)). |
| **Evaluation** | **No SAC block** (may log audit events **3076**) ([Test with SAC](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control)). |
| **On** | **Block** if unsigned and not cloud-whitelisted ([overview](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)). **No** SmartScreen “Run anyway” when SAC replaces app/file reputation path for execution control (**unconfirmed** exact UI strings for NSIS vs generic `.exe`; installer failures may require correlating **3077** events to blocked files inside the installer — [Test with SAC — event log note](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control)). |

Independent testing (BSI) classifies **setup-style `.exe` installers** as in scope for SAC analysis alongside `.exe`/`.dll`/`.msi` ([BSI study §3.3.1](https://www.bsi.bund.de/SharedDocs/Downloads/EN/BSI/Publications/Studies/Smart_App_Control/Studie_Smart_App_Control.pdf)).

### Installed application (`electron.exe`, `node.exe`, `.node`, `uv.exe`, `python.exe`, …)

SAC evaluates binaries as the **OS loader** loads them ([Test with SAC](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control); [Security Book — sign all binaries](https://learn.microsoft.com/en-us/windows/security/book/application-security-application-and-driver-control)). An unsigned **main EXE** blocked at launch prevents the app entirely. Unsigned **DLLs / native addons** (`.node` files are PE DLLs) can fail when first loaded even if the top-level EXE were somehow allowed (**unconfirmed** exact `.node` extension handling; treat as **DLL-equivalent** for signing planning).

**Partial signing (installer only):** **Insufficient** for SAC compliance per Microsoft guidance to sign **install/uninstall artifacts and all binaries** ([Test with SAC](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control), [Security Book](https://learn.microsoft.com/en-us/windows/security/book/application-security-application-and-driver-control)).

**Reputation-only path:** Microsoft states intelligence **may change over time** for unsigned code ([Application Control](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/appcontrol)). A **new, low-download OSS** desktop app should **not** be assumed to gain “known safe” predictions quickly (**unconfirmed**).

---

## When is SAC on? Modes, eligibility, auto-off

| Topic | Source-backed behavior |
|-------|-------------------------|
| **First availability** | SAC ships on **clean installs** of Windows 11 **22H2+** ([Microsoft Security Blog 2022](https://www.microsoft.com/en-us/security/blog/2022/09/20/new-windows-11-security-features-are-designed-for-hybrid-work/), [Support — “new Windows 11 installs only”](https://support.microsoft.com/en-us/windows/security/windows-security/app-browser-control-in-the-windows-security-app)). |
| **In-place upgrade from Win10 / older Win11** | Historically **cannot enable** SAC without **reset/reinstall** ([Support](https://support.microsoft.com/en-us/windows/security/windows-security/app-browser-control-in-the-windows-security-app)). **2026 updates** add manual **On** without clean install on supported releases ([SAC FAQ](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions)). |
| **Default after clean install** | Starts in **Evaluation** ([Support](https://support.microsoft.com/en-us/windows/security/windows-security/app-browser-control-in-the-windows-security-app), [overview](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)). |
| **Evaluation → On** | If Windows decides user is a “good candidate,” SAC turns **On** (toast when entering enforcement — [overview FAQ](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)). |
| **Evaluation → Off** | **Developer-like / corporate-like** activity → auto **Off** ([SAC FAQ](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions), [overview](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)). |
| **Enterprise-managed** | SAC **disabled**; **WDAC/App Control for Business** instead ([Application Control](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/appcontrol)). Evaluation **auto-off within 48h** on enterprise-managed unless user enables first ([Application Control](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/appcontrol)). |
| **Developer Mode** | Listed as a reason SAC may be **off** ([SAC FAQ](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions)). |
| **Optional diagnostic data off** | SAC **off**; turning on may require reset/reinstall with optional diagnostics enabled during setup ([SAC FAQ](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions)). |
| **Windows 11 in S mode** | SAC not available until S mode removed + reset ([SAC FAQ](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions)). |
| **Region** | No Microsoft doc found listing **country exclusions** for SAC itself (**unconfirmed** geo gaps). Artifact Signing has **separate** geo limits (below). |

**Leaving Evaluation:** Microsoft states you **cannot return to Evaluation** after manual On/Off or completed evaluation except **reinstall/reset** ([Support](https://support.microsoft.com/en-us/windows/security/windows-security/app-browser-control-in-the-windows-security-app)).

---

## How common is SAC-On? (prevalence)

**Microsoft-published:** SAC is included on **clean Win11 22H2+** installs and may auto-enable after evaluation ([Security Blog 2022](https://www.microsoft.com/en-us/security/blog/2022/09/20/new-windows-11-security-features-are-designed-for-hybrid-work/)). **No official percentage** of SAC-On vs Off vs Evaluation was found in primary sources.

**Reasoning for planning (all unconfirmed estimates):**

- Large share of Win11 fleet = **in-place upgrades** → SAC **unavailable/off** per Support “new installs only” ([Support](https://support.microsoft.com/en-us/windows/security/windows-security/app-browser-control-in-the-windows-security-app)).
- **Developers / power users** disproportionately represented in GitHub-Releases audience → evaluation may **disable** SAC ([SAC FAQ](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions)).
- **Enterprise** fleet → SAC **off** ([Application Control](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/appcontrol)).
- **Residual risk:** **Non-developer consumers** on **new OEM/clean-install** PCs are the main SAC-On cohort.

**Product implication:** Unsigned v1 is ** viable for many** Win11 users (SAC off + SmartScreen bypass) but ** fails closed** for an **unknown fraction** of SAC-On home users—with **no** in-app workaround.

---

## Mark of the Web (MOTW) and SAC

**MOTW:** Browsers tag downloads with NTFS **`Zone.Identifier`** (`ZoneId=3` = Internet) ([Eric Lawrence — Downloads and MOTW](https://textslashplain.com/2016/04/04/downloads-and-the-mark-of-the-web/) — widely cited Windows behavior; not a Microsoft Learn article).

**SmartScreen** uses MOTW for **first-run reputation** on the **entry** download ([SmartScreen overview](https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/microsoft-defender-smartscreen-overview)).

**SAC + MOTW (secondary source):** When SAC is enabled, **additional file types** (includes **`.dll`**, scripts, **not `.exe`**) may be **blocked at `ShellExecute`** if MOTW is present ([Eric Lawrence MOTW article — SAC section](https://textslashplain.com/2016/04/04/downloads-and-the-mark-of-the-web/)). **Unconfirmed** whether Microsoft Learn publishes the current extension list.

**Download path vs other paths:**

- **Browser / GitHub web UI:** MOTW **expected** on the installer.
- **`curl`, `gh release download`, copied from USB, built locally:** Often **no MOTW** — SmartScreen/SAC interactions differ; **SAC-On still blocks unsigned PE at load** regardless of MOTW ([overview](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)).
- **After NSIS install:** Files created under `Program Files` are typically **new local files without MOTW**; SAC enforcement then hinges on **signature / cloud**, not MOTW (**unconfirmed** if any installer preserves ADS).

**Do not** document MOTW stripping as end-user guidance for untrusted binaries (security anti-pattern; only noted for threat-model completeness).

---

## Signing routes for an individual OSS maintainer

Goal: satisfy SAC when cloud prediction fails — **valid signature from Microsoft Trusted Root CA** ([code signing for SAC](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control), [SAC FAQ for developers](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions)).

| Route | Cost | OSS / individual fit | SAC / SmartScreen notes |
|-------|------|----------------------|-------------------------|
| **SignPath Foundation** | Free (SignPath.io donation) | OSI license, public repo, maintained release, [terms](https://signpath.org/terms.html); cert issued to **SignPath Foundation** (publisher name) | Windows Authenticode via HSM; **manual** release approval; covers **Windows only** ([signpath.org](https://signpath.org/)) |
| **Azure Artifact Signing** (Trusted Signing) | **$9.99/mo** Basic (5k sigs/mo); **$99.99/mo** Premium ([SKU doc](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-change-sku)) | **Individuals: US & Canada only**; orgs broader (US, CA, EU, UK, AU, NZ, JP, KR, SG, CH, NO, IL) ([Artifact Signing quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)); Entra Verified ID / ID doc + selfie for individuals ([Tech Community Nov 2024](https://techcommunity.microsoft.com/blog/microsoft-security-blog/trusted-signing-is-now-open-for-individual-developers-to-sign-up-in-public-previ/4273554)) | Microsoft-managed public trust; **SmartScreen reputation still builds over time** ([Code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)); enables SAC/SmartScreen **signature path** |
| **Certum Open Source Code Signing** | From **~€69** (hardware token set) ([Certum shop](https://shop.certum.eu/open-source-code-signing.html)) | **Individuals** with public OSS; not for commercial dual-use ([required documents](https://support.certum.eu/en/code-signing-required-documents/)) | Microsoft-trusted Authenticode; CN includes “Open Source Developer” |
| **Standard OV code signing** (DigiCert, Sectigo, etc.) | **~$150–300/year** ([Code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)) | Worldwide; org/individual per CA policy | **OV satisfies SAC** when signature valid ([SAC FAQ](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions)); SmartScreen reputation **not instant** (EV no longer special since ~2024 — [Code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)) |
| **Self-signed / unsigned** | Free | — | SAC-On: **block**; SmartScreen: **block/warn** |

**electron-builder note:** Signing must cover **NSIS installer**, **app EXE**, **`resources/**/*.dll` / `.node`**, bundled **`node.exe`**, **`uv.exe`**, **`python.exe`**, uninstaller — match CI signing hooks or post-build sign pass ([Test with SAC](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control)).

---

## Options for grilling (#391 / #392) — not a decision

These are **mutually exclusive product/security postures** for the map; pick one in grilling.

| Option | Upside | Downside |
|--------|--------|----------|
| **A. Ship unsigned v1; document SmartScreen + “disable SAC if blocked”** | Zero cert cost/time; matches current v1 plan | **Hard failure** for SAC-On users; support burden; publisher trust weak |
| **B. SignPath Foundation before public Windows release** | **$0**; trusted cert; CI-friendly | Publisher = **SignPath Foundation**; application + policy overhead; approval latency |
| **C. Azure Artifact Signing** | Low monthly cost; Microsoft-preferred path ([Security Book](https://learn.microsoft.com/en-us/windows/security/book/application-security-application-and-driver-control)) | **US/CA individuals only**; Azure + ID verification; sign **every binary** in release |
| **D. Certum OSS or commercial OV** | Works outside US/CA individuals; traditional cert | Hardware token (Certum) or yearly fee; still need **full-tree signing** |
| **E. Defer Windows desktop GA until signing pipeline proven on SAC test VM** | Avoids shipping a known dead-end for SAC-On cohort | Delays Windows channel |

---

## Testing recommendation (unconfirmed scope for this repo)

Microsoft documents SAC testing via **Evaluation + CodeIntegrity 3076/3077** logs or enforced **On** ([Test with SAC](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control)). A **clean-install Win11 VM** with SAC **On**, optional **Evaluation** first, install from **browser-downloaded** GitHub Release artifact, exercise **all features** that load native addons / spawn **uv** or **python**.

---

## References

- [Smart App Control overview](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)
- [Smart App Control FAQ (Support)](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions)
- [App & browser control (Support)](https://support.microsoft.com/en-us/windows/security/windows-security/app-browser-control-in-the-windows-security-app)
- [Application Control for Windows (SAC + enterprise)](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/appcontrol)
- [Test your app with Smart App Control](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control)
- [Sign your app for Smart App Control compliance](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control)
- [Windows 11 Security Book — SAC](https://learn.microsoft.com/en-us/windows/security/book/application-security-application-and-driver-control)
- [Code signing options for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- [SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
- [Artifact Signing quickstart (geo + individual rules)](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
- [Artifact Signing SKU / pricing tiers](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-change-sku)
- [SignPath Foundation terms](https://signpath.org/terms.html)
- [Certum Open Source Code Signing](https://shop.certum.eu/open-source-code-signing.html)
- [BSI Smart App Control study (PDF)](https://www.bsi.bund.de/SharedDocs/Downloads/EN/BSI/Publications/Studies/Smart_App_Control/Studie_Smart_App_Control.pdf)
- [Downloads and Mark of the Web (Eric Lawrence)](https://textslashplain.com/2016/04/04/downloads-and-the-mark-of-the-web/)
- [KB5079391 — SAC toggle without clean install (2026 preview)](https://support.microsoft.com/en-us/servicing/os/windows-11/2026/03/march-26-2026-kb5079391-os-builds-26200.8116-and-26100.8116-preview)
