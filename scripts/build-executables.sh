#!/usr/bin/env bash
set -euo pipefail

# Build kspec-daemon executables for multiple platforms
# Requires: npm run build (to populate dist/daemon/ with correct import paths)
# Requires: Bun 1.0+ with --compile support

DAEMON_SRC="dist/daemon/index.ts"
DIST_DIR="dist/executables"

if [ ! -f "$DAEMON_SRC" ]; then
  echo "Error: $DAEMON_SRC not found. Run 'npm run build' first."
  exit 1
fi

echo "Building kspec-daemon executables..."

# Create output directory
mkdir -p "$DIST_DIR"

# Build for each platform
# Note: Cross-compilation requires appropriate Bun support for each target

echo "Building for Linux x64..."
bun build --compile --minify --target=bun-linux-x64 "$DAEMON_SRC" --outfile "$DIST_DIR/kspec-daemon-linux-x64"

echo "Building for macOS ARM64 (Apple Silicon)..."
bun build --compile --minify --target=bun-darwin-arm64 "$DAEMON_SRC" --outfile "$DIST_DIR/kspec-daemon-darwin-arm64"

echo "Building for macOS x64 (Intel)..."
bun build --compile --minify --target=bun-darwin-x64 "$DAEMON_SRC" --outfile "$DIST_DIR/kspec-daemon-darwin-x64"

echo "Building for Windows x64..."
bun build --compile --minify --target=bun-windows-x64 "$DAEMON_SRC" --outfile "$DIST_DIR/kspec-daemon-win-x64.exe"

echo ""
echo "Build complete! Executables:"
ls -lh "$DIST_DIR"
