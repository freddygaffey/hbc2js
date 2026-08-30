#!/usr/bin/env bash
# docs/specs/01-parser.md §5.1 — fetch + pin BytecodeList.def et al. from a specific
# facebook/hermes commit (MIT). Vendoring makes gen:tables:check hermetic (no network
# needed in CI) and makes provenance auditable.
#
# Usage: tools/gen-tables/vendor.sh <tableId> <hermesCommitSha>
# Example: tools/gen-tables/vendor.sh hbc94 1c717488d1799f6153cf6d60c3556ab4ddd9dce6
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <tableId> <hermesCommitSha>" >&2
  exit 2
fi

TABLE_ID="$1"
SHA="$2"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="$ROOT/third_party/hermes/$TABLE_ID"
BASE="https://raw.githubusercontent.com/facebook/hermes/$SHA"

mkdir -p "$DEST"

fetch() {
  local rel="$1"
  local out="$DEST/$(basename "$rel")"
  echo "fetching $rel @ $SHA"
  curl -sSf -o "$out" "$BASE/$rel"
}

# Optional: a file that only exists from a certain Hermes commit onwards. Missing
# is not an error, but a half-written file would be, so the download goes to a
# temp path first.
fetch_optional() {
  local rel="$1"
  local out="$DEST/$(basename "$rel")"
  local tmp="$out.tmp.$$"
  if curl -sSf -o "$tmp" "$BASE/$rel" 2>/dev/null; then
    mv "$tmp" "$out"
    echo "fetching $rel @ $SHA"
    return 0
  fi
  rm -f "$tmp" "$out"
  echo "skipping $rel @ $SHA (not present at this commit)"
  return 1
}

fetch "include/hermes/BCGen/HBC/BytecodeList.def"
fetch "include/hermes/FrontEndDefs/Builtins.def"
fetch "include/hermes/BCGen/HBC/BytecodeVersion.h"
fetch "LICENSE"
# TypeOfIs/JmpTypeOfIs's operand is a `TypeOfIsTypes` bitset; the enum's
# declaration order IS the bit order, so the header is the table.
# It appears with the opcode, so pins before HBC 98-late simply do not have it.
OPTIONAL_FILES=()
if fetch_optional "include/hermes/FrontEndDefs/Typeof.h"; then
  OPTIONAL_FILES+=(Typeof.h)
fi

# Record the pin + sha256 of each vendored file.
{
  echo "tableId: $TABLE_ID"
  echo "hermesCommit: $SHA"
  echo "fetchedAt: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "files:"
  for f in BytecodeList.def Builtins.def BytecodeVersion.h LICENSE ${OPTIONAL_FILES[@]+"${OPTIONAL_FILES[@]}"}; do
    if command -v shasum >/dev/null 2>&1; then
      sum=$(shasum -a 256 "$DEST/$f" | awk '{print $1}')
    else
      sum=$(sha256sum "$DEST/$f" | awk '{print $1}')
    fi
    echo "  $f: $sum"
  done
} > "$DEST/VENDOR.yml"

echo "vendored $TABLE_ID @ $SHA -> $DEST"
