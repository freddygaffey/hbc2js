#!/usr/bin/env bash
# Regenerates index.android.bundle, expensify-app.hbc and expensify-app.debug.hbc
# for this fixture. See BUILD.md for expected sizes/hashes/provenance and for
# the watchman/--max-workers 1 workaround this script bakes in. Not run
# automatically by anything — invoke manually; does its work in a temp dir,
# never inside the repo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> cloning Expensify/App into $WORK/expensify"
git clone --depth 1 https://github.com/Expensify/App.git "$WORK/expensify"
cd "$WORK/expensify"
echo "==> HEAD: $(git rev-parse HEAD)"

if ! command -v watchman >/dev/null 2>&1; then
  echo "==> watchman not found — installing (required to avoid a" \
       "react-native-worklets bundle-mode race, see BUILD.md)"
  if command -v brew >/dev/null 2>&1; then
    brew install watchman
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y watchman
  else
    echo "ERROR: install watchman manually for your platform, then rerun." >&2
    exit 1
  fi
fi

echo "==> npm ci (engine-strict overridden; see BUILD.md)"
npm_config_engine_strict=false npm ci --ignore-scripts

watchman watch . >/dev/null

echo "==> react-native bundle (--max-workers 1, see BUILD.md)"
npx react-native bundle \
  --platform android \
  --dev false \
  --entry-file index.js \
  --bundle-output "$HERE/index.android.bundle" \
  --assets-dest "$WORK/release-assets" \
  --max-workers 1

echo "==> fetching hermesc v98 (HBC bytecode version for RN 0.86.0)"
"$REPO_ROOT/tools/get-hermesc.sh" 98
HERMESC="$REPO_ROOT/tools/hermesc/v98/hermesc"

echo "==> compiling -O"
"$HERMESC" -O -emit-binary -out="$HERE/expensify-app.hbc" "$HERE/index.android.bundle"
echo "==> compiling -O -g"
"$HERMESC" -O -g -emit-binary -out="$HERE/expensify-app.debug.hbc" "$HERE/index.android.bundle"

echo "==> done. sha256:"
shasum -a 256 "$HERE/index.android.bundle" "$HERE/expensify-app.hbc" "$HERE/expensify-app.debug.hbc"
