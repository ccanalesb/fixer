# Shipping System One model conversion inside the desktop installer

Research for GitHub issue [#385](https://github.com/ccanalesb/lightroom-tagger/issues/385) (wayfinder map [#382](https://github.com/ccanalesb/lightroom-tagger/issues/382)). **Does not pick a product option** — facts and trade-offs for grilling [#390](https://github.com/ccanalesb/lightroom-tagger/issues/390).

**Question:** When a user adds a **model in this app** (a System One model run via ONNX in-process), the backend job `laya_model_install` runs `uv run scripts/laya/export_onnx.py` with inline PEP 723 deps (Python `>=3.12,<3.13`, `torch==2.14.0`, `transformers==5.17.0`, ONNX stack, and `laya` from Git). How can a **self-contained Electron installer** make that conversion work with nothing pre-installed on the host?

**Method:** Primary sources ([uv docs](https://docs.astral.sh/uv/), [uv `uv-git` source](https://github.com/astral-sh/uv/blob/main/crates/uv-git/src/git.rs), [PyPI file metadata](https://pypi.org/project/torch/2.14.0/#files), [ADR-0020](../adr/0020-laya-in-node-through-onnx.md)), plus **measured** cold `uv run scripts/laya/export_onnx.py --help` on this machine (macOS arm64, uv 0.13.x, 2026-10-23). Items marked **(unconfirmed)** need a Windows/Linux or packaging spike.

---

## TL;DR

| Option | Installer size added (order of magnitude) | First conversion download (toolchain only) | Offline after prefetch? | Git CLI on user machine? |
|--------|-------------------------------------------|--------------------------------------------|-------------------------|---------------------------|
| **(a) Bundle `uv`; fetch managed Python + wheels on first use** | **~15–17 MB** per platform (`uv` binary only) | **~200 MiB** macOS arm64 / **~190 MiB** Win x64 / **~600+ MiB** Linux x64 (+ **HF model weights**, separate) | Yes, if cache + Python + env populated (`uv run --offline`) | **Yes today** for `git+https://…` deps — **no** if dependency switched to **GitHub archive URL** or vendored wheel |
| **(b) Embed managed Python + pre-resolved wheels/venv in installer** | **~850 MB–1.4 GB** per platform (measured **835 MB** site-packages on macOS arm64; Linux dominated by **555 MB** `torch` wheel) | **HF model weights only** (unless updater refreshes deps) | Yes for toolchain; HF still needs network unless weights bundled | Same git constraint unless deps rewritten |
| **(c) Separate “converter pack” download on first conversion** | **~0** in main installer (or small stub) | Same as (a) or (b), deferred to first use | Same as chosen pack contents | Same git constraint |
| **(d) PyTorch CPU index / explicit CPU wheels** | Same as (a–c) | **Marginal vs default PyPI** for `torch==2.14.0` — PyPI wheels already look **CPU-only** (no `+cu*` tags) | Same | Same |
| **(e) Prebuilt frozen converter binary** (PyInstaller/Nuitka/etc.) | **~800 MB–1.5 GB+** per platform **(unconfirmed)** | Mostly HF weights | Possible | Build-time only |
| **(f) No end-user conversion** — ship only pre-converted ONNX for bundled models | Smallest for custom-model path | N/A for add-your-own | Yes for bundled models | N/A |

**Cross-cutting facts**

- Conversion is **not** the only network use: `export_onnx.py` uses **Hugging Face Hub** for source checkpoints ([ADR-0020](../adr/0020-laya-in-node-through-onnx.md)); that download is **independent** of torch/uv and can be **hundreds of MB to GB** per model.
- **`torch==2.14.0` on PyPI:** **macOS arm64** (`macosx_14_0_arm64`, cp312 **127 MB**), **Windows x64** (**124 MB**), **Linux x64** (`manylinux_2_28_x86_64`, **555 MB**). **No macOS x86_64** wheels for 2.14.0 on PyPI — aligns with wayfinder **macOS arm64** focus; Intel Mac conversion would need a different torch build or Rosetta+x86_64 stack **(unconfirmed)**.
- **`uv` + git:** `git+https://…` resolution **requires a system `git` on PATH** ([uv-git `GIT` lazy static](https://github.com/astral-sh/uv/blob/main/crates/uv-git/src/git.rs), [open issue #4847](https://github.com/astral-sh/uv/issues/4847)). **Workarounds:** pin `laya` to a **GitHub archive tarball URL** (HTTP, no git — **verified** in a throwaway venv 2026-10-23), **vendor a wheel** in app resources, or publish a wheel to an index you control.
- **Disk after first conversion (uv cache + script env):** **~1.7 GB** on a fresh cache dir on macOS arm64 (measured); **~835 MB** in `site-packages` alone. Default cache: [`$XDG_CACHE_HOME/uv` / `%LOCALAPPDATA%\uv\cache`](https://docs.astral.sh/uv/reference/storage/). Managed Python: [`~/.local/share/uv/python`](https://docs.astral.sh/uv/reference/storage/) (**~50 MB** installed for `cpython-3.12.13-macos-aarch64`, **~17 MiB** download per uv).

---

## What the app runs today

| Piece | Role |
|-------|------|
| [`laya-install.ts`](../../apps/visualizer/backend/src/jobs/handlers/laya-install.ts) | `spawn('uv', ['run', SCRIPT, …])`; fails with `UV_MISSING_MESSAGE` if `uv` not on `PATH` |
| [`export_onnx.py`](../../scripts/laya/export_onnx.py) | PEP 723 script; pins torch/transformers/onnx stack + `laya @ git+https://github.com/r33drichards/laya-vision@568feee…` |
| [ADR-0020](../adr/0020-laya-in-node-through-onnx.md) | Run-time inference is **Node/onnxruntime-node**; Python is **one-shot conversion**, not run-time |

---

## Option (a): Bundle standalone `uv` per platform

**Mechanism:** Ship the official uv release artifact ([GitHub releases](https://github.com/astral-sh/uv/releases), e.g. **0.13.5**): **~14.4 MB** macOS arm64, **~15.3 MB** Windows x64, **~16.7 MB** Linux x64 (compressed archives). Point the job at `$APP/resources/uv` and set:

- [`UV_PYTHON_INSTALL_DIR`](https://docs.astral.sh/uv/reference/environment/#uv_python_install_dir) / [`UV_CACHE_DIR`](https://docs.astral.sh/uv/reference/environment/#uv_cache_dir) under the app’s user data directory (keeps cache on same filesystem as env for hardlinks — [cache docs](https://docs.astral.sh/uv/concepts/cache/)).
- Optional: [`UV_PYTHON_DOWNLOADS=automatic`](https://docs.astral.sh/uv/concepts/python-versions/) (default) so first run pulls **python-build-standalone** CPython 3.12.x ([managed Python docs](https://docs.astral.sh/uv/concepts/python-versions/#managed-python-distributions)).

**Installer size added:** **~15–17 MB** (uv only).

**First-conversion download (toolchain, excluding HF weights):**

Measured on macOS arm64 (uv progress lines, 2026-10-23): `torch` **121.4 MiB**, `onnxruntime` **19.9 MiB**, `transformers` **11.7 MiB**, plus ~**60 MiB** smaller wheels — **~189 MiB** wheels + **~17 MiB** managed Python ≈ **~206 MiB**.

Estimated from [PyPI `torch` 2.14.0 cp312 wheels](https://pypi.org/project/torch/2.14.0/#files):

| Platform | Dominant `torch` wheel | Rough toolchain download |
|----------|------------------------|---------------------------|
| macOS arm64 | 127 MB `macosx_14_0_arm64` | **~200 MiB** (consistent with measurement) |
| Windows x64 | 124 MB `win_amd64` | **~190 MiB** **(unconfirmed on device)** |
| Linux x64 | 555 MB `manylinux_2_28_x86_64` | **~600 MiB** **(unconfirmed on device)** |

**Torch 2.14.0 availability (cp312):** **Yes** for the three wayfinder targets on PyPI; macOS wheels are **arm64-only** (`macosx_14_0_arm64`); Linux also has **aarch64** (~454 MB) if that target is ever added.

**Git dependency:** **Requires `git` on PATH** for the current `git+https://…` line ([uv-git source](https://github.com/astral-sh/uv/blob/main/crates/uv-git/src/git.rs)). **Workarounds:**

1. **GitHub archive URL** in PEP 723, e.g. `https://github.com/r33drichards/laya-vision/archive/568feeeada793f70f736756b0f3a7643d1e75910.tar.gz` — installs without git (**tested** 2026-10-23).
2. **Vendor** a built `laya` wheel in the installer and `{ path = … }` / direct URL.
3. **Publish** a wheel to PyPI or a private index.

**Offline:** After a successful online resolve, [`--offline` / `UV_OFFLINE=1`](https://docs.astral.sh/uv/reference/environment/) can reuse the cache; git commits are cached by hash ([cache docs](https://docs.astral.sh/uv/concepts/cache/)). HF snapshot download still needs network unless the model is already local/offline cache.

**Licensing:** uv is **Apache-2.0 OR MIT** ([uv repository licenses](https://github.com/astral-sh/uv)). Managed CPython builds come from [python-build-standalone](https://github.com/astral-sh/python-build-standalone) (Python **PSF License** for the interpreter; bundled third-party libs have their own notices — treat as **NOTICE** material in the installer). Redistributing the **uv binary** is standard for both licenses with attribution.

---

## Option (b): Embed Python + pre-resolved wheels / virtualenv

**Mechanism:** At **build time** (per OS/arch), run `uv run` or `uv sync` equivalent, then ship:

- Managed Python tree (or embed `python3.12` from standalone builds), and
- A complete virtualenv (`site-packages`) for the conversion script.

**Installer size added:**

| Component | macOS arm64 (measured) | Windows / Linux (estimate) |
|-----------|------------------------|------------------------------|
| Conversion `site-packages` | **835 MB** | **~850 MB** Win **(unconfirmed)**; **~1.2–1.4 GB** Linux x64 **(unconfirmed**, driven by 555 MB torch) |
| Managed Python install | **~50 MB** | Similar order **(unconfirmed)** |
| Optional bundled `uv` | 0 if invoking `python` directly | 0 |

**First-conversion download:** **Toolchain: none** if fully preloaded. **HF model weights** still download on first install of each source unless cached or bundled.

**Git at run time:** **None** if `laya` is already installed in the embedded env. Build machines still needed git or tarball/wheel to **create** the env unless CI uses archive URL.

**Offline:** Toolchain offline; HF as above.

**Trade-off:** Largest installer, but most predictable UX and no “wait 10+ minutes on first model” on Linux.

---

## Option (c): Separate converter component (first-use download)

**Mechanism:** Main app installer stays small; on first `laya_model_install` (or explicit “Download converter”), fetch a signed artifact:

- **Pack A:** uv binary + bootstrap script (same as (a), deferred).
- **Pack B:** Prebuilt venv tarball per platform (same bytes as (b), deferred).

**Sizes:** Same tables as (a) or (b); **added to main installer ~0–20 MB** if only a stub/downloader is included.

**Pros:** Smaller initial download; can update converter without shipping a full app release. **Cons:** Second trust boundary, failure modes (partial download, disk space), still needs HF for weights.

---

## Option (d): CPU-only PyTorch index / wheel choice

**Mechanism:** Pin installs to PyTorch’s CPU index, e.g. `https://download.pytorch.org/whl/cpu` ([PyTorch Get Started](https://pytorch.org/get-started/locally/)), via uv `[[tool.uv.index]]` or `--index-url`.

**Effect for this pin set:** PyPI **`torch==2.14.0` wheels already appear CPU-only** (filenames lack CUDA build tags; sizes match CPU builds). Explicit CPU index mainly **prevents accidental CUDA resolution** if pins loosen — **not a large size win** for 2.14.0 on these platforms.

**Linux note:** The **555 MB** Linux x64 wheel is still much larger than macOS/Windows **~124–127 MB** for the same version on PyPI — likely packaging/OpenMP/MKL layout, not “CUDA vs CPU” alone **(unconfirmed root cause)**.

---

## Option (e): Frozen standalone converter executable

**Mechanism:** PyInstaller, Nuitka, or similar bundling Python + torch + script into one binary or folder.

**Installer / pack size:** Expect **similar to or larger than (b)** because torch dominates; cold-start and code-signing on macOS add friction **(unconfirmed)**.

**Git:** Build-time only.

**Why consider at all:** Could drop uv from the installed footprint and invoke a single `convert-onnx` binary from Electron — at the cost of build complexity and updates.

---

## Option (f): Pre-convert only bundled models (no user conversion path)

**Mechanism:** Ship `models/…` ONNX artifacts for default System One models; **disable or omit** `laya_model_install` for custom HF sources in the desktop SKU.

**Size:** ONNX graphs per ADR-0020 (~375 MB vision + ~433 MB decoder per model) — separate from this research’s Python stack.

**Trade-off:** Violates “add a model in this app” unless conversion is always cloud/build-time — likely a **product fork**, not a technical impossibility.

---

## uv cache location, size, and hygiene

| Topic | Detail |
|-------|--------|
| **Default cache dir** | Unix: `$XDG_CACHE_HOME/uv` or `~/.cache/uv`; Windows: `%LOCALAPPDATA%\uv\cache` ([storage](https://docs.astral.sh/uv/reference/storage/)) |
| **Managed Python** | `$XDG_DATA_HOME/uv/python` or `%APPDATA%\uv\data\python` |
| **Script envs** | PEP 723 `uv run` creates envs under cache `environments-v2/` ([storage](https://docs.astral.sh/uv/reference/storage/#script-virtual-environments)) |
| **Measured cold run** | **~1.7 GB** total cache (macOS arm64); **~835 MB** `site-packages`; buckets ~816 MB `archive-v0` + ~835 MB `environments-v2` (hardlinks may dedupe on same volume — [cache physical space preview](https://docs.astral.sh/uv/concepts/cache/#clearing-the-cache)) |
| **Prune** | `uv cache prune` / `uv cache clean` ([cache](https://docs.astral.sh/uv/concepts/cache/)) |
| **Redirect for desktop** | Set `UV_CACHE_DIR` + `UV_PYTHON_INSTALL_DIR` under app user data so uninstall can remove them |

---

## Licensing summary (redistribution)

| Component | License / notes |
|-----------|-----------------|
| **uv** | Apache-2.0 OR MIT — preserve copyright and license text in app notices |
| **CPython (python-build-standalone)** | PSF License — include Python license; standalone builds bundle other libs ([project](https://github.com/astral-sh/python-build-standalone)) |
| **PyTorch / torchvision** | BSD-style license + bundled third-party notices in wheels ([PyTorch LICENSE](https://github.com/pytorch/pytorch/blob/main/LICENSE), [LICENSES_BUNDLED](https://github.com/pytorch/pytorch/blob/main/third_party/LICENSES_BUNDLED.txt)) |
| **transformers, onnx, onnxruntime, etc.** | Per-package PyPI metadata (mostly Apache-2.0 / MIT) — aggregate in installer “open source notices” |
| **laya-vision** | Check upstream repo license before redistributing a vendored wheel **(not verified in this pass)** |

---

## Implications for the Electron installer (engineering, not a decision)

1. **`laya-install.ts` today assumes `uv` on PATH** — a desktop build should pass an absolute path and env vars for cache/Python locations.
2. **Windows without Git for Windows** will fail on the current PEP 723 line unless the dependency is changed to **tarball URL / wheel** (tarball URL verified; product change).
3. **Linux users pay a much larger first-time torch download** than macOS/Windows for the same pin — plan UX messaging and disk checks.
4. **Network is mandatory for meaningful conversion** even with a full embedded toolchain, unless HF artifacts are already local — same as today ([ADR-0020](../adr/0020-laya-in-node-through-onnx.md)).
5. **macOS torch wheels target `macosx_14_0_arm64`** — validate minimum macOS version against wayfinder’s target **(unconfirmed)**.

---

## References

- [uv — Python versions / python-build-standalone](https://docs.astral.sh/uv/concepts/python-versions/)
- [uv — Storage directories](https://docs.astral.sh/uv/reference/storage/)
- [uv — Caching](https://docs.astral.sh/uv/concepts/cache/)
- [uv — URL dependencies (tarballs)](https://docs.astral.sh/uv/concepts/projects/dependencies/)
- [uv — Environment variables (`UV_OFFLINE`, `UV_CACHE_DIR`, …)](https://docs.astral.sh/uv/reference/environment/)
- [uv-git: system `git` required](https://github.com/astral-sh/uv/blob/main/crates/uv-git/src/git.rs)
- [uv issue #4847 — git system requirement](https://github.com/astral-sh/uv/issues/4847)
- [PyPI — torch 2.14.0 files](https://pypi.org/project/torch/2.14.0/#files)
- [PyPI — torchvision 0.29.0 files](https://pypi.org/project/torchvision/0.29.0/#files)
- [PyTorch — Get Started Locally](https://pytorch.org/get-started/locally/)
- [ADR-0020: Laya / System One conversion through ONNX](../adr/0020-laya-in-node-through-onnx.md)
