# Context: Visualizer (TypeScript API + React UI)

## Purpose

The visualizer is the web product that surfaces library data to the user. It consists of a Hono backend (`apps/visualizer/backend/`) and a React SPA (`apps/visualizer/frontend/`). They are developed and deployed together — backend and frontend share the same domain model and API contracts. The backend also carries the library itself (catalog reader, vision pipeline, CLIP, scoring) and the `lightroom-tagger` CLI; there is no separate library package.

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
| **visualizer DB** | `visualizer.db` — SQLite database holding jobs, logs, and visualizer-specific state. Separate from `library.db`. |
| **library DB** | `library.db` — the shared library database (images, scores, descriptions), read and written through `db/library/`. Legacy Instagram-matching data lives in `instagram-matching-export.json` beside the DB ([#228](https://github.com/ccanalesb/lightroom-tagger/issues/228)). |
| **catalog drift** | `config.yaml` names one catalog while `library.db` still mirrors another. Opens the moment `catalog_path` changes and closes only when a catalog sync finishes, which is why the sync records what it read in `library_meta.synced_catalog_path` rather than the UI inferring it from an unsaved edit. `GET /api/config/catalog` reports it as `needs_catalog_sync`; unknown (a library synced before that key existed) reports `false`, because a guess here is a false alarm. |
| **library-DB lifecycle seam** | Job handlers open `library.db` via `withLibraryDb` in `jobs/handlers/common.ts`; never hand-roll `initLibraryDb(...)` + manual `close()` in handler bodies. See ADR-0011. |
| **vision cache** | One compressed JPEG derivative (50–135 KB) plus a phash per image, under `vision_cache_dir` (default `~/.cache/lightroom_tagger/vision`), indexed by the `vision_cache` table. Built by decoding the original from wherever `filepath` points. It is the thumbnail route's preferred source, ahead of the original — so the cache, not the originals, is what the UI actually reads. |
| **local-only operation** | Work that must run on the machine holding the catalog and the photos: catalog sync, cache builds, and catalog selection. Distinct from browsing, which any client can do. See ADR-0019. |
| **route group** | An `OpenAPIHono` router under `apps/visualizer/backend/src/api/`, mounted in `app.ts`. One per domain area (jobs, images, descriptions, providers, scores, identity, system). Successor to the Flask blueprint, and the mount prefixes are unchanged. |
| **response helpers** | `utils/responses.ts` — `errorNotFound`, `errorBadRequest`, `successPaginated`, etc. Always use these for consistent JSON shapes. |
| **WebSocket / SocketIO** | Real-time job progress pushed from backend to frontend via socket.io + socket.io-client. |
| **perspective** | Named scoring lens shown in the UI (matches the library concept). |
| **cull** | Local Laya stage before kimi in `batch_describe`, `batch_score`, and `batch_analyze` (frame substance → cull → describe/score on **sent** photos only; void frames are not described). Standalone job `batch_cull_photos_before_scoring`; re-decide job `batch_redecide_cull_verdicts_from_stored_answers` (no model). Job results include **held back** counts (void, cut, pending, sent-by-hand passed) and step **durations**. |
| **culling recipe** | Questions on dimensions (e.g. point of tension, connotation), each answered on levels lowest first, in one or more **level sets** (recipe 7H47: 7 and 10 levels), plus a rule — when a dimension fails or is strong, when a level set cuts (all listed fail / N or more fail unless one is strong / the average fails), and with several sets whether every one or any must cut. Seeded from `prompts/culling-recipes/`, edited in the app like a perspective. Its text is versioned; its rule is not. |
| **Score forecast** | The second stage: Laya new's probability that the AI score is 8 or more on a perspective; cuts when the highest is below the pipeline setting's threshold (0.111). Off when Laya new is not set up. Never call it a score in the UI — the bigger model's output is the "AI score". |
| **stage** | One thing Laya answers per photo: a culling recipe at one level set, or the Score forecast. A **stage version** changes with the model or the text asked (question, level text or count); answers are stored per stage version and old versions stay as history. |
| **pipeline setting** | Which culling recipes run, a snapshot of their rules, and the Score forecast threshold; versioned in `library.db`. A rule or threshold change is a new pipeline-setting version, re-decided from stored answers without a model call. |
| **cull verdict** | The per-photo summary jobs and the UI read (`cull_verdicts`): `cut` (by the culling recipe or the Score forecast), `sent`, or `pending` (a stage still unanswered — never sent). A recipe never cuts on a level set it has no answer for. |
| **manually cull** (sent by hand) | The user sends a cut photo on: it is described and scored, and never cut automatically again, across every version. Shown as the "Manually cull" badge. Recorded in `cull_user_actions` with the other two cull actions, "agrees with the cut" and "should have been cut", each with the verdict it answered. |
| **Cull UI (#340)** | Images → **Cull catalog** (`cull_catalog=true`); Processing → **Cull** (`/api/cull/*`); Perspectives → **Culling recipes** (`/api/culling-recipes/*`). Send-by-hand enqueues `batch_analyze` with `metadata.image_keys`. UI review: `bash apps/visualizer/scripts/dev-cull-ui.sh`. |
| **Lightroom write-back (#341)** | Optional stars/reject from cull verdicts into the live `.lrcat` (`/api/cull/lightroom-writeback/*`), guarded by user pick/rating, keywords `lrt-auto-stars` / `lrt-auto-reject`, and per-photo state in `lr_writeback_state`. The two switches are settings only; writing happens in the cancellable `lr_writeback` job, queued by **Write to Lightroom** and after a standalone cull (not in-job cull), re-decide or send-by-hand when a switch is on, and it writes only when Lightroom is closed. Turning a switch off cancels the running job; guards read live catalog, not `library.db` pick/rating ([#342](https://github.com/ccanalesb/lightroom-tagger/issues/342) out of scope). |
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
| `config.ts` | Env-var getters (`LIBRARY_DB`, `FLASK_PORT`, `OLLAMA_HOST`, …) plus the `config.yaml` loader |
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
| `cli/` | The `lightroom-tagger` CLI — `scan`, `sync`, `search`, `export`, `init`, `stats`, `enrich-catalog`, `cull-check`, `cull-import` |
| `laya/` | Laya base and Laya new (the cull's local models) through ONNX in a worker thread; files from `scripts/laya/export_onnx.py` in the git-ignored `models/`. See ADR-0020 |
| `cull/` | The cull's decisions (`decide.ts`, pure), stages and their versions (`stages.ts`), one photo stored and decided (`persist.ts`), the research-run import. Storage in `db/library/cull-*.ts`; jobs in `jobs/handlers/cull.ts` (standalone cull), `cull-pass.ts` (shared pass), `cull-stage.ts` (in-job step before kimi), `redecide.ts` (stored-answer re-decide), `work-keys.ts` (describe/score work selection) |
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
