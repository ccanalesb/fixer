# Lightroom Tagger

Index a Lightroom catalog into a local SQLite database, generate AI descriptions and perspective scores, and browse your library in a web UI.

## Prerequisites

1. **Lightroom catalog** — a `.lrcat` file path. **Close Lightroom Classic** before scanning; an open catalog can cause `database is locked`.
2. **Vision provider** — local [Ollama](https://ollama.ai) (default model `gemma3:27b`: `ollama pull gemma3:27b`) or a cloud provider configured in `providers.json`.
3. **Backend port 5001** — the visualizer API listens on **5001**, not 5000. macOS AirPlay Receiver occupies 5000 and returns empty 200/403 responses that look like a broken backend. Vite proxies `/api` to 5001.

## Installation

Node 24 or newer. The backend and CLI are TypeScript; nothing runs Python at run time.

```bash
cd apps/visualizer/backend && npm install && npm link && cd ../../..
cd apps/visualizer/frontend && npm install --legacy-peer-deps && cd ../../..
```

`npm link` puts `lightroom-tagger` on your PATH. Without it, run any of the
commands below as `npm run cli -- <command>` from `apps/visualizer/backend`.

### Cull models (Laya)

The cull before scoring runs Laya base and Laya new locally through ONNX
([ADR-0020](docs/adr/0020-laya-in-node-through-onnx.md)). Their files are
converted on your machine once, with [uv](https://docs.astral.sh/uv/), into the
git-ignored `models/` (about 1.25 GB):

```bash
uv run scripts/laya/export_onnx.py --laya-new /path/to/laya-new-checkpoint
lightroom-tagger cull-check
```

The script downloads Laya base from Hugging Face at a fixed revision. Without
`--laya-new` the Score forecast stage stays off. Nothing is uploaded, and no model
file belongs in git.

The cull itself is the job `batch_cull_photos_before_scoring` (whole catalog, or
`image_keys`); until it has a screen, start it through the jobs API:

```bash
curl -X POST localhost:5001/api/jobs/ -H 'Content-Type: application/json' \
  -d '{"type": "batch_cull_photos_before_scoring"}'
```

The research runs can be loaded as the first stored answers, so the job only
asks Laya what they left out. Back up `library.db` first; `--dry-run` writes
nothing, and the import can be run again as the research files grow:

```bash
lightroom-tagger cull-import --dry-run \
  --laya-new ~/lightroom-research/bench/distill/outputs/laya_new_catalog.jsonl \
  --recipe ~/lightroom-research/bench/laya-gate/laya_cull_catalog_all.jsonl
```

## Quick Start (CLI)

```bash
# Initialize library.db (scan also creates it if missing)
lightroom-tagger init --db library.db

# Index catalog metadata into library.db
lightroom-tagger scan --catalog "/path/to/Catalog.lrcat" --db library.db

# Search by Lightroom metadata or AI descriptions (FTS5)
lightroom-tagger search --keyword "landscape" --db library.db

# Export or inspect
lightroom-tagger export --db library.db --output export.json
lightroom-tagger stats --db library.db
```

Incremental catalog updates (additions only):

```bash
lightroom-tagger sync --catalog "/path/to/Catalog.lrcat" --db library.db
```

## Visualizer (Web UI)

```bash
cp apps/visualizer/backend/.env.example apps/visualizer/backend/.env
# Edit .env: set LIBRARY_DB to the absolute path of library.db

make dev
# Open http://localhost:5173
```

Stop with `make dev-down`.

### Pages

| Page | URL | Purpose |
|------|-----|---------|
| Insights | `/` | Overview and stats |
| Images | `/images` | Browse, filter (including AI description search), catalog similarity |
| Identity | `/identity` | Style fingerprint and posting advisor |
| Processing | `/processing` | Describe, score, embed, stack detection, catalog similarity jobs |

Legacy URLs (`/search`, `/analytics`, `/instagram`, `/matching`, `/jobs`) redirect to the pages above.

### Typical workflow

1. **Scan** (CLI) or **Sync catalog** (Processing) — populate `library.db`.
2. **Embed catalog images** — CLIP embeddings power **catalog similarity** (`clip_similarity`).
3. **Stack detection** — group burst shots; the representative frame is described and scored.
4. **Batch describe / score** — AI descriptions and perspective scores via Ollama or configured providers.
5. **Catalog similarity** — review similar-image groups.
6. **Images** — browse, filter by description, inspect scores; mark posted (`instagram_posted`) in the detail modal.
7. **Identity** — Mirror (style fingerprint) and Advisor (what to post next).

## Configuration

Edit `config.yaml` at the repo root (or pass `--config`):

```yaml
catalog_path: "/path/to/Catalog.lrcat"
db_path: "./library.db"
mount_point: "/mnt/nas"
workers: 4
vision_model: "gemma3:27b"
ollama_host: "http://localhost:11434"
stack_burst_delta_ms: 2000
vision_cache_enabled: true
laya_models_dir: "./models"
```

All keys above are fields on `LibraryConfig` in `apps/visualizer/backend/src/config.ts`. Unknown keys in an existing `config.yaml` are ignored with a warning.

Environment overrides (common): `VISION_MODEL`, `LIGHTRoom_CATALOG`, `LIGHTRoom_DB`, `OLLAMA_HOST`.

**NAS catalogs:** close Lightroom Classic if you see `database is locked`. See [docs/CATALOG_READ_WRITE.md](docs/CATALOG_READ_WRITE.md) and [docs/STORAGE_MOUNT_REQUIREMENTS.md](docs/STORAGE_MOUNT_REQUIREMENTS.md).

## Further reading

| Doc | Audience |
|-----|----------|
| [CONTEXT-MAP.md](CONTEXT-MAP.md) | Where the context lives |
| [apps/visualizer/CONTEXT.md](apps/visualizer/CONTEXT.md) | HTTP API, CLI, jobs, `library.db`, vision pipeline, React SPA |
| [docs/architecture.md](docs/architecture.md) | Backend layer boundaries and import rules |
| [AGENTS.md](AGENTS.md) | Agent workflow and issue tracker |
| [docs/parked/](docs/parked/) | Retired capabilities (Instagram matching, etc.) |

## Development

```bash
# Backend tests
cd apps/visualizer/backend && npm test

# Frontend tests
cd apps/visualizer/frontend && npm test -- --run

# Everything the CI drift gate runs
bash apps/visualizer/scripts/verify-contract.sh
```
