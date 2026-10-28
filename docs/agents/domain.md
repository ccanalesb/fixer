# Domain Docs

This repo has a **single** context file. The two-context layout ended with the
TypeScript cutover, which folded the Python library into the backend.

## Contexts

| Context | File | Covers |
|---|---|---|
| Visualizer product | `apps/visualizer/CONTEXT.md` | HTTP API, CLI, job queue, WebSocket, React UI, vision, providers, ProviderRegistry, Lightroom catalog, matching |

## Cross-cutting decisions

Architectural decision records live in `docs/adr/`:

| ADR | Decision |
|---|---|
| [ADR-0001](../../docs/adr/0001-split-analyzer.md) | Split `analyzer.py` into `image_prep`, `image_inspect`, `vision_compare`, `description` |
| [ADR-0002](../../docs/adr/0002-split-database.md) | Split `database.py` into focused store modules with `database.py` as permanent re-export shim |
| [ADR-0003](../../docs/adr/0003-pipeline-layer.md) | Pipeline layer in `lightroom_tagger/core/pipelines.py`; handlers become thin adapters |
| [ADR-0004](../../docs/adr/0004-shared-exceptions.md) | Shared `lightroom_tagger/core/exceptions/` package as single entry point for all error types |
| [ADR-0005](../../docs/adr/0005-delete-dead-top-level-modules.md) | Delete the dead top-level module island; canonical read/write/CLI surfaces only |
| [ADR-0006](../../docs/adr/0006-cli-command-registry.md) | CLI dispatch via an explicit `Command` registry |
| [ADR-0007](../../docs/adr/0007-provider-model-resolution-ladder.md) | One `resolve_model` precedence ladder for provider/model selection |
| [ADR-0008](../../docs/adr/0008-library-db-reads-through-core-database.md) | All library-DB reads go through typed helpers in `core.database` |
| [ADR-0009](../../docs/adr/0009-one-dispatcher-for-provider-calls.md) | One dispatcher for all provider/LLM calls; `VisionComparator` facade + `ErrorPolicy` |
| [ADR-0010](../../docs/adr/0010-job-type-registry-and-transitions-seam.md) | Job-type registry + status-transition seam for visualizer jobs |
| [ADR-0011](../../docs/adr/0011-managed-db-and-catalog-lifecycle-seam.md) | `managed_library_db` / `managed_catalog` lifecycle context managers |
| [ADR-0012](../../docs/adr/0012-excusable-perspectives.md) | Excusable (not-attempted) perspectives (renumbered from a duplicate 0005) |
| [ADR-0013](../../docs/adr/0013-backend-authoritative-openapi-contract-seam.md) | Backend-authoritative OpenAPI contract seam; generated frontend types, drift gated in CI |
| [ADR-0014](../../docs/adr/0014-one-vision-op-and-persist-engine.md) | One vision-op and persist engine |
| ~~ADR-0015~~ | `search_catalog` front door — **deleted**; chat/NL/semantic search removed ([#223](https://github.com/ccanalesb/fixer/issues/223)). The number is retired, not reused. |
| [ADR-0016](../../docs/adr/0016-description-scoring-split-image-scores-ssot.md) | Description and scoring are separate pipelines; `image_scores` is the single source of truth for perspective scores |
| [ADR-0017](../../docs/adr/0017-retire-equal-weighted-mean-identity-ranking-key.md) | Equal-weighted mean retired as the identity ranking key; within-perspective percentile replaces it |

## Usage by skills

- `diagnose`, `tdd`, `improve-codebase-architecture` — read `apps/visualizer/CONTEXT.md` before changing anything under `apps/`
- Pair it with `docs/architecture.md` for the backend's layer boundaries and import rules
- Keep `apps/visualizer/CONTEXT.md` current as the domain language evolves
