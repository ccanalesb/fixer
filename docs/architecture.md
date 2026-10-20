# Module boundaries and layering

This document is the authoritative boundary policy for `apps/visualizer/backend/src/`.

## Layers

```mermaid
flowchart TB
    handlers --> services
    services --> database
```

Route groups and job handlers live above the library: they translate HTTP and job
metadata into calls into the service modules. Nothing below the handler layer knows
about `Context`, request parsing or response shaping.

## What belongs in each layer

- **HTTP routes and job handlers** (`api/`, `jobs/`) — routing, request parsing, response shaping, progress callbacks into the job runner, and thin delegation to the services.
- **Services** (`analyzer/`, `clip/`, `identity/`, `imaging/`, `laya/`, `lightroom/`, `providers/`, `vision/`) — domain logic: analysis, scoring, identity, embeddings, RAW decode, the cull's local models, catalog reading and the provider stack.
- **Database layer** (`db/library/`, `db/jobs/`) — persistence: SQL, schema, and the catalog/library write paths (see [ADR-0002](adr/0002-split-database.md)). `db/library/bootstrap.ts` owns the `library.db` schema.
- **Shared utilities** (`utils/`, `constants/`) — errors, datetime, path resolution and response helpers used across layers.

## Import rules

1. Service and database modules **must not** import from `api/` or `jobs/`.
2. Route modules under `api/` may import services and `db/`, but **must not** import sibling route modules — for example `api/identity.ts` must not import `api/images/catalog.ts`, and `api/scores.ts` must not import `api/perspectives.ts`. Coupling between API areas goes through `api/route-helpers.ts`, `api/schemas/` or downward into the service layer. `api/openapi.ts` and `api/schemas/` are exempt — every route group is expected to import them.
3. `cli/` sits alongside `api/` as a second entry point over the same services; it must not import from `api/` or `jobs/`.

## History

Until the TypeScript cutover this policy governed a Python package at
`lightroom_tagger/` and a Flask backend at this same `apps/visualizer/backend/`
path, with the layer split enforced by `test_architecture.py` and a 400-line cap
on `lightroom_tagger/core/` (`make check-core-sizes`). Both trees are gone; the
replacement was built alongside them as `backend-ts/` and took over the name once
the Flask tree was deleted. The rules above are the same boundaries restated for
it.

Neither enforcement mechanism survived the port. The import rules above are a
convention today; ten files under `src/` are already over the old 400-line cap,
so reinstating it needs refactoring first. Tracked in
[#306](https://github.com/ccanalesb/lightroom-tagger/issues/306).

The Python package took the `library.db` migration ladder with it, so
`db/library/bootstrap.ts` is now the only schema authority: it creates version 8
and refuses anything below. Backups predating version 8 are no longer openable by
anything in this repo — recover the ladder from git history if one ever needs
upgrading. See [docs/plans/ts-backend-migration.md](plans/ts-backend-migration.md).
