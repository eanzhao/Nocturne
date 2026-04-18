#!/usr/bin/env bash
# Compile `nocturne-format` from source and install it to ~/.bun/bin.
#
# Usage:
#   ./scripts/install-nocturne-format.sh            # release build (minified)
#   ./scripts/install-nocturne-format.sh --dev      # unminified, for debugging
#   INSTALL_DIR=/usr/local/bin ./scripts/install-nocturne-format.sh
#
# Idempotent; overwrites the existing binary in place. Prints source
# git state and size so reinstalls are traceable.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

INSTALL_DIR="${INSTALL_DIR:-$HOME/.bun/bin}"
TARGET="$INSTALL_DIR/nocturne-format"
ENTRY="./src/cli/format.ts"
DIST="$REPO_ROOT/dist/nocturne-format"

MINIFY="--minify"
if [[ "${1:-}" == "--dev" ]]; then
  MINIFY=""
fi

# Need Bun to build; tell the user where to get it if missing.
if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun not found on PATH (need it to compile). See https://bun.sh." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR" "$(dirname "$DIST")"

echo "building nocturne-format from $ENTRY"
# shellcheck disable=SC2086 # intentional word-splitting for optional flag
bun build --compile $MINIFY "$ENTRY" --outfile "$DIST"

# Replace atomically so a concurrent invocation never sees a half-written file.
mv "$DIST" "$TARGET.new"
chmod +x "$TARGET.new"
mv -f "$TARGET.new" "$TARGET"

# Provenance: show what we just shipped.
HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo "unknown")"
DIRTY=""
if ! git -C "$REPO_ROOT" diff --quiet 2>/dev/null; then
  DIRTY=" (+dirty)"
fi
SIZE="$(du -h "$TARGET" | awk '{print $1}')"

echo
echo "installed:  $TARGET"
echo "size:       $SIZE"
echo "source:     $HEAD_SHA$DIRTY"
echo
echo "sanity check:"
"$TARGET" --help | head -5 || true
