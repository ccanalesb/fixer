#!/usr/bin/env bash
# Download a stock Node.js binary for the given Rust target triple, verified against SHASUMS256.txt.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(tr -d '[:space:]' < "$ROOT/node-version.txt")"
TRIPLE="${1:-$(rustc -vV | sed -n 's/^host: //p')}"
BIN_DIR="$ROOT/src-tauri/binaries"
mkdir -p "$BIN_DIR"

case "$TRIPLE" in
  aarch64-apple-darwin)
    NODE_OS=darwin
    NODE_ARCH=arm64
    OUT_NAME="node-$TRIPLE"
    ;;
  x86_64-pc-windows-msvc)
    NODE_OS=win
    NODE_ARCH=x64
    OUT_NAME="node-$TRIPLE.exe"
    ;;
  x86_64-unknown-linux-gnu)
    NODE_OS=linux
    NODE_ARCH=x64
    OUT_NAME="node-$TRIPLE"
    ;;
  *)
    echo "Unsupported target triple: $TRIPLE" >&2
    exit 1
    ;;
esac

OUT_PATH="$BIN_DIR/$OUT_NAME"
if [[ -f "$OUT_PATH" ]]; then
  echo "Node binary already present: $OUT_PATH"
  exit 0
fi

DIST_BASE="node-v${VERSION}-${NODE_OS}-${NODE_ARCH}"
case "$NODE_OS" in
  win) ARCHIVE="${DIST_BASE}.zip" ;;
  *) ARCHIVE="${DIST_BASE}.tar.xz" ;;
esac

URL="https://nodejs.org/dist/v${VERSION}/${ARCHIVE}"
SUMS_URL="https://nodejs.org/dist/v${VERSION}/SHASUMS256.txt"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Fetching $URL"
curl -fsSL "$URL" -o "$WORK/$ARCHIVE"
curl -fsSL "$SUMS_URL" -o "$WORK/SHASUMS256.txt"

(
  cd "$WORK"
  # Git Bash on Windows ships sha256sum but not shasum.
  if command -v sha256sum >/dev/null; then sha256=(sha256sum); else sha256=(shasum -a 256); fi
  grep "  ${ARCHIVE}\$" SHASUMS256.txt | "${sha256[@]}" -c -
)

case "$NODE_OS" in
  win)
    unzip -q "$WORK/$ARCHIVE" -d "$WORK/extract"
    SRC="$WORK/extract/$DIST_BASE/node.exe"
    cp "$SRC" "$OUT_PATH"
    chmod +x "$OUT_PATH"
    ;;
  darwin | linux)
    mkdir -p "$WORK/extract"
    tar -xJf "$WORK/$ARCHIVE" -C "$WORK/extract"
    cp "$WORK/extract/$DIST_BASE/bin/node" "$OUT_PATH"
    chmod +x "$OUT_PATH"
    ;;
esac

echo "Installed $OUT_PATH"
