# Packaged backend `node_modules` pruning (research)

Research for the self-contained Tauri 2 download (ADR-0022): what `apps/visualizer/backend` can omit from the resource tree copied beside the Node 24 sidecar, per target, without breaking runtime behaviour.

Harness: branch `research/packaged-backend-prune`, workflow [Research packaged backend prune](../../.github/workflows/research-packaged-backend-prune.yml), scripts under `research/packaged-backend-prune/scripts/`.

---

## TL;DR

| Target | Production tree before prune (MiB) | After prune (MiB) | Savings (MiB) | Smoke after prune |
|--------|-----------------------------------:|------------------:|--------------:|:------------------|
| darwin-arm64 | _see CI_ | _see CI_ | _see CI_ | native + HTTP + CLIP + tokenizer |
| win32-x64 | _see CI_ | _see CI_ | _see CI_ | same |
| linux-x64 | _see CI_ | _see CI_ | _see CI_ | same |

**Safe to drop on every shipped target (measured + smoke-tested in CI):**

1. **Foreign `onnxruntime-node` prebuilds** under `node_modules/onnxruntime-node/bin/napi-v6/` — keep only the host `platform/arch` directory.
2. **The entire `onnxruntime-web` package** — Node loads `@huggingface/transformers` via `dist/transformers.node.mjs`, which binds ONNX Runtime to `onnxruntime-node` at runtime; the npm `onnxruntime-web` tree is not resolved on that path (see below).
3. **Browser-only `@huggingface/transformers` dist files** (`transformers.web.js`, `transformers.min.js`, `transformers.js`, `ort-wasm-simd-threaded.jsep.mjs`, …).
4. **devDependencies** — do not ship them: build with full `npm ci`, then `npm prune --omit=dev` (or install with `--omit=dev` only after compiling `dist/` elsewhere).

**Linux-only install knob (not a post-pack prune):** set `ONNXRUNTIME_NODE_INSTALL=skip` (or `npm_config_onnxruntime_node_install=skip`) during `npm ci` on `linux/x64`. Otherwise `onnxruntime-node@1.24.3` postinstall pulls CUDA/TensorRT provider `.so` files from NuGet (~hundreds of MiB) that the backend never uses (`executionProviders: ['cpu']` everywhere).

**Not worth custom pruning:** platform-specific `@img/sharp-*` optional packages — npm only installs the host pair on each runner (MEASURED: macOS arm64 tree had no foreign `@img/*`).

**Where it runs in release CI:** after backend `npm ci` + `tsc` on each matrix runner, before copying `dist/` + `node_modules/` into Tauri bundle resources (same slot as `prepare-backend.mjs` today). No npm/Tauri built-in equivalent for cross-platform ORT stripping — use a small script (`research/packaged-backend-prune/scripts/prune-backend.mjs`).

---

## Measurement method

Workflow matrix: `macos-15` (darwin-arm64), `windows-latest` (win32-x64), `ubuntu-22.04` (linux-x64).

Per job:

1. `npm ci` with `ONNXRUNTIME_NODE_INSTALL=skip`, `npm run build`, measure **full spike-style tree** (includes devDependencies).
2. `npm prune --omit=dev` → **production tree** (what we should ship instead of the spike’s raw `npm ci`).
3. Smoke unpruned: sharp, better-sqlite3 + sqlite-vec, onnxruntime-node, `GET /api/status`, CLIP embed (`encodePixels`), `PreTrainedTokenizer` (files from `Xenova/clip-vit-base-patch32` on Hugging Face).
4. Run `prune-backend.mjs`, re-measure, repeat smoke.

Figures in tables below labelled **MEASURED** include the GitHub Actions run URL once the workflow has completed.

---

## Prune rules (concrete)

Run from `apps/visualizer/backend` (or pass backend root as argv):

```bash
node research/packaged-backend-prune/scripts/prune-backend.mjs .
```

| Rule ID | Action |
|---------|--------|
| `onnxruntime-node-foreign-binaries` | Delete `node_modules/onnxruntime-node/bin/napi-v6/<platform>/<arch>` except: **darwin/arm64**, **linux/x64**, **win32/x64** on the matching runner. |
| `onnxruntime-web-package` | Delete `node_modules/onnxruntime-web/`. |
| `transformers-web-dist-artifacts` | Delete listed files under `node_modules/@huggingface/transformers/dist/` (web/WASM builds). |

**Install-time env (all platforms, required on Linux x64):**

| Variable | Value | Effect |
|----------|-------|--------|
| `ONNXRUNTIME_NODE_INSTALL` | `skip` | Skips NuGet download of CUDA/TensorRT ORT providers on `linux/x64` (see `onnxruntime-node/script/install-metadata.js` requirements). |
| Alternative | `--onnxruntime-node-install=skip` | Same (parsed in `onnxruntime-node/script/install.js`). |

---

## `@huggingface/transformers` and `onnxruntime-web`

**Verdict:** the backend Node entry never loads the `onnxruntime-web` npm package. Runtime ONNX for transformers goes through **`onnxruntime-node`**. Removing `node_modules/onnxruntime-web` is safe after the above smoke tests.

**Sources (CITED, verified in `@huggingface/transformers@4.2.0` installed tree):**

