#!/usr/bin/env bash
# tools/extract-apk-bundle.sh — extract the JS/Hermes bundle from an Android APK
# for local Tier-2/C5 corpus use, per docs/DECISIONS.md D16.
#
# Usage:
#   tools/extract-apk-bundle.sh <path-to.apk>
#
# What it does:
#   1. Looks inside the APK zip for a bundle at one of the conventional paths
#      (assets/index.android.bundle, assets/index.bundle, or any *.hbc under
#      assets/), in that order.
#   2. Reads the first 8 bytes to detect the Hermes magic number
#      (c6 1f bc 03 c1 03 19 1f). If present, reads the HBC version as a
#      little-endian uint32 at byte offset 8 (docs/TOOLCHAIN.md's method).
#      If absent, the bundle is plain (unmodified) JS text.
#   3. Copies the extracted bundle into
#      tests/fixtures/local-corpus/<sha256-prefix>/bundle{.hbc,.js}
#      (extension chosen by what was detected) and appends one record to
#      tests/fixtures/local-corpus/MANIFEST.json.
#
# Per D16 C5: this corpus is NEVER committed (tests/fixtures/local-corpus/*/
# is gitignored) — only MANIFEST.json (hashes + metadata, no content) and
# this directory's README.md are tracked. Only run this against APKs you
# have legitimately obtained (e.g. your own installed apps, debug builds you
# built yourself, or apps you otherwise have the right to inspect); this
# script does not fetch anything itself, it only extracts. All analysis is
# local — nothing here uploads, transmits, or publishes extracted content.
#
# Requires: unzip (or python3 as a fallback), python3 (for the manifest JSON
# and header parsing). Works on macOS and Linux.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CORPUS_DIR="$REPO_ROOT/tests/fixtures/local-corpus"
MANIFEST="$CORPUS_DIR/MANIFEST.json"

usage() {
  echo "Usage: $0 <path-to.apk>" >&2
  exit 1
}

[ $# -eq 1 ] || usage
APK="$1"
[ -f "$APK" ] || { echo "ERROR: not a file: $APK" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Candidate in-APK paths, in priority order. index.android.bundle (plain JS
# or Hermes bytecode depending on build) is the standard RN release path;
# index.bundle and loose *.hbc under assets/ cover Expo/other layouts.
CANDIDATES=(
  "assets/index.android.bundle"
  "assets/index.bundle"
)

list_zip_entries() {
  if command -v unzip >/dev/null 2>&1; then
    unzip -Z1 "$APK"
  else
    python3 -c "
import zipfile, sys
with zipfile.ZipFile(sys.argv[1]) as z:
    for n in z.namelist():
        print(n)
" "$APK"
  fi
}

extract_entry() {
  local entry="$1" dest="$2"
  if command -v unzip >/dev/null 2>&1; then
    unzip -p "$APK" "$entry" > "$dest"
  else
    python3 -c "
import zipfile, sys
with zipfile.ZipFile(sys.argv[1]) as z:
    with z.open(sys.argv[2]) as src, open(sys.argv[3], 'wb') as dst:
        dst.write(src.read())
" "$APK" "$entry" "$dest"
  fi
}

ENTRY=""
for c in "${CANDIDATES[@]}"; do
  if list_zip_entries | grep -qxF "$c"; then
    ENTRY="$c"
    break
  fi
done

if [ -z "$ENTRY" ]; then
  # Fall back to any *.hbc under assets/ (Expo-style hashed filenames).
  ENTRY="$(list_zip_entries | grep -E '^assets/.*\.hbc$' | head -1 || true)"
fi

if [ -z "$ENTRY" ]; then
  echo "ERROR: no bundle found in $APK (looked for ${CANDIDATES[*]} and assets/*.hbc)" >&2
  echo "Entries under assets/ for reference:" >&2
  list_zip_entries | grep '^assets/' | head -40 >&2 || true
  exit 1
fi

echo "Found bundle at: $ENTRY"
RAW="$WORK/raw"
extract_entry "$ENTRY" "$RAW"

# --- detect format: Hermes bytecode vs plain JS -------------------------
python3 - "$RAW" "$WORK/meta.json" <<'PYEOF'
import struct, json, sys

raw_path, meta_path = sys.argv[1], sys.argv[2]
with open(raw_path, 'rb') as f:
    header = f.read(12)

HERMES_MAGIC = bytes.fromhex('c61fbc03c103191f')
is_hermes = header[:8] == HERMES_MAGIC
hbc_version = None
if is_hermes and len(header) >= 12:
    hbc_version = struct.unpack('<I', header[8:12])[0]

with open(meta_path, 'w') as f:
    json.dump({'isHermes': is_hermes, 'hbcVersion': hbc_version}, f)
PYEOF

IS_HERMES="$(python3 -c "import json; print(json.load(open('$WORK/meta.json'))['isHermes'])")"
HBC_VERSION="$(python3 -c "import json; v=json.load(open('$WORK/meta.json'))['hbcVersion']; print(v if v is not None else '')")"

if [ "$IS_HERMES" = "True" ]; then
  EXT="hbc"
  echo "Format: Hermes bytecode, HBC version $HBC_VERSION"
else
  EXT="js"
  HBC_VERSION=""
  echo "Format: plain JS (no Hermes magic found)"
fi

SHA256="$(shasum -a 256 "$RAW" | awk '{print $1}')"
SIZE="$(wc -c < "$RAW" | tr -d ' ')"
PREFIX="${SHA256:0:16}"
OUT_DIR="$CORPUS_DIR/$PREFIX"
mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/bundle.$EXT"
cp "$RAW" "$OUT_FILE"

echo "Extracted to: $OUT_FILE"
echo "sha256: $SHA256"
echo "size: $SIZE bytes"

mkdir -p "$CORPUS_DIR"
[ -f "$MANIFEST" ] || echo "[]" > "$MANIFEST"

python3 - "$MANIFEST" "$SHA256" "$SIZE" "$HBC_VERSION" "$(basename "$APK")" "$ENTRY" <<'PYEOF'
import json, sys, datetime

manifest_path, sha256, size, hbc_version, apk_name, entry = sys.argv[1:7]
with open(manifest_path) as f:
    records = json.load(f)

record = {
    "sha256": sha256,
    "size": int(size),
    "hbcVersion": int(hbc_version) if hbc_version else None,
    "sourceApkName": apk_name,
    "entryPath": entry,
    "date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}

# Idempotent: replace any existing record with the same sha256 rather than duplicating.
records = [r for r in records if r.get("sha256") != sha256]
records.append(record)

with open(manifest_path, 'w') as f:
    json.dump(records, f, indent=2)
    f.write("\n")
PYEOF

echo "Manifest updated: $MANIFEST"
