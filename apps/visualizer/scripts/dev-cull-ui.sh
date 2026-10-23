#!/usr/bin/env bash
# UI review for culling screens — isolated temp data only; never the user's
# library.db, jobs DB, thumbnails, providers, or vision cache.
#
# From repo root, with a folder of .jpg photos to review (copied, never changed):
#   CULL_UI_IMAGES=/path/to/jpgs bash apps/visualizer/scripts/dev-cull-ui.sh
#
# Runs in a subshell so nothing is exported to your interactive shell.
# Pre-set env vars win over backend/.env (node --env-file-if-exists does not overwrite).
(
  set -euo pipefail
  : "${CULL_UI_IMAGES:?set CULL_UI_IMAGES to a folder of .jpg photos}"
  ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"; cd "$ROOT" && make dev-down 2>/dev/null || true' EXIT INT TERM

  mkdir -p "$TMP/vision" "$TMP/models" "$TMP/thumbnails"

  export CULL_UI_TMP="$TMP"
  export LIBRARY_DB="$TMP/library.db"
  export LT_CONFIG_YAML="$TMP/config.yaml"
  export DATABASE_PATH="$TMP/visualizer.db"
  export THUMBNAIL_DIR="$TMP/thumbnails"
  export LT_PROVIDERS_JSON="$TMP/providers.json"
  # Blank vision overrides so a real .env cannot steer describe/score at a live model.
  export VISION_MODEL=""
  export DESCRIPTION_VISION_MODEL=""
  # Empty exports beat node --env-file-if-exists (unset lets .env repopulate keys).
  export NVIDIA_NIM_API_KEY=""
  export OPENROUTER_API_KEY=""
  export OPENCODE_GO_API_KEY=""
  export GITHUB_TOKEN=""
  export OLLAMA_HOST=""

  cat > "$LT_CONFIG_YAML" <<EOF
library_db: $LIBRARY_DB
vision_cache_dir: $TMP/vision
vision_cache_enabled: false
app_models_dir: $TMP/models
catalog_path: $TMP/review.lrcat
EOF

  cat > "$LT_PROVIDERS_JSON" <<'EOF'
{
  "retry_defaults": { "max_retries": 0, "backoff_seconds": [] },
  "providers": {},
  "fallback_order": []
}
EOF

  cd "$ROOT/apps/visualizer/backend"
  npx tsx ../scripts/seed-cull-ui-review.ts
  echo "LIBRARY_DB=$LIBRARY_DB"
  echo "DATABASE_PATH=$DATABASE_PATH"
  echo "LT_PROVIDERS_JSON=$LT_PROVIDERS_JSON"
  cd "$ROOT"
  make dev
)
