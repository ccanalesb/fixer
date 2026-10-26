# Packaged backend `node_modules` pruning (research)

Research for the self-contained Tauri 2 download (ADR-0022): what `apps/visualizer/backend` can omit from the resource tree copied beside the Node 24 sidecar, per target, without breaking runtime behaviour.

Harness: branch `research/packaged-backend-prune`, workflow `.github/workflows/research-packaged-backend-prune.yml`, scripts under `research/packaged-backend-prune/scripts/`.

**CI run (green, all three targets):** https://github.com/ccanalesb/lightroom-tagger/actions/runs/40376254320 (commit `b68171d`). Every "MEASURED" CI figure below comes from this run's summary artifacts unless another run is named. The earlier green run [40375800174](https://github.com/ccanalesb/lightroom-tagger/actions/runs/40375800174) (commit `1c7516e`) gives the same prod and per-step bytes, but measured the pruned tree after a smoke had cached the CLIP model inside `node_modules` (pruned 439.1 / 439.1 / 467.3 MiB), so its pruned totals are not usable.

---

## TL;DR

| Target | Prod. `node_modules` before prune (MiB) | Pruned `node_modules` (MiB) | Total prune savings (MiB) | Smoke on pruned tree |
|--------|------------------------------------------:|------------------------------:|--------------------------:|:---------------------|
| darwin-arm64 | **410.7** MEASURED | **103.7** MEASURED (410.7 − 307.0) | **307.0** | pass |
| linux-x64 | **411.4** MEASURED | **103.7** MEASURED (411.4 − 307.7) | **307.7** | pass |
| win32-x64 | **414.2** MEASURED | **131.9** MEASURED (414.2 − 282.3) | **282.3** | pass |

Prod. tree = `npm ci` + `npm run build` + `npm prune --omit=dev`, with `ONNXRUNTIME_NODE_INSTALL=skip` during install. Dist adds **~3.5 MiB** on each target (MEASURED).

**Spike-style mistake to avoid:** plain `npm ci` without `--omit=dev` adds **~71–92 MiB** devDependencies (MEASURED: full vs prod on CI). The sidecar spikes copied that whole tree (**CITED:** `prepare-backend.mjs` on `spike/tauri-sidecar` runs `npm ci` with no prune — verified via `git show origin/spike/tauri-sidecar:spike/tauri/scripts/prepare-backend.mjs`).

### Prune list (safe on all shipped targets)

| Item | Approx. saving (MiB) | Rule |
|------|---------------------:|------|
| Foreign `onnxruntime-node` prebuilds | **~151–176** per target | Delete `node_modules/onnxruntime-node/bin/napi-v6/*/*` except host triple (see below). |
| `onnxruntime-web` npm package | **~128.2** | Delete `node_modules/onnxruntime-web/`. |
| `@huggingface/transformers` web dist | **~3.3** | Delete browser/WASM bundles under `node_modules/@huggingface/transformers/dist/` (listed in `prune-backend.mjs`). |
| `@huggingface/transformers/.cache` | **0 at pack time** (**335.4** on every target when the smoke had downloaded the CLIP model into `node_modules` — MEASURED, run 40375800174 pruned minus run 40376254320 pruned) | Delete `node_modules/@huggingface/transformers/.cache/`. Runtime should set `HF_HOME` to user data, not pack this cache. |
| devDependencies | **~71–92** | `npm prune --omit=dev` after `tsc`, not a path prune. |

**Host ORT directory to keep:**

| Target | Keep under `bin/napi-v6/` |
|--------|---------------------------|
| darwin-arm64 | `darwin/arm64` |
| linux-x64 | `linux/x64` |
| win32-x64 | `win32/x64` |

**Foreign ORT sizes on a macOS dev install (MEASURED, `du -sm`, `/Users/ccanales/projects/lightroom-tagger/apps/visualizer/backend`, 2026-10-26):** `darwin/arm64` 35, `linux/arm64` 19, `linux/x64` 34, `win32/x64` 60, `win32/arm64` 65 — sum foreign to darwin-arm64 **178 MiB**; whole `onnxruntime-node` **211 MiB**. Ticket range **~160–175 MiB foreign** is **correct for darwin-arm64** (MEASURED).

**Install env (required on linux/x64):**

| Variable | Value |
|----------|-------|
| `ONNXRUNTIME_NODE_INSTALL` | `skip` |

Otherwise postinstall pulls CUDA/TensorRT ORT providers from NuGet for `linux/x64` only (**CITED:** `onnxruntime-node@1.24.3` `script/install-metadata.js` → `requirements['linux/x64']: ['cuda12']`, package `Microsoft.ML.OnnxRuntime.Gpu.Linux` 1.24.3 per `install-metadata-versions.js`). That adds **301.9 MiB** to `onnxruntime-node` (MEASURED: `libonnxruntime_providers_cuda.so` 301.1 + `_tensorrt.so` 0.8 + `_shared.so` 0.0 MiB, from `unzip -l` of the 196.0 MiB nupkg on api.nuget.org). Backend uses CPU EP only (`executionProviders: ['cpu']` in `src/app-models/sessions.ts`); those libs are unused.

---

## `@huggingface/transformers` vs `onnxruntime-web`

**Verdict:** Node does **not** load the `onnxruntime-web` package at runtime. **`onnxruntime-node`** backs ONNX for transformers on Node. Removing `node_modules/onnxruntime-web` is safe (MEASURED: CI smoke after prune — CLIP `encodePixels` (512-dim output) + `PreTrainedTokenizer` and `GET /api/status` 200 on all three OSes, run 40376254320).

