# ADR-0023: One library per catalog, found by the catalog it records

**Status:** Accepted  
**Date:** 2026-11-05

## Context

Each installation names one catalog in `config.yaml`, but until now every install
kept a single `library.db` and vision cache no matter which `.lrcat` was
configured. Changing `catalog_path` rewrote config only; rows from the previous
catalog stayed in the same database, which forced **catalog drift** warnings and
made a second catalog kind (a folder of photos) impossible without mixing work.

The folder-catalog initiative needs an isolated library per catalog, a stable
way to reopen the library for a catalog the user chose before, and an upgrade
path that moves existing installs without losing descriptions, scores, or cache
files.

## Decision

1. **Layout:** `<data folder>/catalogs/<name>/` holds one catalog's
   `library.db` and `vision-cache/`. `<name>` is the catalog basename plus a
   short random suffix; it is only a label.
2. **Identity in the library:** each library records the catalog's absolute path
   and kind (`lightroom` or `folder`) in `library_meta`, not in a side index
   file.
3. **Resolution:** at startup and whenever `catalog_path` changes, the app scans
   `catalogs/*/library.db` and opens the library whose recorded path matches
   `catalog_path` after `~` expansion. Two libraries claiming the same path are
   both refused; API routes return an error naming both folders.
4. **Pin:** `LIBRARY_DB` (and the CLI's `--db`) opens one file and bypasses the
   lookup. While pinned, changing to a different catalog is refused; the same
   catalog at a new path is allowed and updates `library_meta`.
5. **Upgrade:** when `catalogs/` has no library yet, a legacy `library.db` (from
   `db_path` or the data-folder default) is checkpointed, moved into
   `catalogs/<name>/`, the vision cache is moved to `vision-cache/` with
   `compressed_path` prefixes rewritten, the catalog from `config.yaml` is
   recorded, and `db_path` / `vision_cache_dir` are removed from config.
6. **Retire catalog drift:** `synced_catalog_path`, `needs_catalog_sync`, and
   the Settings drift copy go away. Catalog sync no longer writes a separate
   synced path key.
7. **Per install, unchanged:** `visualizer.db`, `providers.json`, culling
   models, and `models/` stay shared. Write-back state stays in each catalog's
   library.

## Consequences

- Switching catalogs opens a different file under `catalogs/` instead of
  reusing one database; slices that implement the Settings modal and folder sync
  build on this layout.
- Tests and scripts must set `catalog_path` (or `LIBRARY_DB`) rather than
  `db_path` when they need a library location.
- Legacy `db_path` / `vision_cache_dir` keys are still read only for the one-time
  upgrade, then dropped from config.

## Alternatives considered

- **Keep one `library.db` and tag rows by catalog** — rejected; mixed keys and
  drift were the problem being removed.
- **A central index file mapping catalog → library** — rejected; the PRD requires
  finding the library by scanning `library_meta` only.