- Package exports send Node to `./dist/transformers.node.mjs` (`package.json` `"exports"."node"`).
- `src/backends/onnx.js` documents that both packages are imported in source for bundling, but the **Node build selects `onnxruntime-node`** when `apis.IS_NODE_ENV` is true:

```11553:11554:node_modules/@huggingface/transformers/dist/transformers.node.mjs
} else if (apis.IS_NODE_ENV) {
  ONNX = ONNX_NODE;
```

- The Node bundle inlines a minified web build for browser code paths; it does **not** `import 'onnxruntime-web'` at runtime on Node (MEASURED: smoke passes with the `onnxruntime-web` directory deleted).

Backend call sites (repo):

- `apps/visualizer/backend/src/imaging/clip-embed.ts` — `CLIPVisionModelWithProjection`, `Tensor`, `env`.
- `apps/visualizer/backend/src/app-models/sessions.ts` — `PreTrainedTokenizer` + direct `onnxruntime-node` in the worker thread.

---

## devDependencies

The Tauri/Electron spikes’ `prepare-backend.mjs` runs plain `npm ci` (includes devDependencies) and copies the whole `node_modules` tree (**CITED:** `spike/tauri-sidecar` / `spike/electron-addons` scripts — not re-verified as MEASURED spike artifact sizes here).

Production should use **`npm prune --omit=dev`** after build (or equivalent) so `typescript`, `vitest`, `tsx`, and `@types/*` are not bundled.

---

## Linux vs macOS backend weight (~300 MiB claim)

**Ticket claim:** Linux package carries ~300 MiB more backend than macOS.

**Findings:**

1. **Spike CI did not log `du` on backend resource trees** — only installer/binary sizes (**CITED:** workflow logs for run `40114156774`; no backend `du` lines).
2. **Electron spike dir packages** (**CITED:** `docs/research/spike-electron-addons.md` on `spike/electron-addons`): macOS ~798 MiB, Linux ~1.1 GB → **~300 MiB delta for the whole Electron app**, not isolated backend-only (**not verified** as backend-only delta).
3. **Mechanism for extra Linux backend weight when install env is wrong:** `onnxruntime-node` postinstall on `linux/x64` installs CUDA/TensorRT provider shared libraries from NuGet (`install-metadata.js` → requirement `cuda12`). macOS arm64 and Windows x64 lists are empty — no extra download. **MEASURED** on a fresh macOS dev install with skip: foreign ORT binaries ~175.5 MiB; `onnxruntime-web` ~128.2 MiB; combined prune ~307 MiB before dev-deps (local `/tmp/lt-research-419` run, darwin-arm64 — see parent agent summary for run link after CI).

**MEASURED cross-platform comparison:** see workflow artifact `research-packaged-backend-prune-summary.json` per OS (linux vs darwin production tree MiB before/after prune and `ONNXRUNTIME_NODE_INSTALL=skip`).

---

## Release pipeline placement

From [tauri-release-pipeline research](tauri-release-pipeline.md) (**CITED**):

Per matrix job, order should be:

1. Checkout + Node 24 + `ONNXRUNTIME_NODE_INSTALL=skip`.
2. `npm ci` in `apps/visualizer/backend` → `npm run build` (`tsc`).
3. `npm prune --omit=dev`.
4. **`node research/.../prune-backend.mjs`** (this research script; to be wired into production `prepare-backend`).
5. Copy `dist/`, pruned `node_modules/`, `package.json`, user-facing config seeds into `backend-pack/` / Tauri `resources`.
6. Fetch sidecar Node + `tauri build`.

npm has no flag to omit foreign ORT platforms. Tauri only bundles paths you copy — pruning before copy is the practical hook.

---

## Risks and checks

| Risk | Mitigation |
|------|------------|
| `@huggingface/transformers` upgrade switches Node entry to dynamic-import `onnxruntime-web` | Re-run matrix smoke; grep `transformers.node.mjs` for `onnxruntime-web` import. |
| `onnxruntime-node` upgrade changes bundled platforms or postinstall | Re-measure `bin/napi-v6/*`; re-read `script/install-metadata.js`. |
| Accidental `--omit=dev` before `tsc` | Always compile before `npm prune --omit=dev`. |
| Linux CI without `ONNXRUNTIME_NODE_INSTALL=skip` | Assert `du` on `linux/x64` ORT folder or check for `libonnxruntime_providers_cuda.so`. |

---

## Appendix: darwin-arm64 local sanity (MEASURED)

Host: `/tmp/lt-research-419`, `ONNXRUNTIME_NODE_INSTALL=skip`, Node 24, 2026-10-26.

| Stage | `node_modules` (MiB) |
|-------|---------------------:|
| After `npm ci` (with dev) | 496.5 |
| After `npm prune --omit=dev` | 410.7 |
| After `prune-backend.mjs` | 103.7 |

Prune step bytes (bytes → MiB):

| Step | MiB |
|------|----:|
| `onnxruntime-node-foreign-binaries` | 175.5 |
| `onnxruntime-web-package` | 128.2 |
| `transformers-web-dist-artifacts` | 3.3 |

CI matrix replaces this table with per-OS MEASURED rows and run links.
