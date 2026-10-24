# Stored absolute paths audit (Wayfinder #404)

Research for map [#382](https://github.com/ccanalesb/lightroom-tagger/issues/382) and grilling [#389](https://github.com/ccanalesb/lightroom-tagger/issues/389). Code references are from `research/stored-absolute-paths` (same as `origin/master` at audit time, 2026-10-24). Complements [posix-assumptions-audit.md](posix-assumptions-audit.md) on branch `origin/research/posix-assumptions`.

## TL;DR

- **`library.db` holds photo locations exactly as Lightroom wrote them** (`images.filepath`: NAS UNC `//…`, macOS `/Volumes/…`, occasional Windows-style paths). Those paths are **not** tied to where the app is installed; they break when the NAS is unmounted unless `NAS_*` env or local mounts match (`path-resolve.ts`).
- **`vision_cache.compressed_path` stores absolute JPEG paths** under whatever `vision_cache_dir` was at cache-build time (default `~/.cache/lightroom_tagger/vision`). Moving the cache **without rewriting this column** breaks describe/score/cull/thumbnails until rows are rebuilt (~4 GB in a typical install).
- **`library_meta.synced_catalog_path`** stores the absolute `.lrcat` path from the last successful sync; **`config.yaml`** stores absolute `catalog_path`, `db_path`, `mount_point`, and optionally `vision_cache_dir` / `app_models_dir`. **`images.catalog_path`** exists in schema but is **unused** (empty in sampled DB).
- **`visualizer.db` job checkpoints** store image **keys**, not filesystem paths; safe to move with the DB. **Job logs** may embed absolute paths in free-text messages (cosmetic).
- **API vs jobs library DB resolution differs**: HTTP uses `LIBRARY_DB` env → repo-relative `library.db` (`config.ts:54-59`, `api/library-db.ts:76`); job handlers use `LIBRARY_DB` → **`db_path` in yaml** → cwd `library.db` (`jobs/library-db.ts:36-84`). Electron must set **`LIBRARY_DB` and `DATABASE_PATH`** (and align yaml) so UI and workers hit the same files.
- **Bring an existing install into a packaged app**: copy `library.db`, `visualizer.db`, `config.yaml`, `models/`, and the vision cache directory; **rewrite** yaml/env paths and **`vision_cache.compressed_path`** (or run a cache rebuild); keep catalog and NAS paths valid. **`models/*/model.json`** may record an absolute `source` path (metadata only). **`cull_stage_answers.image_path`** duplicates vision-cache paths (audit trail).

---

## Summary table

| Store | Table / key | Path kind | Sample shape (redacted) | Breaks if install moved? |
|-------|-------------|-----------|-------------------------|---------------------------|
| `config.yaml` | `catalog_path` | Absolute (as written; `~` expanded on load) | `/Users/<user>/…/Catalog.lrcat` | Yes — update yaml or `LT_CONFIG_YAML` + value |
| `config.yaml` | `db_path` | Absolute via `resolvePath` if relative to repo | `/Users/<user>/projects/…/library.db` | Jobs only — see API split below |
| `config.yaml` | `mount_point` | Absolute (`expandUser` only) | `/Volumes/<share>` | Thumbnail allowlist + user expectation; not wired to `NAS_MOUNT_POINT` |
| `config.yaml` | `vision_cache_dir` | Absolute if set; else **derived** `~/.cache/lightroom_tagger/vision` | `config.ts:159,192-195` | New cache dir unless DB paths rewritten |
| `config.yaml` | `app_models_dir` | Repo-relative default `models` → absolute under `REPO_ROOT` | `…/models` | Yes — set dir + yaml/env |
| `config.yaml` | `small_catalog_path` | Raw string; used for thumbnail roots | Often empty | Only if used for thumbs |
| Env (not in yaml) | `LIBRARY_DB` | Absolute | Overrides yaml for **jobs**; **API always uses this first** when set | Must point at moved `library.db` |
| Env | `DATABASE_PATH` | Absolute | `apps/visualizer/visualizer.db` default under repo | Must point at moved `visualizer.db` |
| Env | `LT_CONFIG_YAML`, `LT_PROVIDERS_JSON`, `THUMBNAIL_DIR` | Resolved like yaml paths | `config.ts:54-85` | Required when app has no repo tree |
| Env | `NAS_PATH_PREFIX`, `NAS_MOUNT_POINT` | Runtime only | Not stored in DB | Required for `//…` filepaths when `/Volumes` layout changes |
| `library.db` | `images.filepath` | **Lightroom absolute** (UNC, `/Volumes`, sometimes `C:/…`) | `//tnas/…/photo.jpg`, `/Volumes/…/…` | **Independent of app dir** — breaks if photos/NAS unreachable |
| `library.db` | `images.catalog_path` | Column present; default `''` | Empty in production sample | N/A (unused) |
| `library.db` | `vision_cache.compressed_path` | **Absolute** JPEG path or sentinel | `~/.cache/lightroom_tagger/vision/2020-03-08__….jpg`, `__oversized__` | **Yes** if cache directory moves |
| `library.db` | `library_meta.synced_catalog_path` | Absolute `.lrcat` from last sync | Same as configured catalog at sync time | Stale warning until re-sync; path must exist to sync |
| `library.db` | `library_meta.*` (other) | Timestamps / flags | e.g. `keywords_backfilled_v1` | No |
| `library.db` | `cull_stage_answers.image_path` | Absolute vision-cache JPEG used for answer | Same tree as `vision_cache` | Cosmetic / audit; cull re-resolves from cache |
| `library.db` | `perspectives.source_filename`, `cull_profiles.source_filename` | **Basename only** (under `REPO_ROOT/prompts/…`) | `color_theory.md` | No — resolved at read time (`api/perspectives.ts:306-308`) |
| `library.db` | CLIP / scores / descriptions / cull JSON | Image **keys**, slugs, model ids | No filesystem paths | No |
| `models/` (disk) | `model.json` → `source` | Often HF id; **can be absolute folder** | `thaitea/laya-vision` or `/Users/…/bench/…` | **No** for inference (loads from model dir); confusing metadata |
| `visualizer.db` | `jobs.metadata` | JSON knobs + **`checkpoint`** (keys, fingerprints) | `processed_pairs`: `"2020-05-27_DSCF9037\|catalog"` | No path fields in checkpoints (`jobs/checkpoint.ts`) |
| `visualizer.db` | `jobs.metadata.catalog_path` | Optional override for sync jobs | Usually absent (uses yaml) | Same as yaml catalog |
| `visualizer.db` | `job_logs.message` | Free text | May echo cache dir, library path, missing `filepath` | Cosmetic |
| `visualizer.db` | `provider_models` | Provider/model strings | No paths | No |
| Derived at runtime | Thumbnails | URL `/api/images/catalog/{key}/thumbnail` | Serves from `vision_cache` or resolved `filepath` | Follows cache + filepath rules |
| Derived at runtime | `.lrcat` read/write | From `config.catalogPath` / job metadata | `lightroom/catalog-sync.ts:166`, `jobs/handlers/catalog.ts:56-60` | Not stored on `images` rows |
| Derived at runtime | `resolveFilepath` / `resolveCatalogPath` | Applied when opening photos | `utils/path-resolve.ts:49-104` | NAS/mount env must match machine |
| Derived at runtime | `REPO_ROOT` | Four levels up from `backend/src` | `config.ts:15-17` | Breaks in bundle unless env overrides |
| Derived at runtime | Laya / app-model install | `join(REPO_ROOT, 'scripts/…')` | `jobs/handlers/app-model-install.ts:22-66` | Packaging must ship scripts or replace job |

---

## `config.yaml` (repo root)

Loaded by `loadLibraryConfig()` (`config.ts:170-208`). Path-like keys:

- **`catalog_path`**, **`db_path`**, **`app_models_dir`**: relative values are resolved with `resolvePath()` against **`REPO_ROOT`**, not cwd (`config.ts:23-26,175-178,206`).
- **`mount_point`**: only `expandUser()` — never repo-relative (`config.ts:185-186`).
- **`vision_cache_dir`**: explicit absolute/`~` or default under **`homedir()`** — not repo-relative (`config.ts:159,192-195`).
- **`catalog_path` on disk** is stored as the user typed it; API returns raw + `expandUserPath` resolved (`api/lt-config.ts:80-88`).

Sample install (redacted): absolute `catalog_path`, `db_path`, `mount_point`; default vision cache and `models/` implied.

---

## `library.db`

Schema: `db/library/bootstrap.ts` (`images`, `vision_cache`, `library_meta`, cull tables, etc.).

### `images.filepath`

Written during catalog import/sync from Lightroom `AgLibraryRootFolder.absolutePath` + folder + filename (`lightroom/reader.ts:217-227`, `db/library/catalog.ts:96-137`). **Not normalized** to the app install location.

Empirical mix (one production library, counts approximate): mostly `/Volumes/<share>/…`, then `//tnas/…`, then `//10.x.x.x/…`, small sets of `C:/…` and `/Users/…/Mobile Downloads.lrdata/…`.

At runtime, vision/describe/score/cull call **`resolveFilepath()`** before opening files (`vision/scoring-service.ts:98`, `cull/answer-photo.ts:34`).

### `vision_cache.compressed_path`

Set when building cache (`vision/vision-cache.ts:161-228`): `join(visionCacheDir, '<key>.jpg')` with **`visionCacheDir` from config at write time**, stored as a full path string (`vision/vision-cache.ts:91-98`). Special values: **`__oversized__`** sentinel (`db/library/vision-cache.ts:11`), or occasionally the **original file path** when the file is already a small JPEG (`vision/vision-cache.ts:206-209`).

Cache stats sum **`statSync(compressed_path)`** (`db/library/statistics.ts:45-52`) — wrong paths undercount size and break serving (`api/images/catalog.ts:108-112`).

### `library_meta.synced_catalog_path`

Set to the **`catalogPath` argument** passed into `syncCatalog()` after a successful run (`lightroom/catalog-sync.ts:263-266`, key in `bootstrap.ts:38`). Compared to **`loadLibraryConfig().catalogPath`** (expanded) for “needs sync” UI (`api/lt-config.ts:86-96`).

### Culling

`cull_stage_answers.image_path` stores the vision JPEG path used when the model answered (`db/library/cull-stages.ts:84-90`, filled from `resolveCullImage` → `resolveVisionImage` in `cull/answer-photo.ts:32-35,106`).

### Not path-bearing

Embeddings (`image_clip_embeddings*`), scores, descriptions, stacks, similarity groups, LR writeback state, `cull_*` JSON definitions — keys and slugs only.

---

## `visualizer.db`

Schema: `db/jobs/jobs.ts:69-103` (`jobs`, `job_logs`, `provider_models`).

- **`jobs.metadata`**: job-type knobs (filters, provider ids, optional `catalog_path` for sync — `jobs/handlers/catalog.ts:56-60`). **`metadata.checkpoint`**: v1 objects with fingerprints and **processed image keys** / `"key\|itype\|slug"` tuples — no filesystem paths (`jobs/checkpoint.ts:1-35`, `jobs/runner.ts:192-207`).
- **`job_logs`**: append-only text; CLI/dev messages may log **`Cache directory:`**, **`Using library DB:`**, or per-image **`File not found: <filepath from library.db>`** (`jobs/handlers/path-diagnostics.ts` indirectly).

Path resolution for jobs does **not** read paths from `visualizer.db`; workers open **`requireLibraryDb()`** (`jobs/handlers/common.ts:20-26`).

---

## API vs job handler: which `library.db`?

| Consumer | Resolution |
|----------|------------|
| HTTP middleware | `config.LIBRARY_DB` = `LIBRARY_DB` env or `resolvePath('library.db')` (`config.ts:57-59`, `api/library-db.ts:76`) — **does not read `db_path` from yaml** |
| Job handlers / enqueue guards | `LIBRARY_DB` env → **`db_path` in yaml** → `./library.db` (`jobs/library-db.ts:36-84`) |

A packaged app that only updates `config.yaml` **`db_path`** but not **`LIBRARY_DB`** can leave the UI on one file and workers on another if defaults differ.

---

## Can an existing install be pointed at by the packaged app?

**Yes, with configuration and one high-value DB column — not “drop files in app support and run” without edits.**

1. **Copy** `library.db`, `visualizer.db`, `config.yaml`, `models/`, and the vision cache tree (~GB scale).
2. **Set environment** (recommended single source of truth for bundled apps): `LIBRARY_DB`, `DATABASE_PATH`, `LT_CONFIG_YAML`, and likely `LT_PROVIDERS_JSON`. Set **`NAS_*`** if NAS UNC paths must resolve on the new machine.
3. **Update `config.yaml`** (or the file `LT_CONFIG_YAML` points at): `catalog_path`, `db_path`, `vision_cache_dir`, `app_models_dir`, `mount_point` as needed.
4. **If `vision_cache_dir` changes**: bulk-update `vision_cache.compressed_path` prefix **or** delete `vision_cache` rows and rebuild cache (jobs: `catalog_cache_build` / describe pipeline). Otherwise thumbnails and vision ops miss files.
5. **Do not need to rewrite** `images.filepath` for an install move — those point at **photos and NAS**, not the app. They still require the same storage layout or env mapping.
6. **Re-run catalog sync** if `.lrcat` moved — updates mirror metadata and `synced_catalog_path`.
7. **`visualizer.db`** can move as-is; in-flight **`running`** jobs with checkpoints are recovered per `jobs/processor.ts` (keys only).
8. **`models/`** moves with **`app_models_dir`**; ONNX paths inside dirs are relative to each model folder.

**Surprising:** `images.catalog_path` column is synced-capable in schema but **never populated** in sampled data — sync truth is **`library_meta.synced_catalog_path`** only. **`model.json` `source`** can hold a developer’s absolute training path while inference uses the installed ONNX next to it.

---

## Related code entry points

- Schemas: `db/library/bootstrap.ts`, `db/jobs/jobs.ts`
- Config: `config.ts`
- Path resolve: `utils/path-resolve.ts`
- Vision cache write/read: `vision/vision-cache.ts`, `db/library/vision-cache.ts`
- Catalog sync meta: `lightroom/catalog-sync.ts`, `api/lt-config.ts`
- Job checkpoints: `jobs/checkpoint.ts`, `jobs/runner.ts`
- Library DB resolution: `jobs/library-db.ts`, `api/library-db.ts`
- Thumbnail roots: `api/images/common.ts:67-85`

Prior cross-platform audit: `git show origin/research/posix-assumptions:docs/research/posix-assumptions-audit.md`.
