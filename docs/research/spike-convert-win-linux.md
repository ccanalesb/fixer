# Spike: model conversion on Windows x64 and Linux x64 (GitHub archive `laya` dep)

Research for GitHub issue [#405](https://github.com/ccanalesb/lightroom-tagger/issues/405) (wayfinder map [#382](https://github.com/ccanalesb/lightroom-tagger/issues/382)). Throwaway branch `spike/convert-win-linux` — **not for merge**.

**Question:** Does `uv run scripts/app-models/export_onnx.py thaitea/laya-vision --name laya-base` succeed (parity included) on GitHub Actions `windows-latest` and `ubuntu-latest` when `laya` is installed from a GitHub archive tarball instead of `git+https`, without relying on a system `git`?

**Method:** Branch-only workflow [`.github/workflows/spike-convert-win-linux.yml`](../../.github/workflows/spike-convert-win-linux.yml), cold caches under `RUNNER_TEMP`, no `actions/cache`, no model/HF artifacts uploaded (ADR-0020). Canonical green run: [Actions run 40107702861](https://github.com/ccanalesb/lightroom-tagger/actions/runs/40107702861) (2026-10-24).

---

## TL;DR

- **Yes** — conversion of `thaitea/laya-vision` → `laya-base` with **PyTorch parity checks** succeeds on **Linux x64**, **Windows x64**, and **macOS arm64** (baseline) with the archive `laya` dep.
- **Working PEP 723 line:** `laya @ https://github.com/r33drichards/laya-vision/archive/568feeeada793f70f736756b0f3a7643d1e75910.tar.gz` (uv builds from tarball; logs show `Building laya @ https://…tar.gz`, no `git+https`).
- **No git:** Extra Ubuntu job runs `uv` with `PATH` stripped to `$(dirname uv):/usr/local/bin` during resolve + convert; conversion still succeeds.
- **Minimum macOS (cp312 wheels):** `torch==2.14.0` and `onnxruntime==1.31.0` publish **`macosx_14_0_arm64`** tags only → **macOS 14.0+** on Apple Silicon.
- **Surprise:** On Linux runners, uv resolved a **CUDA-enabled PyTorch stack** (~5.6 GiB `UV_CACHE_DIR`, many `nvidia-*` wheels), not the ~555 MiB CPU `manylinux_2_28_x86_64` wheel cited in [ship-model-conversion research](https://github.com/ccanalesb/lightroom-tagger/blob/research/ship-model-conversion/docs/research/ship-model-conversion.md). macOS/Windows stayed ~121 MiB / ~118 MiB `torch` downloads.
- **Windows gotcha:** Default console encoding (`cp1252`) crashed `torch.onnx` logging (Unicode checkmark). **`PYTHONUTF8=1`** (and `PYTHONIOENCODING=utf-8`) required.

---

## Exact dependency line

In [`scripts/app-models/export_onnx.py`](../../scripts/app-models/export_onnx.py) PEP 723 block:

```text
laya @ https://github.com/r33drichards/laya-vision/archive/568feeeada793f70f736756b0f3a7643d1e75910.tar.gz
```

Equivalent forms verified locally: uv accepts the `.tar.gz` URL directly (no `git` CLI). The commit hash matches the previous `git+https` pin.

---

## Per-platform results (run 40107702861)

Wall times are **convert step only** (`thaitea/laya-vision` download + load + ONNX export + parity). Resolve (`uv run … --help`) adds ~8–31 s depending on platform/cold cache.

| Platform | Runner | Result | Convert (s) | Resolve (s) | UV cache (after convert) | HF cache (after convert) | Peak RSS |
|----------|--------|--------|-------------|-------------|---------------------------|--------------------------|----------|
| Linux x64 | `ubuntu-latest` | **OK** | 73 | ~21 | **5.6 G** | 772 M | ~3.9 GiB (`time -v`) |
| Linux x64 (no git on PATH for `uv`) | `ubuntu-latest` | **OK** | 63 | ~31 | 5.6 G | 772 M | (not timed) |
| Windows x64 | `windows-latest` | **OK** | 88 | ~15 | 856 M | 772 M | (not measured) |
| macOS arm64 (baseline) | `macos-latest` | **OK** | 82 | ~8 | 1.7 G | 771 M | ~3.0 GiB (`time -l`) |

Local ONNX output under `RUNNER_TEMP` was **~777–778 M** per platform (not committed or uploaded).

HF cache size is dominated by **`thaitea/laya-vision@8b318c9`** weights (~772 M); same across platforms.

---

## CI failures and fixes (iteration log)

| # | Symptom | Cause | Fix |
|---|---------|-------|-----|
| 1 | Workflow rejected at parse time | `runner.temp` in job-level `env` | Set paths in a step via `RUNNER_TEMP` / `GITHUB_ENV` |
| 2 | Ubuntu “hide git” job failed immediately | `GITHUB_ENV` `PATH` applies **next** step; same-step `command -v git` still saw `/usr/bin/git` | Assert git absent in a **later** step (later superseded by uv-only PATH strip) |
| 3 | Windows convert died in `torch.onnx.export` | `UnicodeEncodeError` printing ✅ on **cp1252** stderr | `PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8` |
| 4 | Ubuntu no-git: `git` at `/bin/git` | `PATH=/usr/local/bin:/bin` still includes git | Do not strip PATH for whole job |
| 5 | Ubuntu no-git: `tee: command not found` | `/usr/bin` removed from PATH for entire step | Strip PATH **only** around `uv run` |
| 6 | Ubuntu no-git: `uv: command not found` | `uv` not in `~/.local/bin` on GHA | Record `UV_EXECUTABLE` and prepend its directory only |

---

## Open problems

1. **Linux download size:** Investigate why uv pulls **CUDA PyTorch + NVIDIA** wheels on `ubuntu-latest` (528.9 MiB `torch` + ~2 GiB of `nvidia-*` / `triton`) despite `torch==2.14.0` CPU wheels existing on PyPI. Likely needs an explicit CPU index or platform marker constraint before shipping a Linux converter to users (see [#385](https://github.com/ccanalesb/lightroom-tagger/issues/385)).
2. **Windows peak memory:** No `/usr/bin/time` equivalent in the spike job; only wall time recorded.
3. **Product path:** This spike only changes the throwaway branch; `master` still uses `git+https` for `laya`.

---

## References

- Prior sizing: `origin/research/ship-model-conversion:docs/research/ship-model-conversion.md`
- ADR-0020: no model/graph/tokenizer artifacts in public CI
- Workflow: `.github/workflows/spike-convert-win-linux.yml` on branch `spike/convert-win-linux`
