#!/usr/bin/env bash
# Build backend + frontend and copy runtime resources for the packaged app.
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$DESKTOP/../.." && pwd)"
STAGE="$DESKTOP/staged-resources"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"

rm -rf "$STAGE"
mkdir -p "$STAGE"

echo "Building backend…"
(
  cd "$REPO/apps/visualizer/backend"
  npm ci
  npm run build
)

echo "Building frontend…"
(
  cd "$REPO/apps/visualizer/frontend"
  npm ci --legacy-peer-deps
  npm run build
)

echo "Installing production backend deps in stage…"
cp -R "$REPO/apps/visualizer/backend/dist" "$STAGE/dist"
cp "$REPO/apps/visualizer/backend/package.json" "$STAGE/package.json"
cp "$REPO/apps/visualizer/backend/package-lock.json" "$STAGE/package-lock.json"
(
  cd "$STAGE"
  ONNXRUNTIME_NODE_INSTALL=skip npm ci
)

PRUNE_ARGS=(--root "$STAGE")
if [[ -n "${PRUNE_PLATFORM:-}" ]]; then
  PRUNE_ARGS+=(--platform "$PRUNE_PLATFORM")
fi
if [[ -n "${PRUNE_ARCH:-}" ]]; then
  PRUNE_ARGS+=(--arch "$PRUNE_ARCH")
fi
node "$SCRIPTS/prune-staged-backend.mjs" "${PRUNE_ARGS[@]}"

echo "Copying frontend…"
mkdir -p "$STAGE/frontend"
cp -R "$REPO/apps/visualizer/frontend/dist/." "$STAGE/frontend/"

echo "Copying prompts and conversion assets…"
cp -R "$REPO/prompts" "$STAGE/prompts"
mkdir -p "$STAGE/scripts"
cp -R "$REPO/scripts/app-models" "$STAGE/scripts/app-models"
cp "$REPO/apps/visualizer/backend/providers.example.json" "$STAGE/providers.example.json"

mkdir -p "$STAGE/apps/visualizer/backend/src/app-models"
cp "$REPO/apps/visualizer/backend/src/app-models/factory-questions.json" \
  "$STAGE/apps/visualizer/backend/src/app-models/factory-questions.json"

echo "Staged resources at $STAGE"
