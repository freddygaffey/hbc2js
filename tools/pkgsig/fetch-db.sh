#!/usr/bin/env bash
# tools/pkgsig/fetch-db.sh — fetch-on-demand for the D17c bulk signature DB
# (docs/PACKAGE-SIGNATURES.md §6). Per D17c, the DB itself is never
# committed to this repo — this script fetches one published archive (built
# by tools/pkgsig/bulk/assemble.sh) and unpacks it into a local signature-DB
# directory in the D17b-layered format, ready to use as
# `hbc2js deps --sigdb <dest>` or as the shared user-cache layer. It then
# runs `filter-unsubtracted.mjs` (issue #14 finding, 2026-08-31 — see below)
# before the DB is considered ready.
#
# Two source forms, auto-detected from HBC2JS_SIGDB_SOURCE:
#
#   HTTP(S) URL — curl:
#     HBC2JS_SIGDB_SOURCE=https://example.invalid/sigdb-20260830-partial.tar.zst \
#       tools/pkgsig/fetch-db.sh [dest-dir]
#
#   scp-style remote path (`host:/path/to/archive.tar.zst`) — scp, for
#   fetching straight off the build host (`deb`, per D17c's "built on deb"
#   plan) before any archive is published anywhere public. This is how this
#   task actually fetched the first archive (2026-08-31):
#     HBC2JS_SIGDB_SOURCE=deb:~/hbc2js-bulk/dist/sigdb-20260830-partial.tar.zst \
#       tools/pkgsig/fetch-db.sh [dest-dir]
#     (the matching index, if wanted alongside: also scp
#      deb:~/hbc2js-bulk/dist/index-partial.json to the same dest-dir)
#
#   A bare local file path (no `://`, no `:` before the first `/`) is copied
#   as-is — useful for testing against an archive already sitting on disk.
#
# `HBC2JS_SIGDB_URL` (the original, curl-only env var name) still works as a
# deprecated alias for `HBC2JS_SIGDB_SOURCE` when only an HTTP(S) URL is
# needed.
#
# dest-dir defaults to $XDG_CACHE_HOME/hbc2js/sigdb (or ~/.cache/hbc2js/sigdb),
# the same user-cache layer `hbc2js deps` already reads by default
# (docs/DEPS.md "Signature DB layering").
#
# Neither env var has a default: no archive is published anywhere public yet
# (D17c: "distributed separately... fetch-on-demand" is the plan; only a
# deb-hosted build exists as of this task). Whoever hosts a public release
# sets HBC2JS_SIGDB_SOURCE for their own use / documents it for others.
#
# Data hygiene (found 2026-08-31, docs/PACKAGE-SIGNATURES.md §6.7): the
# first archive built on deb (`sigdb-20260830-partial.tar.zst`, a partial/
# interrupted run per its own filename) has 353 of its 32,708 files with
# baseline subtraction silently skipped — each one a large, essentially
# unsubtracted copy of Metro's runtime plus (when the build scaffold pulled
# it in) all of react/react-native, that then wins false exact-hash
# "confirmed" matches against any real RN bundle. Verified: unfiltered, this
# turned a clean 2-dependency report on the committed `rn-template-0.72`
# fixture into 134 "confirmed" dependencies, 133 of them false. This script
# always runs `filter-unsubtracted.mjs` on `dest-dir` after extracting, so a
# freshly-fetched DB is never usable in this contaminated state — quarantined
# files land in `dest-dir/_rejected-unsubtracted/`, which `src/deps/db.ts`
# never reads. Safe to re-run against an already-extracted `dest-dir` too
# (it's idempotent — nothing left to quarantine on a second pass).
set -euo pipefail

SOURCE="${HBC2JS_SIGDB_SOURCE:-${HBC2JS_SIGDB_URL:-}}"
if [ -z "$SOURCE" ]; then
  echo "ERROR: set HBC2JS_SIGDB_SOURCE (see docs/PACKAGE-SIGNATURES.md §6)." >&2
  echo "  e.g. HBC2JS_SIGDB_SOURCE=https://.../sigdb-20260830-partial.tar.zst $0 [dest-dir]" >&2
  echo "  or:  HBC2JS_SIGDB_SOURCE=deb:~/hbc2js-bulk/dist/sigdb-20260830-partial.tar.zst $0 [dest-dir]" >&2
  exit 1
fi

DEST="${1:-${XDG_CACHE_HOME:-$HOME/.cache}/hbc2js/sigdb}"
mkdir -p "$DEST"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ARCHIVE="$TMP/sigdb-archive"

case "$SOURCE" in
  http://*|https://*)
    echo "fetching (curl) $SOURCE ..."
    curl -fSL "$SOURCE" -o "$ARCHIVE"
    ;;
  *:*)
    # scp-style `[user@]host:path` — anything with a colon that isn't an
    # http(s) URL. (A Windows-style drive-letter path would also match this
    # pattern; this script assumes macOS/Linux per docs/AGENT-BRIEF.md.)
    echo "fetching (scp) $SOURCE ..."
    scp -q "$SOURCE" "$ARCHIVE"
    ;;
  *)
    echo "using local file $SOURCE ..."
    cp "$SOURCE" "$ARCHIVE"
    ;;
esac

case "$SOURCE" in
  *.tar.zst) tar --zstd -xf "$ARCHIVE" -C "$DEST" ;;
  *.tar.gz|*.tgz) tar -xzf "$ARCHIVE" -C "$DEST" ;;
  *)
    echo "ERROR: unrecognised archive extension in HBC2JS_SIGDB_SOURCE (expected .tar.zst or .tar.gz)" >&2
    exit 1
    ;;
esac

N="$(find "$DEST" -maxdepth 1 -name '*.json' ! -name 'index.json' | wc -l | tr -d ' ')"
echo "unpacked $N signature files into $DEST"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$HERE/filter-unsubtracted.mjs" "$DEST"

echo "use with: hbc2js deps <bundle.hbc|app.apk> --sigdb $DEST"
