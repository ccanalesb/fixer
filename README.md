# Fixer

**Many eyes. Your style. Your picks.**

AI culls your shoot, reads every frame through the perspectives you choose, learns your style, and writes your picks back to your catalog.

Fixer is for Adobe Lightroom Classic: it reads your `.lrcat` catalog, builds a local library, runs vision models and culling, and can write stars and reject flags back into your catalog when Lightroom Classic is closed.

## Prerequisites

1. **Adobe Lightroom Classic catalog** — a `.lrcat` file path. **Close Lightroom Classic** before scanning; an open catalog can cause `database is locked`.
2. **Vision provider** — local [Ollama](https://ollama.ai) (default model `gemma3:27b`: `ollama pull gemma3:27b`) or a cloud provider configured in `providers.json`.
3. **Backend port 5001** — the API listens on **5001**, not 5000. macOS AirPlay Receiver occupies 5000 and returns empty 200/403 responses that look like a broken backend. Vite proxies `/api` to 5001.

## Installation

Node 24 or newer. The backend and CLI are TypeScript; nothing runs Python at run time.

```bash
cd apps/visualizer/backend && npm install && npm link && cd ../../..
cd apps/visualizer/frontend && npm install --legacy-peer-deps && cd ../../..
```

`npm link` puts `fixer` on your PATH. Without it, run any of the
commands below as `npm run cli -- <command>` from `apps/visualizer/backend`.

### Culling models

Culling's stages can run models in this app, locally through ONNX
([ADR-0020](docs/adr/0020-laya-in-node-through-onnx.md)). A model is added in
Processing → Settings → Culling models → "Add a model", from a folder in Hugging
Face format or a Hugging Face id; a job converts it once, with
[uv](https://docs.astral.sh/uv/), into the git-ignored `models/` (about 800 MB for
the first model, 430 MB for one that shares its vision tower). The same script by
hand:

```bash
uv run scripts/app-models/export_onnx.py owner/model --name my-model
uv run scripts/app-models/export_onnx.py /path/to/checkpoint --name my-fine-tune
fixer cull-check
```

Today only SmolVLM (Idefics3) models with a decision head convert.

Without a revision (`id@revision`), the commit recorded is the last one that
changed the model's files. Nothing is uploaded, and no model file belongs in git.

Culling itself is the job `batch_cull_photos_before_scoring` (whole catalog, or
`image_keys`); until it has a screen, start it through the jobs API:

```bash
curl -X POST localhost:5001/api/jobs/ -H 'Content-Type: application/json' \
  -d '{"type": "batch_cull_photos_before_scoring"}'
```

## Quick Start (CLI)

```bash
# Initialize library.db (scan also creates it if missing)
fixer init --db library.db

# Index catalog metadata into library.db
fixer scan --catalog "/path/to/Catalog.lrcat" --db library.db

# Search by Lightroom Classic metadata or AI descriptions (FTS5)
fixer search --keyword "landscape" --db library.db

# Export or inspect
fixer export --db library.db --output export.json
fixer stats --db library.db
```

Incremental catalog updates (additions only):

```bash
fixer sync --catalog "/path/to/Catalog.lrcat" --db library.db
```

## Web UI

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
app_models_dir: "./models"
```

All keys above are fields on `LibraryConfig` in `apps/visualizer/backend/src/config.ts`. Unknown keys in an existing `config.yaml` are ignored with a warning.

Environment overrides (common): `VISION_MODEL`, `LIGHTRoom_CATALOG`, `LIGHTRoom_DB`, `OLLAMA_HOST`.

**NAS catalogs:** close Lightroom Classic if you see `database is locked`. See [docs/CATALOG_READ_WRITE.md](docs/CATALOG_READ_WRITE.md) and [docs/STORAGE_MOUNT_REQUIREMENTS.md](docs/STORAGE_MOUNT_REQUIREMENTS.md).

## License and attribution

Fixer is licensed under the [ISC License](LICENSE).

Adobe and Lightroom Classic are either registered trademarks or trademarks of Adobe in the United States and/or other countries.

Fixer is not affiliated with or endorsed by Adobe.

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
