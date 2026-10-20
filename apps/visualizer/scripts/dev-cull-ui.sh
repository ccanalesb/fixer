#!/usr/bin/env bash
# UI review for cull screens (#340) — temp library + config only; never the real library.db or Lightroom catalog.
#
# From repo root:
#   bash apps/visualizer/scripts/dev-cull-ui.sh
#
# Runs in a subshell so LIBRARY_DB / LT_CONFIG_YAML are not exported to your shell.
(
  set -euo pipefail
  ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"; cd "$ROOT" && make dev-down 2>/dev/null || true' EXIT INT TERM

  export CULL_UI_TMP="$TMP"
  export LIBRARY_DB="$TMP/library.db"
  export LT_CONFIG_YAML="$TMP/config.yaml"
  cat > "$LT_CONFIG_YAML" <<EOF
library_db: $LIBRARY_DB
vision_cache_dir: $TMP/vision
laya_models_dir: $TMP/models
catalog_path: $TMP/stub.lrcat
EOF
  cd "$ROOT/apps/visualizer/backend"
  npx tsx ../scripts/seed-cull-ui-review.ts
  echo "LIBRARY_DB=$LIBRARY_DB"
  echo "LT_CONFIG_YAML=$LT_CONFIG_YAML"
  cd "$ROOT"
  make dev
)
