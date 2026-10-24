# Licenses for redistributing the bundled desktop runtime

**GitHub issue:** [#409](https://github.com/ccanalesb/lightroom-tagger/issues/409) · **Map:** [#382](https://github.com/ccanalesb/lightroom-tagger/issues/382)  
**Date:** 2026-10-24  
**Scope:** Public GitHub Releases installers (macOS dmg/zip, Windows NSIS, Linux AppImage) bundling Electron/Chromium, optional Node 24, backend/frontend npm production deps (`apps/visualizer/backend/package.json`, `apps/visualizer/frontend/package.json`), and either standalone `uv` (runtime-managed Python + wheels) or embedded Python + wheels for ONNX export. **Model weight files are not shipped** ([ADR-0020](../adr/0020-laya-in-node-through-onnx.md)).

> **Not legal advice.** This is factual research from primary public sources (license texts, upstream NOTICE files, official docs). Obligations depend on exact packaging choices, versions, and jurisdictions. Confirm with counsel before shipping.

---

## TL;DR

- **Nothing identified forbids** public redistribution of this stack in an installer, provided you **honor notice and copyleft rules** for LGPL/CDDL components and **do not strip** upstream license files.
- **Highest-attention components:** `@img/sharp-libvips-*` (**LGPL-3.0-or-later**, dynamically linked shared lib) and **`libraw-wasm`** (LibRaw **LGPL-2.1 or CDDL-1.0**, **statically linked inside `.wasm`**). Plan a **THIRD-PARTY-NOTICES** (or equivalent) plus **LGPL/CDDL source/corresponding-source offers** for those libraries.
- **Electron/Chromium:** Ship **Electron’s MIT `LICENSE`** and **`LICENSES.chromium.html`** (Chromium/ffmpeg and hundreds of deps). **Do not assume** electron-builder copies them without verification — behavior is **electron-builder version–dependent**; older macOS builds **deleted** these files; recent releases **retain** them in the `.app` ([electron-builder #9407](https://github.com/electron-userland/electron-builder/pull/9407)).
- **Permissive bulk:** Node/Electron app JS deps (MIT/Apache/BSD/ISC), **onnxruntime-node** (MIT + large `ThirdPartyNotices.txt`), **SQLite** (public domain via amalgamation), **sqlite-vec** (MIT OR Apache), **uv** (MIT + Apache-2.0), **PyTorch** (BSD-3-Clause + third-party notices) — standard **copyright + license text** redistribution.
- **Bundling vs download-at-runtime:** The **installer** triggers obligations only for **binaries you place in the artifact**. **`uv`-only** packaging shifts Python/torch/transformers wheels to **first download on the user machine** (still subject to those projects’ licenses when copies are made, but **not** the same as pre-bundling in the installer). **Embedded Python + wheels** pulls **python-build-standalone** (PSF + many bundled libs) and wheel trees into **your** redistribution set.
- **This repo’s license gap:** Root `package.json` declares **ISC** but there is **no `LICENSE` file** and GitHub reports **`license: null`**. Before distributing **your own** binaries, add a root **`LICENSE`** (ISC text) and a clear **third-party notices** file; `private: true` on app packages does not replace a grant for the overall product.

---

## Obligations at a glance

| Component | SPDX / license (primary source) | In typical installer? | Redistribution highlights | Forbids bundling? |
|-----------|----------------------------------|------------------------|---------------------------|-------------------|
| **Electron** | MIT ([`electron/electron` LICENSE](https://github.com/electron/electron/blob/main/LICENSE)) | Yes | Include MIT notice | No |
| **Chromium + ffmpeg (via Electron)** | BSD-3-Clause + many ([`LICENSES.chromium.html`](https://www.chromium.org/developers/open-source) shipped with Electron) | Yes | Ship **`LICENSES.chromium.html`**; ffmpeg patent/LGPL pieces covered in Chromium notices | No |
| **Node.js binary** (if bundled separately from Electron) | MIT ([Node `LICENSE`](https://github.com/nodejs/node/blob/main/LICENSE)) | Optional | Include Node license + notices | No |
| **sharp** | Apache-2.0 ([sharp LICENSE](https://github.com/lovell/sharp/blob/main/LICENSE)) | Yes (JS + native binding) | Apache NOTICE if present; retain license | No |
| **@img/sharp-libvips-*** (prebuilt libvips) | **LGPL-3.0-or-later** (npm `license` field, [sharp-libvips THIRD-PARTY-NOTICES](https://github.com/lovell/sharp-libvips/blob/main/THIRD-PARTY-NOTICES.md)) | Yes (platform `.so`/`.dylib`/`.dll`) | **LGPL combined-work:** prominent notice, LGPL/GPL texts, **shared-library linking** (sharp uses separate libvips dylib — [maintainer clarification](https://github.com/lovell/sharp-libvips/issues/246#issuecomment-2305204411)); **corresponding source** / written offer for libvips (and honor user relinking). Statically linked deps *inside* libvips tarball are upstream’s concern | No |
| **libraw-wasm** (wrapper) | ISC declared ([npm](https://www.npmjs.com/package/libraw-wasm)); **no LICENSE file in package** | Yes | Include ISC-style notice for wrapper; **[unconfirmed]** exact copyright line | No |
| **LibRaw inside `libraw.wasm`** | **LGPL-2.1 OR CDDL-1.0** (recipient chooses) ([LibRaw about](https://www.libraw.org/about)) | Yes (static WASM) | **Stronger than libvips:** static linking → LGPL **§6** (corresponding source / object files for relinking) **or** CDDL source-offer if CDDL chosen; document choice in notices | No |
| **onnxruntime-node** | MIT ([LICENSE](https://github.com/microsoft/onnxruntime/blob/main/LICENSE)) | Yes (native `.node` + libs) | MIT notice + **`ThirdPartyNotices.txt`** ([v1.24.3](https://github.com/microsoft/onnxruntime/blob/v1.24.3/ThirdPartyNotices.txt)) | No |
| **@huggingface/transformers** | Apache-2.0 (npm) | Yes (JS; may pull sharp/onnx) | Apache-2.0 NOTICE; model **weights not bundled** ([ADR-0020](../adr/0020-laya-in-node-through-onnx.md)) — HF model licenses apply when **user** installs models | No |
| **better-sqlite3 / SQLite** | MIT (binding) + **SQLite public domain** ([sqlite.org/copyright](https://www.sqlite.org/copyright.html)) | Yes | MIT for binding; optional SQLite PD statement | No |
| **sqlite-vec** (+ platform `vec0` ext) | **MIT OR Apache** (npm) | Yes | Include chosen license text | No |
| **uv** | **MIT + Apache-2.0** ([LICENSE-MIT](https://github.com/astral-sh/uv/blob/main/LICENSE-MIT), [LICENSE-APACHE](https://github.com/astral-sh/uv/blob/main/LICENSE-APACHE)) | If bundled for export | Include both or dual notice | No |
| **python-build-standalone** (embedded Python path) | PSF + per-lib ([docs](https://gregoryszorc.com/docs/python-build-standalone/main/running.html#licensing), [python-licenses.rst](https://github.com/astral-sh/python-build-standalone/blob/main/python-licenses.rst)) | If embedded | Ship license texts/metadata from distribution JSON; **avoid** older builds linking **GPL readline/GDBM** (docs: 3.10+ tarballs avoid that GPL encumbrance) | No (pick build flavor) |
| **torch / transformers wheels** (embedded path) | BSD-3 ([PyTorch LICENSE](https://github.com/pytorch/pytorch/blob/main/LICENSE)) + wheel metadata | If embedded | BSD notice + PyTorch/third-party notices bundled in wheels | No |
| **torch / transformers wheels** (`uv` runtime download) | Same | Downloaded post-install | User/Astral/PyPI copies; **installer publisher** still documents that runtime install occurs; **lower** pre-ship notice burden for wheels **not** in installer | No |
| **HF model files** | Model-specific | **Not redistributed** | User accepts HF/model card terms when downloading | N/A |
| **lightroom-tagger app source** | **ISC declared, no LICENSE file** | Your binary | Add **`LICENSE`**; ISC requires copyright + permission notice on copies | No explicit ban; **grant unclear** without file |

---

## electron-builder and `LICENSES.chromium.html`

**Primary facts**

- Electron ships **`LICENSE`** (MIT) and **`LICENSES.chromium.html`** next to the prebuilt app under `node_modules/electron/dist/` ([Electron license](https://github.com/electron/electron/blob/main/LICENSE)).
- Chromium redistribution expects the generated **`LICENSES.chromium.html`** to accompany binaries ([Chromium open-source](https://www.chromium.org/developers/open-source)).
- **electron-builder does not automatically guarantee** both files survive packaging on all platforms/versions:
  - Historical behavior: macOS packaging **unlinked** `LICENSE` / `LICENSES.chromium.html` from the output tree ([community analysis with source pointers](https://github.com/no-human-ai/no_human/blob/main/THIRD-PARTY-NOTICES.md)); maintainer **develar** once noted builder might omit `LICENSES.chromium.html` ([issue #1495](https://github.com/electron-userland/electron-builder/issues/1495)).
  - **Fix (2025+):** `app-builder-lib` changelog records retaining **`LICENSE.electron.txt`** and **`LICENSES.chromium.html`** inside macOS **`Contents/Resources`** ([#9407](https://github.com/electron-userland/electron-builder/pull/9407)).

**Recommendation for #382:** Pin electron-builder version, **inspect each release artifact** (mac/win/linux) for `LICENSES.chromium.html` and Electron license, and if missing add **`extraResources`** from `node_modules/electron/dist/LICENSES.chromium.html` (pattern used by other Electron apps, e.g. [HermesOffice `electron-builder.cjs`](https://github.com/criptogus/HermesOffice/blob/a4854304/apps/shell/electron-builder.cjs)). **[Unconfirmed]** for the exact electron-builder version #382 will adopt until packaging exists.

---

## sharp / `@img/sharp-libvips` (LGPL)

**Licenses (primary)**

- **sharp:** Apache-2.0 — [LICENSE](https://github.com/lovell/sharp/blob/main/LICENSE).
- **Prebuilt libvips npm packages** (e.g. `@img/sharp-libvips-darwin-arm64`): npm declares **`LGPL-3.0-or-later`**.
- **libvips upstream:** LGPLv2+; prebuilts use **LGPLv3** shared libraries ([sharp-libvips README](https://github.com/lovell/sharp-libvips)).
- **Dependencies compiled into libvips** (glib, libheif, etc.): listed in [THIRD-PARTY-NOTICES.md](https://github.com/lovell/sharp-libvips/blob/main/THIRD-PARTY-NOTICES.md) (many LGPLv3/static within the `.so`).

**Linking model (maintainer)**

- Prebuilt **sharp** loads **libvips as a separate shared library** (not a single statically linked sharp+libvips `.node`), deliberately so consumers stay under **Apache-2.0** for sharp and **LGPL** only for libvips ([issue #4023](https://github.com/lovell/sharp/issues/4023), [#246](https://github.com/lovell/sharp-libvips/issues/246)).
- **LGPLv3 §4** (combined work): provide **prominent notice**, **LGPL + GPL texts**, and use a **suitable shared library mechanism** (§4(d)(1)) — user can replace libvips with a modified compatible library ([LGPLv3 text — gnu.de mirror](https://www.gnu.de/documents/lgpl.en.html)).

**Practical packaging**

- Ship **`libvips*.dylib` / `.so` / `.dll`** inside the app (electron-builder usually does via unplugged native deps).
- Add **`THIRD-PARTY-NOTICES`**: LGPL-3.0 for libvips, pointer to [sharp-libvips source](https://github.com/lovell/sharp-libvips) / libvips version in `versions.json`.
- Provide **written offer or URL** for **corresponding source** of the exact libvips build (common pattern: link to GitHub tag + build scripts for `@img/sharp-libvips` version pinned in lockfile).

**Does not:** force your TypeScript/Electron app to become LGPL, when libvips remains a **replaceable shared library**.

---

## libraw-wasm / LibRaw (LGPL-2.1 / CDDL)

**Licenses**

- npm **`libraw-wasm@1.6.0`**: declares **ISC**; package contains **no LICENSE file** ([npm](https://www.npmjs.com/package/libraw-wasm)).
- **LibRaw** (embedded in `dist/libraw.wasm`): **LGPL-2.1 OR CDDL-1.0** at recipient’s choice ([LibRaw about](https://www.libraw.org/about), [LICENSE.CDDL](https://github.com/LibRaw/LibRaw/blob/master/LICENSE.CDDL)).

**Linking model**

- WASM build **statically links** LibRaw into **`libraw.wasm`** — not a separate `.so`. Sharp’s maintainer notes WASM builds are the exception and likely fall under LGPL **§4(d)(0)** (corresponding source + application code for relinking) ([sharp #4023](https://github.com/lovell/sharp/issues/4023)).

**Practical packaging**

- Document **LibRaw** copyright and **which license option** you rely on (LGPL vs CDDL) in third-party notices (see e.g. [Kepla NOTICE pattern](https://www.getkepla.com/tools/raw/NOTICE.txt)).
- For **LGPL-2.1**: plan **corresponding source** for LibRaw version used in the wasm build + means to rebuild/relink (object files or full source + build script) — **[unconfirmed]** exact LibRaw version inside published wasm without rebuilding from [LibRaw-Wasm](https://github.com/ybouane/LibRaw-Wasm) tag **v1.6.0**.
- **CDDL** alternative: if elected, comply with CDDL **§3** source availability for covered files ([LICENSE.CDDL](https://github.com/LibRaw/LibRaw/blob/master/LICENSE.CDDL)).

**Does not:** forbid bundling; **does** impose **stronger** compliance work than dynamic libvips.

---

## onnxruntime-node (MIT + third parties)

- **License:** MIT — [onnxruntime LICENSE](https://github.com/microsoft/onnxruntime/blob/main/LICENSE).
- **Notices:** Large **`ThirdPartyNotices.txt`** per release (e.g. [v1.24.3](https://github.com/microsoft/onnxruntime/blob/v1.24.3/ThirdPartyNotices.txt)) — include in installer or aggregate notices file.
- Native binary is redistributable under MIT terms; patent clauses in upstream components are disclosed in third-party file.

---

## SQLite, better-sqlite3, sqlite-vec

- **SQLite library:** Public domain dedication — [sqlite.org/copyright](https://www.sqlite.org/copyright.html).
- **better-sqlite3:** MIT (npm); bundles SQLite amalgamation.
- **sqlite-vec@0.1.9:** **MIT OR Apache** (npm); platform packages (e.g. `sqlite-vec-darwin-arm64`) same — ship extension `.dylib`/`.so`/`.dll` with license text.

---

## Python stack: `uv` vs embedded

### Standalone `uv` in installer

- **uv:** Dual **MIT** + **Apache-2.0** ([LICENSE-MIT](https://github.com/astral-sh/uv/blob/main/LICENSE-MIT), [LICENSE-APACHE](https://github.com/astral-sh/uv/blob/main/LICENSE-APACHE)).
- On model export/install, **uv** downloads **python-build-standalone**-style runtimes and **PyPI wheels** (torch, transformers, etc.) to the user cache — those copies are **not in the GitHub Release installer** but appear on disk after first use ([ADR-0020](../adr/0020-laya-in-node-through-onnx.md) export path).

**Distinction:** Your **Release artifact** redistribution set = **uv binary + your app**. **Wheels/Python** downloaded later are **separate distributions** (Astral/PyPI as publishers); still good practice to document in app “open source notices” that runtime install pulls **PSF/BSD/Apache** components.

### Embedded Python + wheels

- **python-build-standalone:** Intended for redistribution; includes **license metadata and texts** in archives ([running.html — Licensing](https://gregoryszorc.com/docs/python-build-standalone/main/running.html#licensing)).
- **Python:** PSF License ([LICENSE.cpython.txt](https://github.com/astral-sh/python-build-standalone/blob/main/LICENSE.cpython.txt)).
- **Bundled libs** (OpenSSL, libffi, etc.): per-lib texts in [python-licenses.rst](https://github.com/astral-sh/python-build-standalone/blob/main/python-licenses.rst). **Note:** docs warn **GDBM/readline → GPL** on **older** Python builds; **3.10+** distributions avoid that linkage.
- **torch:** BSD-3-Clause — [PyTorch LICENSE](https://github.com/pytorch/pytorch/blob/main/LICENSE); wheels include additional `LICENSE`/`NOTICE` files.

---

## @huggingface/transformers and models

- **Library:** Apache-2.0 (npm `@huggingface/transformers`).
- **ONNX / weights:** [ADR-0020](../adr/0020-laya-in-node-through-onnx.md) — models live under git-ignored `models/`; **installers must not ship** Laya/HF weights. Users’ model downloads fall under **each model’s** Hugging Face / card license (out of scope for runtime bundling, but document in product).

---

## Frontend npm deps

Production dependencies (`react`, `vite` build output only ships static assets, not devDependencies): overwhelmingly **MIT/BSD/Apache/ISC**. No copyleft found in **production** `dependencies` list. Dev-only **MPL-2.0** (`lightningcss` via vitest → vite) should **not** ship if production bundle excludes devDependencies.

---

## npm license scan (backend production install)

Method: `npm ci --ignore-scripts` in `apps/visualizer/backend` on **darwin arm64**, then `npx license-checker --summary` (2026-10-24).

| Count | License |
|------:|---------|
| 96 | MIT |
| 14 | BSD-3-Clause |
| 9 | Apache-2.0 |
| 7 | ISC |
| 2 | MPL-2.0 (dev-only: vitest → vite → lightningcss) |
| 1 | **LGPL-3.0-or-later** (`@img/sharp-libvips-darwin-arm64`) |
| 1 | UNLICENSED (private package name only) |

**Copyleft in shipped backend tree (production):** **`@img/sharp-libvips-*` only** (platform-specific). **LibRaw** copyleft is **not** visible to license-checker (embedded in wasm; see LibRaw section).

---

## Repo license state (ccanalesb/lightroom-tagger)

| Signal | Value |
|--------|--------|
| Root `LICENSE` file | **Absent** (search 2026-10-24) |
| Root `package.json` `"license"` | **ISC** |
| GitHub API `license` field | **`null`** |
| `apps/visualizer/backend`, `frontend` | `"private": true`, **no** `license` field |

**Effect (informational, not legal advice):**

- **Public source on GitHub** is **not** public domain. Without a **`LICENSE` file**, GitHub’s license detector stays empty; viewers get limited rights via GitHub ToS, **not** a clear redistribution grant for **your** compiled installers.
- **`package.json` ISC** is a declaration intent but **ISC requires** the copyright notice and permission text on **redistributed copies** — best practice: add root **`LICENSE`** (ISC) before shipping binaries.
- **`private: true`** on subpackages only affects npm publish semantics, **not** third-party obligations in desktop bundles.

---

## Bundling vs downloading at runtime

| Artifact | Who redistributes first | Typical notice obligation |
|----------|-------------------------|---------------------------|
| Electron app + `node_modules` native addons | **You** (GitHub Release) | Full third-party notices for everything inside installer |
| `uv` binary only | **You** | uv MIT/Apache |
| Python runtime via `uv` on first export | **Astral** (python-build-standalone) + **you** as integrator | Document; include if you **cache/repack** downloads inside app data without user action |
| PyPI wheels (torch, etc.) | **PyPI publishers** | Same as above |
| HF models (`models/`) | **User / HF** when installed | Model card licenses; **not** in installer per ADR-0020 |

**Nothing in the surveyed licenses forbids** either **bundling** or **triggering downloads**, as long as license conditions are met for each **conveyed copy**.

---

## Suggested release checklist (engineering)

1. Add root **`LICENSE`** (ISC) and **`THIRD-PARTY-NOTICES.txt`** (or `.md`) in repo and installer.
2. Verify **`LICENSES.chromium.html`** + Electron **`LICENSE`** in **each** platform artifact; use **`extraResources`** if missing.
3. Aggregate: **sharp** (Apache), **libvips** (LGPL + source offer), **libraw-wasm/LibRaw** (ISC + LGPL or CDDL), **onnxruntime** (MIT + ThirdPartyNotices), **sqlite-vec**, **better-sqlite3**, **transformers** (Apache), optional **uv** / **embedded Python** license trees.
4. Pin and record versions (lockfiles, `sharp-libvips` `versions.json`, libraw-wasm tag) for reproducible source offers.
5. Keep **models out** of installers; document HF/model terms in product docs.

---

## References

- Electron MIT: https://github.com/electron/electron/blob/main/LICENSE  
- Chromium licensing: https://www.chromium.org/developers/open-source  
- electron-builder mac license fix: https://github.com/electron-userland/electron-builder/pull/9407  
- sharp / libvips: https://github.com/lovell/sharp , https://github.com/lovell/sharp-libvips  
- LibRaw: https://www.libraw.org/about  
- ONNX Runtime: https://github.com/microsoft/onnxruntime  
- SQLite: https://www.sqlite.org/copyright.html  
- sqlite-vec: https://github.com/asg017/sqlite-vec  
- uv: https://github.com/astral-sh/uv  
- python-build-standalone: https://gregoryszorc.com/docs/python-build-standalone/main/running.html#licensing  
- PyTorch: https://github.com/pytorch/pytorch/blob/main/LICENSE  
- ADR-0020: [../adr/0020-laya-in-node-through-onnx.md](../adr/0020-laya-in-node-through-onnx.md)
