# Lightroom catalog (.lrcat) read vs write

## Read paths (do not write)

By default, `sqlite3` URI parameter `mode=ro` is used when opening the catalog for reads.

- Catalog reads and scans use `apps/visualizer/backend/src/lightroom/reader.ts` (`connectCatalogReadOnly`).
- `src/lightroom/catalog-sync.ts` opens the catalog only through the reader.
- The `catalog` CLI commands (`src/cli/commands/catalog.ts`) go through the same reader for scan workflows.

Keyword writeback uses a **separate** SQLite connection from the read-only reader.

## Write paths

- `apps/visualizer/backend/src/lightroom/writer.ts` (`connectCatalog`) — keyword writeback and cull write-back (pick, rating, `lrt-auto-*` keywords).
- `src/lightroom/writeback.ts` — reconciles cull verdicts to stars/reject with guards and `lr_writeback_state` in `library.db`.
- `src/utils/lr-catalog-write.ts` — availability check for catalog writes (lock check); the write-back uses it.
