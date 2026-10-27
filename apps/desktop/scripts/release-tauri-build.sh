#!/usr/bin/env bash
# Build Tauri bundles, then run the packaged host smoke (release CI leg).
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DESKTOP"

BUILD_CMD=(npm run tauri -- build)
if [[ -n "${TAURI_BUILD_CONFIG:-}" && -f "$TAURI_BUILD_CONFIG" ]]; then
  BUILD_CMD+=(--config "$TAURI_BUILD_CONFIG")
fi

"${BUILD_CMD[@]}"

find_host() {
  local release="$DESKTOP/src-tauri/target/release"
  if [[ "$OSTYPE" == darwin* ]]; then
    local app
    app=$(find "$release/bundle/macos" -path '*/Contents/MacOS/*' -type f 2>/dev/null | head -1 || true)
    if [[ -n "$app" ]]; then
      echo "$app"
      return
    fi
    for name in fixer-desktop Fixer; do
      if [[ -x "$release/$name" ]]; then
        echo "$release/$name"
        return
      fi
    done
  elif [[ "$OSTYPE" == msys* || "$OSTYPE" == win32* || "${OS:-}" == Windows_NT* ]]; then
    for name in fixer-desktop.exe Fixer.exe; do
      if [[ -f "$release/$name" ]]; then
        echo "$release/$name"
        return
      fi
    done
  else
    for name in fixer-desktop fixer; do
      if [[ -x "$release/$name" ]]; then
        echo "$release/$name"
        return
      fi
    done
  fi
  return 1
}

HOST="$(find_host)" || {
  echo "Could not find Tauri host binary under src-tauri/target/release" >&2
  exit 1
}

if [[ "${USE_XVFB:-}" == "1" ]]; then
  xvfb-run -a node "$DESKTOP/scripts/smoke-packaged-app.mjs" --host "$HOST"
else
  node "$DESKTOP/scripts/smoke-packaged-app.mjs" --host "$HOST"
fi
