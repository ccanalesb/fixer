# Spike: System One model worker in packaged Electron backend (#410)

Research date: **2026-10-24**. Builds on [spike-electron-addons.md](spike-electron-addons.md) (branch `spike/electron-addons`). Throwaway harness on branch `spike/electron-worker-models` — **not for merge**.

## TL;DR

**Confirmed on macOS arm64, Windows x64, and Linux x64:** inside the **packaged** Electron 45 app, the compiled backend child (`ELECTRON_RUN_AS_NODE=1`, cwd `Resources/backend`) lists a converted **`laya-base`** model via **`GET /v1/models`**, starts the **`worker_threads` model worker** on the first **`POST /v1/systemone`**, and returns **valid score probabilities** for a reference test photo. Native addon smoke from #401 still passes in the same child before the HTTP server starts.

**Process model:** unchanged from #401 — backend child only; ORT runs in the **dedicated model worker**, not on the main thread (unlike the tiny Identity ONNX in `native-smoke.mjs`).

**Models in CI:** converted at job time into `RUNNER_TEMP` with `uv run scripts/app-models/export_onnx.py thaitea/laya-vision --name laya-base --out …` (archive `laya` dep + `PYTHONUTF8=1` on Windows). **`app_models_dir`** points at that directory through temp **`config.yaml`** (`LT_CONFIG_YAML`). No model bytes in git, artifacts, or cache (ADR-0020).

---

## Per-platform results

CI: workflow run [40108459929](https://github.com/ccanalesb/lightroom-tagger/actions/runs/40108459929) on branch `spike/electron-worker-models`.

| Platform | Worker starts & answers? | `GET /v1/models` | First `POST /v1/systemone` (wall, 1 photo, 1 question) | Backend RSS after answer (MiB) | Convert wall (s) | Packaged dir size |
|----------|--------------------------|------------------|-----------------------------------------------------------|--------------------------------|------------------|-------------------|
| **Linux x64** | **Yes** | lists `laya-base` | **~4.7 s** | **~1478** (185 before) | 89 | ~1.1 GB |
| **Windows x64** | **Yes** | lists `laya-base` | **~4.9 s** | **~1254** (118 before) | 92 | ~859 MB |
| **macOS arm64** | **Yes** | lists `laya-base` | **~8.8 s** | **~1275** (144 before) | 114 | ~767 MB |

Question used: factory id `7|immediate-impact` (score, 7 levels), image from `<model>/reference/photo.png`. Probabilities matched across platforms to ~1e-6 (same ONNX graph).

Spawn mode in CI: **`electron-run-as-node`** only (same as #401). Linux packaged launch: **`--no-sandbox`** + xvfb.

---

## Method

1. **Convert** `thaitea/laya-vision` → `laya-base` on the runner (PEP 723 `laya` archive tarball on this branch’s `export_onnx.py`).
2. **`npm run pack:dir`** in `spike/electron/` (full backend `node_modules` under `Resources/backend/`).
3. **Headless smoke:** `SPIKE_APP_MODELS_DIR=<convert out>` → temp data dir + `config.yaml` with `app_models_dir`; child runs `native-smoke.mjs` then `dist/src/server.js`; Electron main polls `/api/status`, then **`systemone-smoke.mjs`** calls `/v1/models` and `/v1/systemone`.

Harness files: `spike/electron/systemone-smoke.mjs`, extended `main.mjs`. Workflow: `.github/workflows/spike-electron-worker-models.yml` (push to this branch only).

---

## Failures and fixes (iteration log)

| # | Symptom | Fix |
|---|---------|-----|
| — | (none) | First green run on all three matrix jobs |

Prior #401 constraints still apply: second `extraResources` entry for `backend/node_modules`; never port 5001; never touch repo-root `models/`, `library.db`, or user `config.yaml`.

---

## Open problems / follow-ups

1. **Shipping models:** spike reads ONNX from an **absolute path outside the app bundle**; product still needs install location + updater policy (#382).
2. **`utilityProcess.fork` + worker:** not re-tested here (macOS-only pass in #401).
3. **Linux convert download size:** uv still resolves a **CUDA PyTorch stack** on Ubuntu (~4 GB peak RSS during convert); CPU index pinning deferred to [#405](https://github.com/ccanalesb/lightroom-tagger/issues/405) / [#385](https://github.com/ccanalesb/lightroom-tagger/issues/385).
4. **Timing breakdown:** wall time for first `/v1/systemone` includes worker spawn, ORT init in worker, and vision+decoder inference; no separate worker-ready hook in HTTP yet.
5. **Dependency pruning:** packaged dir still ~0.8–1.1 GB without models; models add ~778 MB on disk beside the app.

---

## References

- Parent spike: [spike-electron-addons.md](spike-electron-addons.md) ([#401](https://github.com/ccanalesb/lightroom-tagger/issues/401))
- Conversion archive dep: [spike-convert-win-linux.md](spike-convert-win-linux.md) ([#405](https://github.com/ccanalesb/lightroom-tagger/issues/405))
- Backend worker: `apps/visualizer/backend/src/app-models/runtime.ts`, `worker.ts`
- System One routes: `apps/visualizer/backend/src/api/systemone.ts`