**Proof in upstream (CITED, `@huggingface/transformers@4.2.0`, verified in installed `dist/transformers.node.mjs`):**

- Node resolves `"exports"."node"` → `dist/transformers.node.mjs` (`package.json`).
- Source comment in `src/backends/onnx.js` states both ORT packages exist for bundling, but Node uses `onnxruntime-node` when `apis.IS_NODE_ENV` is true.
- Compiled branch:

```11553:11554:node_modules/@huggingface/transformers/dist/transformers.node.mjs
} else if (apis.IS_NODE_ENV) {
  ONNX = ONNX_NODE;
```

The Node bundle inlines a minified web build for non-Node branches; it does not `import 'onnxruntime-web'` from `node_modules` on Node (MEASURED: delete `node_modules/onnxruntime-web` — smoke passes).

**Backend usage (repo):** `src/imaging/clip-embed.ts` (`CLIPVisionModelWithProjection`, …), `src/app-models/sessions.ts` (`PreTrainedTokenizer` + direct `onnxruntime-node` in the worker).

---

## Per-target prune step bytes (MEASURED, run 40376254320)

| Step | darwin-arm64 (MiB) | linux-x64 (MiB) | win32-x64 (MiB) |
|------|-------------------:|----------------:|----------------:|
| `onnxruntime-node-foreign-binaries` | 175.5 | 176.2 | 150.8 |
| `onnxruntime-web-package` | 128.2 | 128.2 | 128.2 |
| `transformers-web-dist-artifacts` | 3.3 | 3.3 | 3.3 |

---

## Linux vs macOS ~300 MiB backend delta

**Ticket claim:** Linux package carries ~300 MiB more backend than macOS.

**Finding:** **True for the spikes, and it is the CUDA providers.** The spikes ran plain `npm ci` (**CITED:** `prepare-backend.mjs` on `spike/electron-addons` and `spike/tauri-sidecar`, no `ONNXRUNTIME_NODE_INSTALL`), so on `linux/x64` the `onnxruntime-node` postinstall downloaded the CUDA/TensorRT providers: **301.9 MiB** (MEASURED, see the install env section). That matches the Electron spike gap: dir packages ~798 MB macOS vs ~1.1 GB Linux (**CITED:** `docs/research/spike-electron-addons.md` on `spike/electron-addons`, `du -sh`), while Electron itself differs by only ~16 MB between the two (258 vs 274 MB unpacked, **CITED:** resolution of the Electron-or-Tauri ticket). The Tauri spike's ~407 MB Linux `.deb` is compressed and not comparable to the ~636 MB macOS `.app`.

With `ONNXRUNTIME_NODE_INSTALL=skip` the gap is gone: prod `node_modules` **411.4 MiB** linux-x64 vs **410.7 MiB** darwin-arm64, and `onnxruntime-node` **210.1 MiB** on both before prune (MEASURED). macOS and Windows have no postinstall download (`requirements` is `[]` for `darwin/arm64` and `win32/x64`, **CITED** `install-metadata.js`).

---

## Where this runs in the release pipeline

From [tauri-release-pipeline.md](tauri-release-pipeline.md) (**CITED**), per matrix job:

1. `npm ci` in `apps/visualizer/backend` with `ONNXRUNTIME_NODE_INSTALL=skip`.
2. `npm run build` (`tsc`).
3. `npm prune --omit=dev`.
4. **`node research/packaged-backend-prune/scripts/prune-backend.mjs`** (or production copy under `scripts/`).
5. Copy `dist/`, pruned `node_modules/`, `package.json`, config seeds → Tauri `resources` / `backend-pack/`.
6. Sidecar Node fetch + `tauri build`.

npm has no switch to drop foreign ORT platforms. Tauri bundles whatever you copy — pruning before copy is the practical hook.

---

## Risks and checks

| Risk | Mitigation |
|------|------------|
| Transformers upgrade imports `onnxruntime-web` on Node | Grep `transformers.node.mjs`; re-run matrix smoke. |
| ORT postinstall/metadata changes | Re-read `install-metadata.js`; assert `ONNXRUNTIME_NODE_INSTALL=skip` in CI. |
| Hub models cached under `node_modules/@huggingface/transformers/.cache` | Prune rule + set `HF_HOME` to user data at runtime. |
| Prune before vs after smoke conflates sizes | Measure prod tree **before** download smoke; keep HF cache outside `node_modules` in CI (`HF_HOME` in workflow smoke step). |

---

## Scripts

| Script | Role |
|--------|------|
| `research/packaged-backend-prune/scripts/prune-backend.mjs` | Path rules + byte counts. |
| `research/packaged-backend-prune/scripts/measure-and-smoke.mjs` | `du` top packages, native + HTTP + transformers smoke. |
| `research/packaged-backend-prune/scripts/transformers-smoke-entry.mjs` | Copied into backend root for smoke so one transformers module graph is used. |

---

## Appendix: local darwin-arm64 sanity (MEASURED)

Host: `/tmp/lt-research-419`, `ONNXRUNTIME_NODE_INSTALL=skip`, Node 24, 2026-10-26 (same commit family as CI).

| Stage | `node_modules` (MiB) |
|-------|---------------------:|
| After `npm ci` (with dev) | 496.5 |
| After `npm prune --omit=dev` | 410.7 |
| After `prune-backend.mjs` (no prior CLIP cache in tree) | 103.7 |

Cross-checks CI darwin prod **410.7** and post-prune **103.7** (computed from prod − removed).
