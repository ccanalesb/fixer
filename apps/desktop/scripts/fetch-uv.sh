#!/usr/bin/env bash
# Download the pinned uv binary for a Rust target triple into staged-resources/bin/.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/fetch-uv.mjs" "$@"
