# Context: Visualizer (TypeScript API + React UI)

## Purpose

**Fixer** is the product name. The web UI (historically called the visualizer) surfaces library data to the user. It consists of a Hono backend (`apps/visualizer/backend/`) and a React SPA (`apps/visualizer/frontend/`). They are developed and deployed together — backend and frontend share the same domain model and API contracts. The backend also carries the library itself (catalog reader, vision pipeline, CLIP, scoring) and the `fixer` CLI; there is no separate library package.

## Domain language

| Term | Meaning |
|---|---|
| **job** | A background task (e.g. score images, generate descriptions, build catalog cache). Stored in `visualizer.db`. Has a lifecycle: `pending → running → completed / failed / cancelled`. |
| **job runner** | `JobRunner` in `jobs/runner.ts` — coordinates job lifecycle, progress hooks and cancellation. Handlers run on the main event loop, one job at a time, and poll `runner.isCancelled(jobId)` between units of work. Long synchronous loops must yield cooperatively so the API stays responsive. See ADR-0018. |
| **job processor** | `jobs/processor.ts` — started at app startup, drains the job queue and dispatches to handlers. |
| **handler** | A function in `jobs/handlers/` (one module per job family) that implements a specific job type (e.g. `handleBatchDescribe`, `handleBatchStackDetect`). |
| **job-type registry** | `jobs/registry.ts` — explicit `JOB_TYPES` list co-locating handler, catalog requirement, and checkpoint helpers per type. Single registration surface; mirrors ADR-0006. See ADR-0010. |
| **job transitions seam** | `jobs/transitions.ts` — pure cancel/retry status legality and `updateJobStatus` targets. Routes delegate via `transitionCancel` / `transitionRetry`; no status-rule literals in `api/jobs.ts`. See ADR-0010. |
| **checkpoint** | Persisted job progress snapshot merged into job metadata so interrupted jobs can resume. |
| **emit_progress** | SocketIO callback passed into job runner and handlers to push real-time progress to the frontend. |
| **catalog** | The Lightroom Classic `.lrcat` file, named by `catalog_path` in `config.yaml`. Exactly one per installation. Read (and keyword-written) through `lightroom/`. Never a synonym for the **library DB**, which mirrors it, nor for an **image filepath**. Beware: several existing identifiers say "catalog" when they mean one of the other two — `catalogRequiringJobTypes()` gates on the library DB, and `utils/path-resolve.ts`'s `resolveCatalogPath` resolves image filepaths. |
| **data folder** | User-writable state for one install: `config.yaml`, `providers.json`, `library.db`, `visualizer.db`, `models/`, the vision cache, thumbnails, and (in the packaged app) converter caches. In a source install both `LT_DATA_DIR` and `LT_RESOURCES_DIR` default to the repo root, so paths match today's layout; the desktop host sets `LT_DATA_DIR` to app-local data. Per-file env vars (`LIBRARY_DB`, `DATABASE_PATH`, `LT_CONFIG_YAML`, `LT_PROVIDERS_JSON`, …) still override the defaults. |
| **resources** | Read-only bundle the backend reads but never writes: factory prompts (`prompts/perspectives`, `prompts/culling-profiles`), `scripts/app-models/`, `providers.example.json`, and (when packaged) the built SPA. `LT_RESOURCES_DIR` defaults to the repo root in a source install. |
| **visualizer DB** | `visualizer.db` — SQLite database holding jobs, logs, and visualizer-specific state. Separate from `library.db`. Lives in the **data folder**. |
| **library DB** | `library.db` — the shared library database (images, scores, descriptions), read and written through `db/library/`. An older one is upgraded to the current schema when the server starts, and by the first request, job or CLI command that opens it. Legacy Instagram-matching data lives in `instagram-matching-export.json` beside the DB ([#228](https://github.com/ccanalesb/lightroom-tagger/issues/228)). |
| **catalog drift** | `config.yaml` names one catalog while `library.db` still mirrors another. Opens the moment `catalog_path` changes and closes only when a catalog sync finishes, which is why the sync records what it read in `library_meta.synced_catalog_path` rather than the UI inferring it from an unsaved edit. `GET /api/config/catalog` reports it as `needs_catalog_sync`; unknown (a library synced before that key existed) reports `false`, because a guess here is a false alarm. |
| **library-DB lifecycle seam** | Job handlers open `library.db` via `withLibraryDb` in `jobs/handlers/common.ts`; never hand-roll `initLibraryDb(...)` + manual `close()` in handler bodies. See ADR-0011. |
| **vision cache** | One compressed JPEG derivative (50–135 KB) plus a phash per image, under `vision_cache_dir` (default `~/.cache/lightroom_tagger/vision` in a source install, or `<data folder>/vision-cache` when `LT_DATA_DIR` is set), indexed by the `vision_cache` table. Built by decoding the original from wherever `filepath` points. It is the thumbnail route's preferred source, ahead of the original — so the cache, not the originals, is what the UI actually reads. |
| **local-only operation** | Work that must run on the machine holding the catalog and the photos: catalog sync, cache builds, and catalog selection. Distinct from browsing, which any client can do. See ADR-0019. |
| **route group** | An `OpenAPIHono` router under `apps/visualizer/backend/src/api/`, mounted in `app.ts`. One per domain area (jobs, images, descriptions, providers, scores, identity, system). Successor to the Flask blueprint, and the mount prefixes are unchanged. |
| **response helpers** | `utils/responses.ts` — `errorNotFound`, `errorBadRequest`, `successPaginated`, etc. Always use these for consistent JSON shapes. |
| **WebSocket / SocketIO** | Real-time job progress pushed from backend to frontend via socket.io + socket.io-client. |
| **perspective** | Named scoring lens shown in the UI (matches the library concept). |
| **culling** | The whole step before kimi — its stages are the culling profile (one per level set) and the Score forecast, each asking its model through a **System One endpoint** — in `batch_describe`, `batch_score`, and `batch_analyze` (frame substance → culling → describe/score on **passed** photos only; void frames are not described). Standalone job `batch_cull_photos_before_scoring`; re-decide job `batch_redecide_cull_verdicts_from_stored_answers` (no model). Job results include **held back** counts (void, filtered, pending, sent-by-hand passed) and step **durations**. Identifiers keep the `cull` prefix (`cull_*` tables, `/api/cull/*`, `batch_cull_*`, `cull/`). |
| **culling profile** | Questions on dimensions (e.g. point of tension, connotation), each answered on levels lowest first, in one or more **level sets** (the Default culling profile, slug `default`: 7 and 10 levels), plus a rule — when a dimension fails or is strong, when a level set filters (all listed fail / N or more fail unless one is strong / the average fails), and with several sets whether every one or any must filter. Seeded from `prompts/culling-profiles/`, edited in the app like a perspective. Its text is versioned; its rule is not. |
| **Score forecast** | The second stage: its model's probability that the AI score is 8 or more on each **Score forecast question**; filters when the highest is below the pipeline setting's threshold (0.111). A pipeline-setting switch turns it on or off. A stage that is on and whose model cannot answer, or a Score forecast with no questions, fails the culling job, naming the stage. Never call it a score in the UI — the bigger model's output is the "AI score". |
| **Score forecast question** | What the Score forecast's model answers per photo: a name, an optional perspective it belongs to, its text, and 10 levels (lowest first). An optional one is first asked "applies?" (stored as `<id>-excusal`); when it does not apply it is left out of the highest. The id is fixed when the question is made. One versioned set in `library.db` (`score_forecast_question_versions`), edited in Perspectives → Score forecast questions; going back to an earlier text reuses its stage version and answers. A library that already had Score forecast answers starts with the questions those answers were made with; a new one has none until they are created from the active perspectives (a script, no model) or written by hand. |
| **stage** | One thing a model answers per photo: a culling profile at one level set (`culling_profile:<slug>:<set>`), or the Score forecast. A **stage version** changes with the model's identity or the text asked (question, level text or count; a Score forecast question's name or perspective is not asked, so it does not); switching back to an earlier model makes its version current again; answers are stored per stage version and old versions stay as history. |
| **System One endpoint** | How a culling stage reaches its model (ADR-0021): `POST /v1/systemone` (`{model, state, images, questions}` → probabilities per question) and `GET /v1/models`. Each stage's endpoint, model and API key are `culling_models` in `config.yaml`, chosen in Processing → Settings → **Culling models** (`/api/culling-models`; the API key is never sent back to the browser and is cleared when the endpoint changes). Changing a stage's model there offers a culling job (`batch_cull_photos_before_scoring`) that answers the photos with it; until a culling job runs, verdicts rest on the previous model's answers. The default is **this app's endpoint** with **no model**: a job with a stage on and no model fails naming the stage. `GET /api/culling-models/usable` says per stage whether it can run now (`no_model`, `converting`, `down`, `refused`, `not_listed`, `no_questions`); a job on a stage whose model in this app is still converting fails saying so. This app's endpoint serves the models installed in it (one directory each in `models/`, added in Processing → Settings → **Models in this app** from a folder in Hugging Face format or a Hugging Face id, converted once by the `app_model_install` job; `/api/app-models`) at `/v1/*`, outside `/api`. A model is listed only once its conversion job succeeded. A model's identity is the endpoint's `x_model_id` when it gives one, else `<model>@<endpoint>`. Answers record the endpoint that produced them (`this_app` or its URL). |
| **System One model** | Any model that answers the System One contract, whether this app serves it or another endpoint does. The culling stages' models are System One models. |
| **model in this app** (installed model) | A System One model this app runs itself, from one directory in `models/`, listed in Processing → Settings → **Models in this app**. Today only SmolVLM (Idefics3) models with a decision head convert (`unsupported_architecture` otherwise); that is a limit of the converter, not part of what the term means. |
| **pipeline setting** | Which culling profiles run, a snapshot of their rules, the Score forecast threshold, and three switches: the culling profile on/off (`culling_profiles_enabled`), whether its rule filters photos from kimi (`culling_profiles_filter_enabled`), and the Score forecast on/off. A new library has no models, so both stages start off; the filter switch starts on. Every stage that is on is answered on every photo; versioned in `library.db`. A rule, threshold or switch change is a new pipeline-setting version, re-decided from stored answers without a model call. |
| **culling verdict** | The per-photo summary jobs and the UI read (`cull_verdicts`): `filtered` (by the culling profile's rule when its filter is on, or the Score forecast when on), `passed`, or `pending` (a stage that decides still unanswered — never passed); with both filters off every photo passes. It also keeps what the culling profile's rule says (`culling_profile_verdict`), filter on or off. UI: Filtered / Passed / Pending. A profile never filters on a level set it has no answer for. |
| **sent by hand** | The user sends a filtered photo on: it is described and scored, and never filtered automatically again, across every version. Shown as the "Sent by hand" badge. Recorded in `cull_user_actions` with the other two culling actions, "agrees with the filter" and "should have been filtered", each with the verdict it answered. |
| **Culling UI (#340)** | Images → **Culling catalog** (`cull_catalog=true`); Processing → **Culling** (`/api/cull/*`); Perspectives → **Culling profiles** (`/api/culling-profiles/*`); Perspectives → **Score forecast questions** (`/api/score-forecast-questions`; Save only / Save and queue culling job); Processing → Settings → **Culling models** (the pipeline setting's switches and the Score forecast's level and threshold; each change is a new pipeline-setting version and queues the re-decide job, or leaves it to the one already waiting; with the Score forecast on, how it works and its questions, or Create questions from my perspectives / Write them myself); Processing → Settings → **Models in this app** (installed models, Ready or Converting, and Add a model). Send-by-hand enqueues `batch_analyze` with `metadata.image_keys`. Before a job that runs culling starts (Analyze, send-by-hand, Settings → Process photos), the UI asks `/api/culling-models/usable`; a stage on that cannot run opens a dialog (culling profile first): Cancel, fix it in Settings, or turn the stage off and start. The Culling tab says when the culling profile is off or cannot run, and warns when the Score forecast cannot run. UI review: `bash apps/visualizer/scripts/dev-cull-ui.sh`. |
| **Lightroom write-back (#341)** | Optional stars/reject into the live `.lrcat` — stars from the culling profile's strong dimensions, none on a void frame; reject where the culling profile's rule says filtered (whatever decided the photo) or on a void frame, never on a photo sent by hand (a frame substance override puts a void frame back to the rule; illegible frames follow the rule, they still have a subject to judge); none of either while the culling profile is off — (`/api/cull/lightroom-writeback/*`), guarded by user pick/rating, keywords `lrt-auto-stars` / `lrt-auto-reject`, and per-photo state in `lr_writeback_state`. The two switches are settings only; writing happens in the cancellable `lr_writeback` job, queued by **Write to Lightroom** and after a standalone culling job (not in-job culling), re-decide or send-by-hand when a switch is on, and it writes only when Lightroom is closed. Clearing the app's stars or reject in Lightroom counts as an undo; the photo is found by the file id `library.db` holds for its key. Each photo the app manages also gets a revision in Classic's sync docstore (`<catalog> Sync.lrdata/…/Managed Catalog.mcat`) carrying its catalog stars/flag, since Classic uploads only changes it made itself; undo pushes too. Turning a switch off cancels the running job; guards read live catalog, not `library.db` pick/rating ([#342](https://github.com/ccanalesb/lightroom-tagger/issues/342) out of scope). |
| **model-scoped re-do** (`redo_unless_model`) | A batch describe/score mode that regenerates every eligible image *except* those whose current row was produced by the named target model, which it preserves. Lets a model-swap backlog run over many throttled cycles without redoing the target model's own finished work. Overrides blanket `force`. |
| **identity** | Photographer style fingerprint and suggestions page (`IdentityPage.tsx`). Catalog-only candidate pool ([#218](https://github.com/ccanalesb/lightroom-tagger/issues/218)); Advisor `high_score_unposted` / `eligible_unposted` key off manually set `instagram_posted` (see [#205](https://github.com/ccanalesb/lightroom-tagger/issues/205)). |
| **description search** | Keyword filter on the Images page (`CatalogTab` / `description_search` → FTS5 over `image_descriptions`); not the retired chat Search page. |
| **instagram_posted** | Catalog flag: user marks a photo as posted to Instagram in `ImageDetailModal`. Advisor and catalog `posted` filters read the column only — not derived from Instagram dump rows ([#218](https://github.com/ccanalesb/lightroom-tagger/issues/218)). |

The Images page is catalog-only in the UI ([#225](https://github.com/ccanalesb/lightroom-tagger/issues/225)). Instagram gallery, match review, dump import, vision matching, and describe/score/embed over dump media were removed; see `docs/parked/instagram-matching.md`.

## Key files

### Backend

| File | Role |
|---|---|
Paths are relative to `apps/visualizer/backend/src/`.

| File | Role |
|---|---|
| `app.ts` | `createApp()` factory — mounts the route groups, CORS and the OpenAPI document |
| `server.ts` | Process entry point — binds the port, attaches SocketIO, starts the job processor |
| `config.ts` | Env-var getters (`LT_DATA_DIR`, `LT_RESOURCES_DIR`, `LIBRARY_DB`, `FLASK_PORT`, …), path roots, shared `library.db` resolution, and the `config.yaml` loader |
| `db/jobs/` | Visualizer DB schema and helpers (jobs, logs, checkpoints) |
| `db/library/` | Every `library.db` read and write, one module per table family; `bootstrap.ts` owns the schema |
| `jobs/runner.ts` | `JobRunner` — lifecycle, cancellation, progress hooks |
| `jobs/registry.ts` | Explicit `JOB_TYPES` registry — dispatch, catalog requirement, checkpoint co-location |
| `jobs/handlers/` | Per-job-family handler modules (`analyze`, `embed`, `stacks`, …) |
| `jobs/transitions.ts` | Pure cancel/retry state machine (`transitionCancel`, `transitionRetry`) |
| `jobs/checkpoint.ts` | Checkpoint merge logic |
| `api/jobs.ts` | REST endpoints for job CRUD and cancellation (zod + OpenAPI — ADR-0013) |
| `api/images/` | Catalog and stack image route groups (`catalog`, `stacks`, `frame-substance`) |
| `api/descriptions.ts` | Description fetch/trigger endpoints |
| `api/scores.ts` | Score endpoints per image/perspective |
| `api/identity.ts` | Identity/suggestions endpoints |
| `api/providers.ts` | Provider availability endpoints |
| `api/system.ts` | Health, config, system info |
| `api/schemas/` | zod request/response models, one module per group |
| `websocket/` | SocketIO event handlers |
| `utils/responses.ts` | Shared JSON response helpers |
| `cli/` | The `fixer` CLI — `scan`, `sync`, `search`, `export`, `init`, `stats`, `enrich-catalog`, `cull-check` |
| `app-models/` | The models in this app, through ONNX in a worker thread, each loaded on its first request; one directory per model in the git-ignored `models/`, written by `scripts/app-models/export_onnx.py` (run by the `app_model_install` job, `install.ts`). A model without its own vision graph reads the one of the installed model it was fine-tuned from. `app-models.ts` serves them on this app's System One endpoint, starting the worker on the first request and closing it after two idle minutes. See ADR-0020, ADR-0021 |
| `systemone/` | The System One contract's questions (`question.ts`) and the client culling uses for every stage, whether the endpoint is this app (in-process) or another server. See ADR-0021 |
| `api/systemone.ts` | This app's System One endpoint (`GET /v1/models`, `POST /v1/systemone`) |
| `cull/` | Culling decisions (`decide.ts`, pure), stages and their versions (`stages.ts`), each stage's model through System One (`stage-models.ts`), one photo stored and decided (`persist.ts`). Storage in `db/library/cull-*.ts`; jobs in `jobs/handlers/cull.ts` (standalone culling), `cull-pass.ts` (shared pass), `cull-stage.ts` (in-job step before kimi), `redecide.ts` (stored-answer re-decide), `work-keys.ts` (describe/score work selection) |
| `lightroom/` | `.lrcat` reader, keyword writer and the catalog sync driver |
| `imaging/`, `vision/`, `providers/`, `analyzer/`, `identity/`, `clip/` | The library layer: RAW decode, CLIP, phash, vision calls, scoring, identity |

### Frontend

| File / Dir | Role |
|---|---|
| `src/App.tsx` | Route definitions (React Router 6) |
| `src/pages/` | Page components: Dashboard, Images, Processing, Identity |
| `src/components/` | Shared UI components |
| `src/services/` | API client (`api.ts`) and WebSocket service |
| `src/hooks/` | Custom hooks (e.g. `useJobSocket` — invalidates `jobs.list` on server-emitted `job_created`) |
| `src/stores/` | Zustand stores (minimal — mainly WebSocket state) |
| `src/constants/` | UI strings and other constants |
| `src/types/` | Shared TypeScript types generated from backend OpenAPI (`api.gen.ts`, ADR-0013); thin per-group re-exports |

The server emits `job_created` on job creation (`POST /jobs`); `useJobSocket` owns the resulting `jobs.list` invalidation. No component hand-bubbles a job-list-refresh callback (e.g. an `onJobEnqueued` prop) outside `useJobSocket` — refresh-on-enqueue is driven by the server's `job_created` event. No component subscribes to job socket events (`job_created` / `job_updated` / `jobs_recovered`) outside `useJobSocket`. Per-job `subscribe_job` / `unsubscribe_job` emits are the one allowed exception (job-instance scoped, not fan-out).

## Architectural constraints

- **Frontend and backend are one unit**: changes to API shape must be reflected in both the backend route group and the frontend service layer.
- **The backend is always local; only the UI travels** (ADR-0019): the backend and CLI run on the machine that holds the catalog and can reach the photos, because catalog reads, RAW decode, CLIP and vision work all need them. The SPA may be served to other devices, but any **local-only operation** is unavailable to a remote client.
- **SocketIO for job progress**: never poll for job status — use the WebSocket channel.
- **Always use `utils/responses.ts` helpers**: never return a raw `c.json(...)` with an ad-hoc status code from a route.
- **Cancellation is polled, not thrown**: handlers check `runner.isCancelled(jobId)` between units of work and pass a `cancelCheck` down; there is no thread-local cancel scope.
- **Dev proxy**: Vite proxies `/api` and `/socket.io` to `localhost:5001`; don't hardcode backend URLs in frontend code.
- **Design system**: all UI work must follow `apps/visualizer/frontend/DESIGN.md` (Tailwind semantic classes, 8px grid, Inter font, single blue accent).
- **Job-type knowledge through `JOB_TYPES` only** (ADR-0010): dispatch (`getJobHandler`), catalog gating (`jobTypesRequiringCatalog`) and checkpoint helpers are registry projections — no second handler map or catalog set.
- **Job status transitions through `jobs/transitions.ts` only** (ADR-0010): `api/jobs.ts` delegates cancel/retry to `transitionCancel` / `transitionRetry`; no cancellable/retryable status sets or `updateJobStatus` targets in routes.
- **Library-DB lifecycle through `withLibraryDb` only** (ADR-0011): handler orchestration goes through the helper in `jobs/handlers/common.ts`; no hand-rolled `initLibraryDb(...)` + manual `close()`.
- **API contract seam — backend-authoritative OpenAPI** (ADR-0013): All API response shapes are zod schemas registered on their route; frontend types are generated from OpenAPI (`npm run generate:api` → `src/types/api.gen.ts`); drift is gated in CI (see `.sandcastle/ci-drift-gate.yml`). `frontend/src/services/api.ts` must not declare hand-written response interfaces.

The last four were each enforced by a Python guardrail test that read the Flask
tree with `ast`, and those went with it. Two are now structural instead: the
registry is the only thing typed to hold a handler, and `withLibraryDb` is the
only export that hands out a connection. The other two are conventions until
something replaces the guardrails
([#306](https://github.com/ccanalesb/lightroom-tagger/issues/306)).
