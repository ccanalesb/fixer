#!/usr/bin/env bash
# UI review for cull screens (#340) — temp library + config only; never the real library.db or Lightroom catalog.
#
# From repo root:
#   bash apps/visualizer/scripts/dev-cull-ui.sh
#
# Exports LIBRARY_DB and LT_CONFIG_YAML under mktemp, seeds via seed-cull-ui-review.ts, then `make dev`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP="$(mktemp -d)"
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
