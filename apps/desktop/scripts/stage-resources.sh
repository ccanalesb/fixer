#!/usr/bin/env bash
# Build backend + frontend and copy runtime resources for the packaged app.
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$DESKTOP/../.." && pwd)"
STAGE="$DESKTOP/staged-resources"

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

echo "Copying backend…"
cp -R "$REPO/apps/visualizer/backend/dist" "$STAGE/dist"
cp "$REPO/apps/visualizer/backend/package.json" "$STAGE/package.json"
cp -R "$REPO/apps/visualizer/backend/node_modules" "$STAGE/node_modules"

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
