#!/usr/bin/env bash
# tools/pkgsig/fetch-db.sh — fetch-on-demand stub for the D17c bulk
# signature DB (docs/PACKAGE-SIGNATURES.md §6). Per D17c, the DB itself is
# never committed to this repo — this script downloads one published
# archive (built by tools/pkgsig/bulk/assemble.sh) and unpacks it into a
# local signature-DB directory in the D17b-layered format, ready to use as
# `hbc2js deps --sigdb <dest>` or as the shared user-cache layer.
#
# Usage:
#   HBC2JS_SIGDB_URL=https://example.invalid/sigdb-20260830-partial.tar.zst \
#     tools/pkgsig/fetch-db.sh [dest-dir]
#
# dest-dir defaults to $XDG_CACHE_HOME/hbc2js/sigdb (or ~/.cache/hbc2js/sigdb),
# the same user-cache layer `hbc2js deps` already reads by default
# (docs/DEPS.md "Signature DB layering").
#
# HBC2JS_SIGDB_URL has no default: no archive is published anywhere yet.
# Whoever hosts a release of the archive tools/pkgsig/bulk/assemble.sh
# produces sets this for their own use / documents it for others.
set -euo pipefail

if [ -z "${HBC2JS_SIGDB_URL:-}" ]; then
  echo "ERROR: set HBC2JS_SIGDB_URL to the archive's URL (see docs/PACKAGE-SIGNATURES.md §6)." >&2
  echo "  e.g. HBC2JS_SIGDB_URL=https://.../sigdb-20260830-partial.tar.zst $0 [dest-dir]" >&2
  exit 1
fi

DEST="${1:-${XDG_CACHE_HOME:-$HOME/.cache}/hbc2js/sigdb}"
mkdir -p "$DEST"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ARCHIVE="$TMP/sigdb-archive"

echo "fetching $HBC2JS_SIGDB_URL ..."
curl -fSL "$HBC2JS_SIGDB_URL" -o "$ARCHIVE"

case "$HBC2JS_SIGDB_URL" in
  *.tar.zst) tar --zstd -xf "$ARCHIVE" -C "$DEST" ;;
  *.tar.gz|*.tgz) tar -xzf "$ARCHIVE" -C "$DEST" ;;
  *)
    echo "ERROR: unrecognised archive extension in HBC2JS_SIGDB_URL (expected .tar.zst or .tar.gz)" >&2
    exit 1
    ;;
esac

N="$(find "$DEST" -maxdepth 1 -name '*.json' ! -name 'index.json' | wc -l | tr -d ' ')"
echo "unpacked $N signature files into $DEST"
echo "use with: hbc2js deps <bundle.hbc|app.apk> --sigdb $DEST"
