#!/usr/bin/env bash
# tests/fixtures/security/vuln-app/build.sh — spec 13 (P2.4 reuse-validation)
# step 1 build hook. Compiles source/App.js to v96.hbc with hermesc v96 (the
# Semgrep lane only needs one version -- spec 13 2.3 step 1: "Semgrep sees
# only the emitted JS"). Never requires Android build tooling to succeed
# (spec 13 ruling R-A) -- the APK side (Lane M, step 4) is a separate,
# not-yet-implemented hook; this script only prints a note about it.
#
# Usage: tests/fixtures/security/vuln-app/build.sh
# Requires: tools/get-hermesc.sh 96 to have been run first.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
HERMESC="$REPO_ROOT/tools/hermesc/v96/hermesc"

if [ ! -x "$HERMESC" ]; then
  echo "SKIP (no hermesc v96 installed -- run tools/get-hermesc.sh 96): v96.hbc"
  exit 0
fi

# Invoke from inside source/ with a relative path, per the construct fixtures'
# reproducibility convention (docs/TOOLCHAIN.md) -- debug info embeds the
# invoked filename, always source/App.js's basename, never a machine-specific
# absolute path.
(
  cd "$SCRIPT_DIR/source" &&
  "$HERMESC" -emit-binary -out="../v96.hbc" "App.js"
)
echo "OK   v96 -> $SCRIPT_DIR/v96.hbc"

echo "NOTE: Lane M (APK, spec 13 step 4) is not implemented by this hook yet;"
echo "      no apk/ directory exists under this fixture. See README.md."
