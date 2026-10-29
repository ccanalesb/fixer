# TypeScript backend migration — stack decision and plan

Scope: replace **all** Python in this repo with TypeScript, leaving no Python in the
running process. Covers `apps/visualizer/backend/` (Flask API + job queue) and the
`lightroom_tagger/` library (vision, scoring, identity, catalog, CLI).

## What we are migrating

| Area | LOC | Notes |
|---|---|---|
| `apps/visualizer/backend` non-test | 10,146 | 63 routes, spectree/pydantic, SocketIO, threaded job queue |
| `apps/visualizer/backend/tests` | 12,455 | contract tests gate CI |
| `lightroom_tagger/` | 22,892 | includes its own colocated tests |
| **Total Python** | **46,815** | 257 files |

Background ecosystem research, with 84 cited primary sources, is in
[`docs/research/nodejs-raw-clip-whash-feasibility.md`](../research/nodejs-raw-clip-whash-feasibility.md).
This document records the decisions; that one records the evidence for the library
choices.

## Feasibility: measured, not assumed

Every claim below was verified by running code against the live `library.db`
(638 MB, 43,451 embedded images) and real files on the mounted NAS. Scripts live in
the session scratchpad; results reproduced here.

### SQLite, sqlite-vec and FTS5 — no problem

`better-sqlite3` + the `sqlite-vec` npm package opened the production database
read-only and loaded extension version **v0.1.9 — the exact version Python pins**.
Cosine KNN over the `image_clip_embeddings` vec0 table returned correct neighbours
from Node, and stored blobs are 2048 bytes = 512 float32 with L2 norm 1.000000.
`image_descriptions_fts` (FTS5) is readable.

**No data migration is required.** The database is the stable interface.

### RAW decoding — viable via `libraw-wasm`

`rawpy.imread(p).postprocess(use_camera_wb=True, half_size=True)` maps onto
`libraw-wasm`'s `{ useCameraWb: true, halfSize: true }`. Verified decode of one
real file per format present in the catalog:

| Format | In catalog | Decode | Time |
|---|---|---|---|
| `.dng` | 17,590 | 6209×4299 | 1350 ms |
| `.arw` | 12,259 | 2012×3012 (half) | 244 ms |
| `.raf` | 11,252 | 2014×3016 (half) | 980 ms |
| `.sr2` | 272 | 2748×1836 (half) | 221 ms |
| `.cr2` | 239 | 1732×2601 (half) | 399 ms |

Output was JPEG-encoded through `sharp` and visually confirmed correct (colour and
orientation) on the Fuji RAF sample. Notably, `sharp`/libvips **cannot** open ARW,
RAF or SR2 at all — `sharp-libvips` is built `-Draw=disabled` — and `exifr` only
yields 160×120 thumbnails. So `libraw-wasm` is the only viable path, not one option
among many.

A soak test of 60 sequential decodes: **60/60 succeeded, 872 ms/image** average
(the mix includes full-size DNGs), RSS oscillating 405–716 MB with no unbounded
growth. Extrapolated, a **full** vision-cache rebuild of ~41,000 RAW files is
**~10 hours single-threaded**, ~2.5 hours over 4 workers.

Three caveats:

1. `libraw-wasm` ships a **browser** build. It calls `new Worker(url, {type:'module'})`
   and its Emscripten runtime fetches `libraw.wasm` over `file://`. Running it in Node
   needs a ~25-line adapter: a `globalThis.Worker` shim over `node:worker_threads`, a
   worker-side `self` shim (it assigns `self.onmessage` / calls `self.postMessage`),
   and a `fetch` polyfill for `file://` URLs. Proven working, but it is our code to
   own and re-verify on every `libraw-wasm` upgrade.
2. **Construct a fresh instance per image and dispose it.** Reusing one instance
   across 25 decodes grew RSS 405 → 699 MB; fresh-per-image stays flat. Driving the
   Emscripten factory in-process instead (the alternative integration) reportedly
   fails outright after ~14 images without an explicit `delete()`. The Worker-based
   adapter above did not reproduce that failure — another reason to prefer it.
3. `halfSize` is **ignored for DNG** — the DNG sample decoded at full 6209×4299.
   With 17,590 DNGs that is the dominant cost. Downscale explicitly after decode.

Format coverage is not a concern for *this* catalog. Full inventory:

| `.dng` | `.arw` | `.raf` | `.tif` | `.jpg` | `.sr2` | `.cr2` | `.mp4` | `.mov` | `.heic` | `.psd` |
|---|---|---|---|---|---|---|---|---|---|---|
| 17,590 | 12,259 | 11,252 | 1,270 | 853 | 272 | 239 | 32 | 23 | 2 | 2 |

The formats with known WASM problems — `.x3f` (does not decode in Node at all),
`.orf` and `.srw` (numeric divergence in the WASM build), plus `.nef`, `.cr3`,
`.rw2` — have **zero** files in the catalog, even though `RAW_EXTENSIONS` lists them.
Keep them listed and let them fail loudly rather than pretending they are supported.

### CLIP embeddings — viable and drop-in compatible, via a resampler port

`@huggingface/transformers` (transformers.js v3) with `Xenova/clip-vit-base-patch32`
at `dtype: 'fp32'` produces 512-d embeddings at **19.5 ms/image**. `q8` is not faster
(20.3 ms), so use fp32.

Used naively, JS vectors are **not** interchangeable with the stored Python ones.
Feeding the same cache JPEG to both:

- same-image cosine, JS vs Python: **mean 0.931** over 8 images spread across the
  library (range 0.907–0.953), and 0.947 over 8 frames from a single burst
- baseline cosine between unrelated photos (Python vs Python, 780 pairs): mean 0.557, p95 0.717, max 0.848
- **top-10 neighbour overlap: only 5.3/10**
- self-retrieval: 8/8 at rank 0

A JS vector reliably identifies *its own* image, but the near-duplicate *ranking*
disagrees about half the time — and that ranking is exactly what stack detection and
catalog similarity do.

**The cause is preprocessing alone, and it is fixable.** Dumping Python's own
`pixel_values` tensor and feeding it through the Node graph unchanged gives:

```
key                    python-tensor->node   sharp-preproc->node
2020-03-08__CC14833        1.000000              0.942312
2020-03-08__CC14832        1.000000              0.960001
...
mean                       1.000000              0.947187
1 - cos (python tensor path): 2.575e-12
```

The ONNX weights are numerically exact to 2.6e-12. Every bit of the drift comes from
`transformers.js`'s `RawImage.resize`, which resizes via sharp/libvips bicubic — not
PIL bicubic. (Its source comment claims PIL parity; that claim is wrong, and upstream
issues #482/#595/#816 have tracked it unfixed since 2023.)

**This is now done and the reindex is eliminated.** `src/imaging/pil-resample.ts`
ports Pillow's resampler and `src/imaging/clip-preprocess.ts` builds the tensor,
bypassing `RawImage.resize`. Measured against the stored corpus over 8 images spread
across the catalog (`tests/clip-parity.test.ts`):

- **worst cosine 1.000000000**, worst `1 - cos` = **3.52e-12**
- **top-10 neighbour lists identical** to the stored query vectors, up from 5.3/10

Node now writes vectors that are drop-in compatible with the 43,451 already stored.
Re-embedding remains available as a fallback (~14 min single-threaded) but is no
longer part of the plan.

### Perceptual hashing — viable, reimplement directly

`imagehash.phash` is ~15 lines: greyscale → 32×32 LANCZOS → 2D DCT-II → top-left
8×8 → threshold at median. Reimplemented over `sharp` and compared against the
phashes Python stored in `vision_cache`:

With the Pillow-exact resampler it reproduces Python's stored hashes **12/12
exactly, max Hamming distance 0 of 64 bits** (`tests/phash-parity.test.ts`).

One correction to an earlier measurement here. A first pass using `sharp` for the
resize scored 7/12 exact with ~2 bits of drift, and that was attributed purely to
resampling — but it also compared the wrong input. `vision_cache` hashes the
*viewable* image, not the compressed cache file:

```python
viewable_path = get_viewable_path(original_path)
temp_path = compress_image(viewable_path)
phash = compute_phash(viewable_path)   # the viewable, not the cache JPEG
```

So part of that 2-bit drift was comparing a different image at a different
resolution. The parity test therefore restricts itself to originals that are already
JPEG, where `get_viewable_path` returns the path unchanged and the input is
reproducible. For RAW originals the viewable was a temp file that no longer exists,
so those rows cannot be used to verify a hash — worth knowing before anyone tries.

No wavelet library is needed: `imagehash.whash` is reachable only from
`compute_multiple_hashes`, which **nothing in production calls**. It is dead code —
drop it rather than port it. (For the record, had it been live: the 2D Haar DWT is
~12 lines, and `remove_max_haar_ll=True` is arithmetically a no-op.)

### The one cross-cutting risk: Pillow's resampler is load-bearing twice

Both CLIP and phash reach parity only through a PIL-equivalent resize, because every
value already in the database came through Pillow. `sharp` is not a substitute:

| Resize via `sharp` | Measured consequence |
|---|---|
| CLIP embeddings | cosine 0.93–0.97 vs the stored corpus — inside the near-duplicate band |
| phash | 7/12 exact, ~2 bits drift |
| whash (if it were live) | only 33% exact, up to 22/64 bits wrong |

There is a **third** silent divergence beyond the resize, not covered by the research:
`sharp().greyscale()` disagrees with PIL `convert("L")` on **23.7% of pixels** (max 11
levels) on a real cache JPEG. PIL uses ITU-R 601-2 luma in fixed point,
`(R*19595 + G*38470 + B*7471 + 0x8000) >> 16`, which `pilGreyscale` implements. Since
phash greyscales *before* resizing, using sharp here would corrupt every hash.

What is NOT a problem: **JPEG/PNG decoding is byte-identical.** sharp and PIL produced
the same 2,098,176 bytes with zero differences on a real cache JPEG, so decoding can
be delegated to sharp and only the resize and colour conversion need porting.

This is built as **one shared module**, `src/imaging/pil-resample.ts`, pinned by
golden files generated from Pillow itself
(`tests/fixtures/imaging/regenerate-fixtures.py`, 80 bit-exact resize comparisons
across bicubic and lanczos, RGB and single-channel planes). The trap it guards is that
`sharp` runs fine and looks right while being quietly wrong.

One caveat found while wiring it up: `@huggingface/transformers` depends on
`sharp ^0.34.5` and bundles its own libvips. Installing a newer sharp alongside it
loads **two** libvips into the process, which macOS flags as duplicate Objective-C
classes and warns "may cause spurious casting failures and mysterious crashes". An
npm `overrides` entry pins sharp to a single copy; keep it in step with the
transformers dependency.

### Everything else

Complete non-test third-party surface, all with direct equivalents:

| Python | TypeScript | Notes |
|---|---|---|
| `sqlite3` (43) | `better-sqlite3` | synchronous, matches current model |
| `flask` (15) | `hono` | |
| `spectree` (12) | `@hono/zod-openapi` | keeps OpenAPI backend-authoritative |
| `pydantic` (12) | `zod` | |
| `PIL` (9) | `sharp` | |
| `flask_socketio` / `eventlet` | `socket.io` | frontend already uses socket.io-client |
| `threading` (8) | `node:worker_threads` | |
| `openai` (3) | `openai` (official Node SDK) | same API surface |
| `numpy` (3) | typed arrays | only histogram / cumsum / log2 / entropy |
| `sqlite_vec` (2) | `sqlite-vec` | v0.1.9 verified |
| `imagehash` (2) | ~15 lines | verified above |
| `sentence_transformers` (1) | `@huggingface/transformers` | verified above |
| `rawpy` (1) | `libraw-wasm` | verified above |
| `yaml` (5) | `yaml` | |
| `dotenv` (3) | `node --env-file` | |

No unassessed dependency remains.

## Stack decision

**Node 24 · TypeScript 5.9 · ESM · Hono · Zod · better-sqlite3 · socket.io · Vitest**

| Concern | Choice | Why |
|---|---|---|
| HTTP | **Hono** + `@hono/zod-openapi` | ADR-0013 requires backend-authoritative OpenAPI feeding `api.gen.ts` with a CI drift gate. `@hono/zod-openapi` reproduces the pydantic→spectree→OpenAPI chain exactly. |
| Validation | **Zod** | Direct pydantic replacement; also the schema source for OpenAPI. |
| Database | **better-sqlite3** + **sqlite-vec**, raw SQL with hand-written row types | Verified against the live DB. Synchronous, matching today's usage. |
| ORM | **none** | Drizzle cannot model `vec0` or FTS5, and schema ownership stays with the existing migrations. Kysely is optional later for the plain-table subset. |
| Realtime | **socket.io** | Frontend already runs `socket.io-client`; zero frontend change. |
| Jobs | **`node:worker_threads`** pool | `better-sqlite3` is synchronous, so jobs on the main loop would stall every request. Mirrors today's thread-per-job design and `runner.thread_db()`. |
| Images | **sharp** + **libraw-wasm** | |
| CLIP | **@huggingface/transformers**, fp32, **with `RawImage.resize` bypassed** | Weights are exact; its resize is not PIL-equivalent. Feed our own tensor. `onnxruntime-node` + the raw `vision_model.onnx` is the fallback if bypassing proves awkward. |
| Resampling | **vendored PIL-exact resampler** | Required for CLIP and phash parity (see above). No npm equivalent. |
| LLM providers | **openai** npm SDK; `fetch` for Ollama | |
| Tests | **Vitest** | Already used by the frontend. |

Rejected: **tRPC** — deletes the OpenAPI seam ADR-0013 and the CI drift gate depend
on. **NestJS** — DI and decorator overhead unjustified for 63 routes. **Fastify** —
workable, but its OpenAPI story is a looser fit than Hono's.

## Sequencing

Vertical slices, each one shipping a working seam with a real consumer (per the
repo's slicing convention), not build-then-wire.

0. **Foundation** — TS project, config loader, `better-sqlite3` + `sqlite-vec` layer,
   `utils/responses` equivalents, Hono app shell with OpenAPI document. **Done.**
0b. **PIL-exact resampler** — the shared module CLIP and phash both depend on, with a
   fixture test asserting bit-exact agreement with Pillow. **Done.** Includes
   `pilResize` (bicubic/lanczos), `pilGreyscale`, `centerCrop`, the CLIP
   preprocessing chain, the phash port, and the CLIP embedding service.
1. **First vertical slice: `/api/system`** — proves the whole contract chain from a TS
   route through OpenAPI to `api.gen.ts`. **Done** (`/status`, `/stats`,
   `/catalog/status`), with the emitted OpenAPI diffed route-by-route against Flask.
2. **Route groups. Done — 52 of 52 OpenAPI paths.**
   `tests/openapi-contract.test.ts` pins every emitted path and method against a
   captured inventory of the Flask document and ratchets the migrated count, so a
   group cannot silently regress or invent a path. At 52 the ratchet is an
   equality check in practice: every path Flask serves has a TS equivalent.

   | Group | Status |
   |---|---|
   | system | done |
   | scores | done |
   | perspectives | done, including writes |
   | config | done |
   | descriptions | done, including `POST /generate` and the vision pipeline behind it |
   | catalog + stacks | done |
   | identity | done |
   | providers | done |
   | frame substance | done, including the `.lrcat` keyword writer |
   | jobs | routes, runner, processor and all eleven handlers done |
3. **Job engine — done.** worker_threads runner, `JOB_TYPES` registry, transitions
   state machine, checkpoints, socket.io progress, with the ADR-0010 guardrails
   preserved.
4. **Job handlers — done.** One family per slice: catalog sync, embed,
   analyze/score, describe, stacks, frame substance, path diagnostics. ~3,394
   lines of Python. All eleven `JOB_TYPES` now dispatch, so `JobType.handler`
   is no longer nullable and the processor's "Unknown job type" covers only a
   type that has left the registry.

   **Describe is done** (`single_describe`, `batch_describe`), and it carried the
   three shared pieces every later family needs: `jobs/checkpoint.ts`,
   `jobs/handlers/path-diagnostics.ts` and `jobs/handlers/common.ts` (catalog
   selection, date windows, failure severity, the library-DB lifecycle).
   **Embed is done** too, on top of those plus `db/library/embeddings.ts`, and so
   are the two standalone **stacks** jobs, which needed only the similarity write
   helpers — the CLIP KNN and the representative query were already ported for
   the routes.

   | Family | Types | Status |
   |---|---|---|
   | describe | `single_describe`, `batch_describe` | done |
   | embed | `batch_embed_image` | done |
   | stacks | `batch_stack_detect`, `batch_catalog_similarity` | done |
   | stacks | `catalog_cache_build` | done, chaining the other four passes |
   | score | `single_score`, `batch_score` | done, with the scoring library core underneath them |
   | analyze | `batch_analyze` | done, all three stages |
   | frame substance | `batch_frame_substance` | done, with the detector and batch driver underneath it |
   | catalog | `catalog_sync` | done, with the Lightroom reader and the sync driver underneath it |

   Two structural departures from the Python, both worth repeating in the
   remaining families. Concurrency is a bounded **async pool over one
   connection**, not a `ThreadPoolExecutor` with a connection per worker: the time
   is spent waiting on the provider's HTTP response, so threads bought nothing,
   and the pool deletes Python's duplicated `max_workers == 1` branch — which had
   already drifted to different log messages than its parallel twin. And
   cancellation is an explicit `cancelCheck` passed down rather than the
   thread-local `cancel_scope`, which the retry backoff already honours.

   Embed added a third departure of the same kind. Python buffered eight paths
   and called `encode_images(paths, batch_size=8)` with a per-image retry loop
   for when the batch threw; here `encodeImages` is a sequential loop over
   `encodePixels`, because the ONNX session is already internally threaded and
   batching bought only peak memory. That makes the buffer an indirection around
   a one-element list and the retry a re-run of work that never shared a fate, so
   both are gone — and with them a double-count in the original, where a file
   that failed the batch *and* the retry was tallied under `encode_failed` twice.

   Stack detection contributed one more, plus a trap. Python selected the work
   list, then re-fetched the same rows in 500-key `IN (...)` chunks and
   substituted a null-dated row for any key the second query failed to return —
   but both queries read `images`, so that fallback covers a case the first query
   cannot produce; here it is one query. The trap is `date_taken` parsing:
   Python's `fromisoformat` yields a naive datetime that the handler then stamps
   as UTC, while `new Date('2024-01-15T10:00:00')` reads the same text as *local*
   time. Left alone that would move where a burst begins by the machine's offset
   from Greenwich, so `parseDateTakenUtc` parses the string by hand — and keeps
   sub-millisecond precision, because the gap is compared against `delta_ms` as a
   float.

   Scoring brought its own library core with it — `structured-output.ts`,
   `analyzer/scoring.ts`, the four `image_scores` write helpers and
   `vision/scoring-service.ts` — because `single_score` is the only thing that
   has ever called it. Two departures. Python's
   `parse_score_response_with_retry` takes *two* repair hooks, a plain `fixer`
   and an `llm_fixer`; nothing has ever passed the first except its own unit
   test, so only the LLM one is ported. And Python's single `ValidationError`
   role is split in two: `ScoreValidationError` means "worth repairing" and
   `StructuredOutputError` means "give up", which pydantic gets for free and
   here has to be explicit. Collapsing them would send half a megabyte of
   garbage to the provider for a repair attempt, since the size gate raises the
   terminal one.

   One thing the port found, worth knowing before writing any more timestamps:
   `image_scores.scored_at` is the **only** column Python writes through
   `.replace(microsecond=0)`. Every other UTC column keeps its fractional part.
   These columns are compared and sorted as text, so a millisecond field on a
   new score would order it against existing rows wrongly —
   `nowIsoUtcSeconds` exists for that one column, and `utils/datetime.ts` said
   the opposite until now.

   `batch_score` then followed the describe pass almost line for line, with one
   real difference in shape: its unit is an image × perspective **triple**, so
   the checkpoint resumes on `key|itype|slug` and activating a rubric mid-run
   changes the fingerprint — correctly, because the stored "done" set says
   nothing about a slug that was not in it. The pre-filter is the same idea as
   describe's and a harder query: "already scored" is per rubric version, so it
   matches on each slug's live `prompt_version`, and an edited perspective falls
   out of it by itself. Python computes that slug → version map twice, once in
   the pre-filter and once in the `redo_unless_model` filter; here it is built
   once. The one new piece of SQL is `excludeVoidSubstance` in
   `selectCatalogKeys` — the scoring selection drops condemned frames in the
   query, so a lens cap is not even counted as a skip. Worth noting for
   `batch_analyze`: `redo_unless_model` implies a per-item `force` and the
   result payload reports that widened flag, not the one the user sent.

   `batch_analyze` then composed those two passes, and the generalization it
   needed came out smaller than Python's. Python gives each pass four independent
   parameters — `progress_range`, `log_prefix`, `finalize`,
   `nested_analyze_checkpoint` — but only two combinations of them are ever
   passed, so here there is one optional `PassStage` argument: absent, the pass
   owns the job; present, it owns a band of the progress bar, prefixes its logs,
   writes into a sub-object of the composite's checkpoint, and returns its summary
   instead of completing the job. Both passes are otherwise unchanged, which is
   the point — the body reads the same because `log` and `progress` are two local
   closures that apply the prefix and the band.

   The composite's own content is the shared selection and the nested checkpoint.
   Selecting once is the reason the job exists: run `batch_describe` and
   `batch_score` back to back and the second selection has moved, because every
   image the first job described is now described and drops out of an
   undescribed-only window. The consequence, worth knowing before reading a
   support ticket about it, is that an already-described image is out of scope for
   *both* stages unless `force_describe` widens the selection — sharing the list
   means sharing its filter. The checkpoint holds two fingerprints and two
   processed sets under one `stage` marker, so a run interrupted while scoring
   resumes into scoring; re-entering a finished describe stage would be nearly
   free, but "nearly" is a preflight and a pre-filter over the whole selection to
   arrive at no work, so the fingerprint match skips it outright.

   The middle stage is frame-substance detection, over the images this run just
   cached, so a frame condemned during the run is dropped from its own scoring
   pass — the 48–52 band, worth four points of the bar because it is pixel
   arithmetic next to two vision calls per image. It is scoped to the selection
   and `staleOnly`, so it re-judges only images whose preview is newer than their
   verdict. Alone among the three stages its failure is not fatal: the detector
   is an optimization for the stage after it, and a job that has already paid for
   the descriptions should go on and score rather than throw them away, so it
   logs a warning and continues. Scoring then drops condemned frames with
   `filterVoidSubstanceFromScoringSelection` between the passes, where standalone
   `batch_score` does it in the selection SQL.

   Two smaller departures. `batch_analyze` was the only caller that counted
   `silent_compression_skips`, for no reason the code gives; here every describe
   pass counts it, which drops a branch and tells a standalone `batch_describe`
   the same useful thing. And the selection block that `handle_batch_describe`
   and `handle_batch_analyze` duplicate in Python is one exported
   `selectDescribeCandidates`, parameterized on the force flag they read from
   different metadata keys.

   `catalog_sync` is the smallest handler: the job owns two refusals — no catalog
   configured, and the configured one is not there — and hands everything else to
   the driver. One departure: Python installs a `cancel_scope` that nothing on
   this path consults, so cancelling a 43,000-image sync did nothing until it
   finished. Here the fetch loop checks between images and writes what it already
   has.

   `catalog_cache_build` is the last handler, and it needed no new machinery,
   only a smaller version of what `batch_analyze` already had. Python drives its
   four stages through `_CatalogCacheStageRunner`, a proxy wrapped around the
   runner that intercepts `complete_job`, remaps `update_progress` into a quarter
   of the bar and swallows checkpoints, plus a `_catalog_cache_chain` metadata
   flag the three inner handlers each branch on. Here the four passes already
   take an optional stage argument for exactly this — `PassStage` lost its
   `checkpointKey` to a new base `StageBand`, since the chain keeps no resume
   state — so there is nothing to intercept: a pass given a band maps its
   progress, prefixes its logs and returns its summary instead of completing the
   job. Cancellation needs no capture either, because the composite *is* the job
   the pass would settle.

   Two things about the chain are worth knowing. Stage 0 is the only forgiving
   one: the three after it read `library.db`, which is there and worth indexing
   whether or not today's additions arrived, so a sync that cannot open the
   catalog is a `{skipped}` or `{failed}` stage result the chain logs and steps
   over — every later stage failing is the job failing. And each stage reads
   `force` under its own name (`force_embed`, `force_stack`), so a bare `force`
   aimed at one of the standalone jobs does not silently rebuild everything.

   One latent bug not carried over. Python's chain writes no checkpoint but still
   fails the job at `_CHECKPOINT_MAX_ENTRIES`, so `catalog_cache_build` over a
   catalog of more than 100,000 images dies in the embed stage complaining about
   a checkpoint it never wrote. Here the guard sits behind the same `stage ===
   undefined` branch as the write it protects.

   The checkpoint fingerprints hash **bytes identical to
   `json.dumps(sort_keys=True)`**, pinned by golden digests generated from the
   Python function. That is load-bearing for cutover: a `batch_describe`
   checkpointed by Flask has to resume under the TS backend rather than
   re-describing 40,000 images, and `JSON.stringify` differs from Python on both
   key order and non-ASCII escaping.
5. **Library core — partly done.** The `library.db` read/write seam, providers,
   vision op, identity, imaging, the Lightroom writer and the scoring stack
   (`scoring_service`, `score_perspective`, `structured_output`) are ported.
   The **frame substance detector pair** is done, and it was the least mechanical
   port left: five statistics over an 8-bit greyscale array that numpy writes in
   five lines, thresholds that have to reproduce Python's verdicts on the same
   previews, and 43,000 verdict rows already in `library.db` that a re-judging
   run must agree with. So it is pinned the way the resampler was —
   `tests/fixtures/frame-substance/` holds ten synthetic PNGs, one per branch of
   the rules plus the tiling edges, with the numbers numpy produced for each.
   The two pixel fractions are exact rationals and compared exactly; entropy,
   Laplacian variance and tile maximum are compared to a relative tolerance,
   because numpy accumulates them in float32 and this port accumulates in
   float64. Decoding is sharp, greyscaling is `pilGreyscale` — the two disagree
   on a quarter of the pixels, which moves all five numbers.

   Two things about the detector are worth knowing before touching it. Its
   version string is a SHA-256 over `str(threshold)` for each of the seven
   thresholds, and Python's `str(20.0)` is `"20.0"` where JavaScript's is `"20"`;
   getting that wrong would rename the detector and restamp every verdict row, so
   there is a `pythonFloatStr` and a test that the hash still comes out
   `v1-847ab31c`. And the 32×32 tile grid needs a preview at least 32 pixels a
   side. numpy raises there, and the arithmetic here raises too rather than
   inventing a fallback nobody measured thresholds against — but
   `computeStatisticsFromPath` catches it, so one undersized preview is one
   `unknown` verdict instead of an aborted 43,000-image scan, which is what
   Python does with it.

   The driver lives in `jobs/handlers/frame-substance.ts` beside its handler, for
   the same reason `runDescribePass` lives in `describe.ts`: `batch_analyze`
   chains it as a stage. That keeps `imaging/frame-substance-detector.ts` free of
   any database import. The guard is unchanged and still advisory — a run that
   flags more than 250 frames, or more than three times what the previous run
   flagged over the images both runs judged, records a breach and writes its
   verdicts anyway, because a detector that suddenly condemns a tenth of the
   catalog is something the user has to see.

   **`catalog_sync` and the Lightroom reader are done.** The sync itself is one
   set difference and barely 100 lines: reading full metadata for 43,000 images
   takes minutes, reading their ids takes one query, so the expensive join runs
   only for ids `library.db` has never seen. Nothing is ever deleted — an image
   missing from the catalog is counted as `stale` and left alone, because every
   score and description hangs off its key.

   The reader gets its own connection function, `connectCatalogReadOnly`, rather
   than reusing `writer.connectCatalog`: browsing and syncing must not be able to
   mutate a file Lightroom owns. `readonly: true` is what Python's
   `file:…?mode=ro` URI asks for, `timeout: 30_000` is its 30-second busy wait,
   and the `LIGHTROOM_CATALOG_LOCKING_MODE` escape hatch (with its NORMAL
   fallback) survives because it is the documented way into a catalog on SMB/NAS
   that otherwise will not open at all. Its legacy `LIGHTRoom_*` spelling survives
   with it, even though the config loader dropped that whole family in step 0 —
   the difference is that these two are somebody's only way in.

   Two things about writing catalog rows are worth knowing. `?? default` is wrong
   throughout the reader and `|| default` is right, because Python coalesces on
   *falsiness*: a zero focal length reads as `''`, a `pick` of `-1` reads as
   `true`, and GPS at exactly zero reads as no coordinate. And every JavaScript
   number binds as SQLite REAL, so `images.id` — a TEXT column — received
   `'100.0'` where Python's int bind gives `'100'`. That one is load-bearing
   rather than cosmetic: the sync diffs on that column and parses it back as an
   integer, so `'100.0'` reads as no id and every sync re-fetches the entire
   catalog, forever. A BigInt is the only way to ask better-sqlite3 for
   `sqlite3_bind_int64`. The *other* numeric columns are deliberately left as
   doubles, because Lightroom types `isoSpeedRating`, `focalLength` and
   `aperture` as REAL and the 43,794 rows already stored read `'800.0'` and
   `'50.0'` — which is exactly what a double bind produces.

   Nothing in the library is Python-only any more. `init_database` is done (slice
   3), and `enricher` — the last name that was on this list, called only by
   `enrich-catalog` — is deliberately not ported; slice 4 below has the evidence.

   `managed_connections` is `db/library/with-db.ts` and the handlers' managed-DB
   helper. `path_utils` is `utils/path-resolve.ts`. `text_constants` is
   `constants/text.ts`. `cancel_scope` has no CLI caller at all — it is
   job-handler and retry infrastructure, and the TS jobs express the same thing
   as `runner.isCancelled`, so there is nothing left to port. `schema` is a
   standalone catalog explorer that `[project.scripts]` never exposed; it is a
   dev tool, not part of the console script.
6. **CLI — done.** Replaces the `lightroom-tagger` console script: 562 lines
   across `core/cli.py`, `cli_commands.py`, `cli_cmds_extra.py` and
   `cli_library_db.py`, seven commands, argparse and `print()`. All seven
   dispatch, over four slices.

   **Slice 1 is done: the shell, plus `search`, `export` and `stats`.** The three
   read-only commands first because they need nothing that is not already
   ported — `must_exist: true` means no bootstrap schema — so the slice is the
   entry point itself: `cli/parse.ts`, `cli/registry.ts` (the ADR-0006 list that
   `jobs/registry.ts` was modelled on), `cli/library-db.ts`, and
   `db/library/catalog-search.ts` for the `search_by_*` family. `bin.ts` is the
   executable and `main.ts` is the program, so tests drive `run()` directly
   instead of spawning a subprocess.

   Output is byte-identical to Python's, checked by diffing both CLIs against the
   same `library.db` across eight `search`/`stats` invocations, the JSON export,
   and both error paths. The one exception is the CSV export, in two cells:
   `csv.DictWriter` calls `str()` on a non-string, so Python writes
   `['sunset', 'beach']` and `False` where TS writes `["sunset","beach"]` and
   `false`. Those are Python reprs leaking into a data format rather than
   anything with a reader on the other end — the JSON export, which does have
   one, matches exactly — so the divergence is asserted in a test rather than
   emulated.

   **Slice 2 is done: `scan` and `sync`.** Both sit on drivers the `catalog_sync`
   job already uses, so the new code is two reader helpers — `getImageCount` and
   `getImageRecords` — and the two command bodies.

   `--workers` turned out to be nothing to port. Both branches of Python's
   `if len(image_ids) > 10000 and workers > 1` run the same sequential loop,
   under a comment saying SQLite connections are not thread-safe and it processes
   sequentially "for now". The flag is still accepted so an existing invocation is
   not rejected, and the help says it has no effect. `scan` does diverge in one
   way that matters: Python's `store_image` commits per record, so a first scan is
   43,000 fsyncs and an interrupted run leaves a half-synced library. TS wraps the
   batch in one `libraryWrite`, which is what `storeImagesBatch` was written for.

   Parity was checked against the real 3 GB catalog rather than a fixture:
   `scan --limit 200` into two freshly initialized databases writes 200
   byte-identical rows, `id` column included. For `sync` — which has no `--limit`
   — a 300-file subset of the real catalog, copied out through
   `immutable=1` so the live file could not be touched, syncs to 300 identical
   rows, reports the same counts, and is idempotent on a second run on both
   sides. Both `Catalog not found` paths match too.

   **Slice 3 is done: the bootstrap schema and `init`.** `init` itself is a
   print in both languages — opening a library DB with `must_exist=False` is what
   creates the schema — so the slice is `db/library/bootstrap.ts`, and it also
   retires the temporary no-schema guard slice 2 left in `scan` and `sync`.

   Python spells the schema as a base DDL script plus fifteen migration functions
   replayed on every open. Here it is **one script at `user_version` 8**, because
   the six migrations that do real work only transform data a database below 8
   can hold: remapping legacy composite keys (0 → 1), backfilling the FTS index
   from existing description rows (2 → 3), backfilling blob perspective scores
   (5 → 6), and exporting then dropping the retired Instagram tables (6 → 7, 7 →
   8). The one live database has been at 8 for a long time and nothing in TS has
   ever met another. Meeting one anyway is refused by name — `initLibraryDb`
   reads `user_version`, and a database that has an `images` table and claims to
   be older is reported rather than silently stamped current. An *empty* file is
   not that case, which matters because it is exactly what `openLibraryDb` leaves
   behind on a path that was not there.

   The schema it writes is the **production** one, not the one Python's
   `init_database` builds today, and the two differ in one place:
   `image_descriptions_fts`. `_migrate_image_descriptions_fts` was rewritten to
   create a standalone FTS5 table but is gated at `user_version` 3, so the real
   database kept the external-content form it was created with — and the two need
   opposite delete statements, which is the whole subject of
   [#303](https://github.com/ccanalesb/fixer/pull/303). A new database
   should be the shape everything is actually tested against. Also unlike Python,
   nothing is written *beside* the database: its ladder leaves a
   `library.db.pre-key-migration.bak` and an `instagram-matching-export.json` next
   to a brand-new file, both backups of nothing, and prints three lines about
   migrating data that does not exist.

   That claim is not asserted by eye. `tests/library-bootstrap.test.ts` compares
   every table, column, declared type, null-ness, default and index against the
   real 638 MB `library.db`, skipping when it is not present. It earned its keep
   immediately: `perspectives.optional` is **last** in production, because it
   arrived by `ALTER TABLE`, and column order is the key order of a `SELECT *`
   row — so the tidier position this port first gave it would have reordered JSON
   keys the API already emits. End to end, `scan --limit 150` from the real
   catalog into a path neither CLI had seen writes 150 byte-identical rows on both
   sides, each into a database at version 8 with the same eight seeded
   perspectives.

   Seeding is ported as-is, warts included. `perspectives.description` is seeded
   with the first body line under the heading, which on the three rubrics that
   carry `<!-- optional: true -->` right after their `#` heading is the marker
   itself. It is the factory default, the first thing an owner edits, and it only
   ever runs against an empty table, so there is no parity target for "fixed".

   **Slice 4 is done: `enrich-catalog`, as its cache-warming half.** Python's
   command has two modes. `--cache-only` calls `warm_vision_cache`, which is a
   real and still-useful operation: 746 catalog images have no cache row today,
   and another 51 carry the oversized sentinel, which is not a path and so never
   exists on disk — those are re-offered on every run, by both languages. The
   default mode calls `lightroom/enricher.py`, and that half is not ported. This
   is the reasoning, not an omission.

   `enrich_catalog_images` selects `images WHERE phash IS NULL`, and on the live
   database that is **all 43,794 rows** — `phash`, `exif`, `analyzed_at` and
   `description` are NULL or empty on every one of them. `store_catalog_image`
   stamps `analyzed_at` on every image it writes, so NULL across the whole column
   is proof the path has never processed a single image. What it would do on a
   first run is one LLM description call per image, written into
   `images.description`: a column only the `keyword LIKE` half of `search` reads,
   while the descriptions everything else uses live in `image_descriptions` —
   42,997 of them, written by `batch_describe` with a perspective, provider
   metadata, checkpointing and cancellation that this loop has none of.

   It also cannot converge. `hasher.compute_phash` is plain Pillow, and Pillow has
   no plugin for `.dng`, `.arw`, `.raf`, `.sr2`, `.cr2`, `.heic`, `.mp4` or
   `.mov` — 41,669 of the 43,794 files. Those yield `None`, `store_catalog_image`
   writes `phash=COALESCE(excluded.phash, images.phash)`, the row stays NULL, and
   the next run describes them again. Forever.

   So `enrich-catalog` now always warms the cache. `--cache-only` is still
   accepted and is exactly what the command does, so the invocation anyone has
   actually run is unchanged. `--catalog` is still accepted and documented as
   having no effect, which it already did: `enrich_catalog_images(db,
   catalog_path, limit)` takes the path and never reads it. This is the
   `--workers` treatment from slice 2.

   Not porting it also avoids taking an EXIF dependency for nothing.
   `extract_exif` reads eight Pillow tags into `images.exif`, and all eight —
   make, model, capture time, lens, ISO, aperture, exposure and GPS — are already
   columns the catalog sync fills from Lightroom.

   Parity is against the real catalog rather than a fixture. Run against its own
   copy of the 638 MB `library.db`, each CLI reports `Processed: 0, Skipped: 794,
   Errors: 3` — the three are `.MOV` files, which compress to nothing and land on
   the oversized sentinel — and the two leave all 43,502 `vision_cache` rows
   identical, `original_mtime` floats included, with the `images` table untouched
   on both sides.

   One structural change came with the slice. Warming the cache decodes and
   compresses, so `CommandHandler` may now return a promise and `run` awaits it.
   `withLibraryDbAsync` is the lifecycle helper for a body that awaits, and it is
   a second function rather than a wider return type because the synchronous
   version's `finally` would close the connection the moment an async body handed
   back its promise, leaving every statement after the first `await` running
   against a closed database. The other six commands are untouched and still
   synchronous. And with all seven dispatching, `CliCommand.handler` is no longer
   nullable and the "not ported to the TypeScript CLI yet" branch is gone — the
   same cleanup `JobType.handler` got in step 4.

   **One deliberate divergence in the shell.** Every global flag is also declared
   by at least one subcommand, and argparse reparses a subcommand into a fresh
   namespace and copies *all* of it back — so an absent subcommand `--db`
   overwrites the global one with `None`. `lightroom-tagger --db library.db
   search` therefore ignores the path and silently falls through to
   `config.yaml`; `--catalog`, `--limit` and `--workers` go the same way. Every
   documented invocation puts its flags after the subcommand, which is why this
   has never been hit. TS reads the subcommand's value first and the global
   second, so both positions work. Reproducing the argparse behaviour would have
   been more code than fixing it. Filed against the Python CLI, which is the one
   shipping until cutover, as
   [#305](https://github.com/ccanalesb/fixer/issues/305).
7. **Cutover — done.** `library.db.pre-ts-cutover.bak` is the backup. No CLIP
   reindex was needed: embeddings were drop-in compatible, as predicted.

   The Vite proxy needed no change at all — it already targeted 5001, and
   `config.ts` kept the `FLASK_PORT` name so an existing `.env` keeps working.
   What did need pointing were the three things that still reached into the
   Flask tree: `make dev` and `restart-backend.sh` (now `node
   --env-file-if-exists=.env --import tsx src/server.ts`, with Node port probes
   instead of Python ones, so the dev loop needs no virtualenv),
   `generate-api-types.mjs` (now `backend/scripts/export-openapi.ts`), and CI.

   **Switching the OpenAPI source found two contract differences that had been
   hiding behind spectree.** Neither is a wire change; both reached the
   committed `api.gen.ts`. spectree namespaced every component per blueprint —
   `Stats.36cf89b`, `IdentityBestPhotosResponse.00d7522.IdentityBestPhotoItem` —
   and the frontend's alias layer in `src/types/` was keyed on those hashes; the
   TS document names each schema once, and nested ones flatten to their leaf.
   And pydantic wrote `"default": null` for `model: str | None = None`, which
   `openapi-typescript` promotes to a **required** property, so the frontend
   believed `ProviderDefaultsEntry.model` was always present. The route returns
   `jsonify(registry.defaults)` — the raw config dict — so it never was unless
   `providers.json` set it, and two `setModelId((m) => m ?? d.model)` call sites
   were reading `undefined` through a type that said they could not.

   Cutover was verified against a copy of the real 638 MB `library.db` before
   anything was deleted: 25 collection routes and 8 per-image routes all answer
   200, the thumbnail route serves a 107 KB JPEG out of the RAW cache, and the
   catalog parity suite ran 936/937 — the single failure being `/api/stats`
   echoing back the temp `db_path` the fixture was not captured with.

   **CI drops Python entirely.** With it goes `contract-tests.txt`, the
   hand-maintained pytest subset: it existed because CI could not afford all 438
   backend tests, and vitest runs all 891 in four seconds. The two Flask
   baselines went too — `flask-openapi.json` and `flask-catalog-parity.json`,
   both of which said "delete at cutover" — and with them
   `openapi-contract.test.ts` and `catalog-parity.test.ts`. There is no longer an
   external contract to hold to; TS is the contract, and `git diff --exit-code
   src/types/api.gen.ts` is the gate.

   Four Python guardrail tests died with the Flask tree they parsed. Two are now
   structural — `JOB_TYPES` is the only thing typed to hold a handler,
   `withLibraryDb` the only export handing out a connection — and two, the
   transitions seam and the "no hand-written response interfaces in `api.ts`"
   rule, are conventions with nothing behind them. Filed as
   [#306](https://github.com/ccanalesb/fixer/issues/306).

   **`lightroom_tagger/` was left on disk for one step, then deleted.** Of its 79
   modules, ten were unported, and seven of those were safe to lose: `schema.py`
   and `schema_explorer.py` are byte-identical copies of a `.lrcat` explorer
   nothing imports, `cleanup_wrong_links.py` is a spent one-off repair,
   `extract_exif` was only ever called by the enricher, `cancel_scope.py` was
   Flask-only, and `enricher.py` is the `enrich-catalog` half slice 4 already
   argued against. The other three were the `library.db` **migration ladder**,
   which is what the package was initially kept for: `bootstrap.ts` creates the
   schema at version 8 and refuses anything below it, and two of the owner's own
   backups were not at 8 (`pre-drop-228.bak` v6, `pre-key-migration.bak` v0).

   That reprieve did not survive review. A pre-v8 backup is only useful as a
   rollback target, and rolling back to a schema two versions behind the live
   catalog is a downgrade rather than a recovery; the ladder is also still in git
   history, so a database that genuinely needs upgrading can have it back in one
   checkout. Both stale backups were deleted and the package with them.

   What was actually load-bearing was `core/providers.json` and
   `core/providers.example.json`, read at runtime by `config.ts` and
   `providers/registry.ts`. Both moved to `apps/visualizer/backend/`.

   Deleted rather than fixed: `scripts/verify_readme.py`, whose CLI oracle is the
   Python command registry and whose clean-clone smoke boots `backend/app.py`; the
   three perspective scripts (`sync_perspectives.py`, `seed_yt_perspectives.py`,
   `merge_perspectives_6_to_4.py`), covered by `seedPerspectivesFromPromptsDir`
   and the per-slug reset route; `check_core_file_sizes.sh`, which capped a tree
   that no longer exists and cannot be repointed at `backend/src/` without
   refactoring the ten files already over 400 lines (folded into
   [#306](https://github.com/ccanalesb/fixer/issues/306)); and
   `tests/fixtures/frame-substance/regenerate-fixtures.py`, which imported the
   deleted numpy detector. Its manifest stays frozen on purpose — it is the
   independent second opinion the TypeScript detector is measured against.
   `ollama_autopilot.py` is a pure HTTP client and survives untouched, so Python
   is now a dependency of one optional tool rather than the repo.

   `.sandcastle` was migrated with the rest: node:24 with the backend deps
   pre-baked, `npm test` in place of pytest, and contract guidance in terms of Zod
   schemas and `createRoute`. `.dockerignore` still whitelisted `pyproject.toml`
   and `uv.lock`, which would have broken the image build.

   **`backend-ts/` is now `backend/`.** The suffix only ever existed so the port
   could be built beside the Flask tree; with that tree gone it named the only
   backend there is. The old path still held 54 orphaned `.pyc` files, which went
   with it. Anything in this plan written before this point says `backend-ts/`
   where the tree is now `backend/`.

## Risks

1. ~~**Everything image-derived depends on the resampler port.**~~ **Retired.** The
   port is done and pinned: CLIP reproduces the stored corpus to `1 - cos` = 3.52e-12
   with identical neighbour rankings, and phash matches 12/12 exactly. The residual
   risk is regression, which the golden-file tests and the two gated parity tests now
   cover. Still back up `library.db` before the first write-path run.
2. **RAW decode cost.** Measured 872 ms/image over a 60-image soak, so a full
   vision-cache rebuild of ~41,000 files is ~10 hours single-threaded (~2.5 h over 4
   workers). `halfSize` being ignored for DNG makes 17,590 files the dominant share.
   The existing cache is intact (43,451/43,451 files present on disk), so this only
   bites on new imports or a forced rebuild — but budget for it.
3. **`libraw-wasm` adapter is ours to maintain.** A browser-targeted package driven
   from Node through three shims; pin the version and cover it with a test that
   decodes one fixture per format.
4. **Tests are the bulk of the work.** ~12,455 LOC of backend tests plus the library's
   colocated tests must be re-expressed in Vitest. The contract tests in
   `tests/contract-tests.txt` gate CI and must keep gating it.
5. **CI installs Python today.** `.github/workflows/ci.yml` sets up Python and pip-installs
   the backend. A GitHub App cannot push `.github/workflows/**`, so the updated
   workflow must be handed to a maintainer to install by hand — same constraint that
   produced `.sandcastle/ci-drift-gate.yml`.
6. **Lightroom catalog writes.** `utils/lr_catalog_write.py` and
   `lightroom_tagger/lightroom/writer.py` mutate a live `.lrcat`. Port last, behind the
   existing write-serialization discipline.
7. **A faithful port inherits the original's latent bugs, and the new tests find
   them.** Porting `store_image_description` line by line carried over an FTS5
   defect: on the external-content `image_descriptions_fts` that every real catalog
   has, `DELETE ... WHERE rowid = ?` removes the wrong terms, so a regenerated
   description stays searchable under its old text — silently, with
   `integrity-check` still passing. It surfaced only because the TS fixture builds
   the table in the production shape, while every Python test builds the standalone
   shape `init_database` produces, where the same statement is correct. Fixed on
   both sides ([#303](https://github.com/ccanalesb/fixer/pull/303) for
   Python).

   `batch_embed_image` carried a smaller one of the same kind, not worth a Python
   PR but worth recording: when a file failed both the batch encode and the
   per-image retry, `encode_failed` was incremented twice, once by `record_skip`
   and once by the `vec is None` branch. The TS port has no fallback loop, so it
   cannot reproduce it.

   `catalog_cache_build` carried a third: its stages write no checkpoint but keep
   the 100,000-entry guard on one, so the chain fails on a catalog large enough
   to trip a limit that protects nothing. Left behind, along with the reason, in
   step 4 above.

   The frame substance detector carried a fourth. `compute_statistics_from_path`
   catches decode failures but not the reshape, so a cached preview under 32
   pixels a side raises a `ValueError` out of the loop and fails the whole
   catalog scan. Nothing in the current cache is that small, which is why nobody
   has hit it; the TS port catches it into the `unknown` verdict that every other
   unreadable preview already gets.

   The Lightroom reader carried a fifth, and this one costs the user a feature.
   `_get_keywords_for_image` matches `AgLibraryKeywordImage.image` against the
   `AgLibraryFile.id_local` its caller was given, but that column references
   `Adobe_images.id_local` — the exact mix-up `writer.py` documents at length.
   The two id spaces do not overlap in a real catalog, so it returns nothing:
   `keywords` is `[]` on all 43,794 rows in `library.db`, and the `keywords LIKE`
   half of `search_by_keyword` has never matched anything.

   Ported as-is, with a test pinning the empty result, because the one-line join
   fix is the smaller half of the repair. The sync is additions-only, so fixing
   the join populates keywords for newly imported photos and leaves the existing
   43,794 empty — keyword search that works for last week's import and silently
   fails for the whole catalog is a worse bug than one that is uniformly silent.
   Repairing it properly means a backfill pass, which is its own slice and is
   filed as [#304](https://github.com/ccanalesb/fixer/issues/304).

   Two working rules for the remaining slices. Build fixtures from the *production*
   schema, not from what `init_database` happens to create — the two have already
   diverged, and migrations gated on `user_version` mean an existing catalog never
   converges. And when a ported test fails, establish whether Python actually
   passes the same case before assuming the port is wrong; here it was the original
   that was broken.

   The first of those rules now has teeth. `tests/helpers/library-fixture.ts` used
   to declare the schema by hand and had drifted from what it claimed to mirror:
   **no named indexes at all**, `image_scores.rationale` and `model_used`
   nullable where production has them `NOT NULL DEFAULT ''`, and no
   `uq_image_scores_versioned` — the unique constraint every score upsert
   conflicts on. It now calls `createLibrarySchema`, the same DDL `init` writes,
   which made the drift impossible and immediately failed 47 tests that had been
   seeding rows the real database rejects: `score: 0` alongside `not_attempted`
   (all 24,881 real not-attempted rows carry a score of 1–5), and pairs of rows
   differing only by `is_current` (all 1,507 real superseded rows differ by
   `prompt_version`, which is what the unique constraint is on). Every one was the
   fixture permitting a row that cannot exist, so the tests were fixed rather than
   the schema loosened.

---
Created using Anthropic Claude. This line should stay on internal versions until a
human has reviewed and verified the content.
