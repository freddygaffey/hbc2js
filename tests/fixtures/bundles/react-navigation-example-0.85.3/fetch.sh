#!/usr/bin/env bash
# Regenerates index.android.bundle, react-navigation-example.hbc and
# react-navigation-example.debug.hbc for this fixture. See BUILD.md for
# expected sizes/hashes and provenance. Not run automatically by anything —
# invoke manually; does its work in a temp dir, never inside the repo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> cloning react-navigation/react-navigation into $WORK/rn-nav"
git clone --depth 1 https://github.com/react-navigation/react-navigation.git "$WORK/rn-nav"
cd "$WORK/rn-nav"
echo "==> HEAD: $(git rev-parse HEAD)"

echo "==> pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

cd example
echo "==> expo export (JS bundle, no bytecode)"
node_modules/.bin/expo export --platform android --output-dir dist-js --no-bytecode

JSBUNDLE="$(find dist-js -name '*.js' | head -1)"
cp "$JSBUNDLE" "$HERE/index.android.bundle"

echo "==> fetching hermesc v98 (HBC bytecode version for RN 0.85.3)"
"$REPO_ROOT/tools/get-hermesc.sh" 98
HERMESC="$REPO_ROOT/tools/hermesc/v98/hermesc"

echo "==> compiling -O"
"$HERMESC" -O -emit-binary -out="$HERE/react-navigation-example.hbc" "$HERE/index.android.bundle"
echo "==> compiling -O -g"
"$HERMESC" -O -g -emit-binary -out="$HERE/react-navigation-example.debug.hbc" "$HERE/index.android.bundle"

echo "==> done. sha256:"
shasum -a 256 "$HERE/index.android.bundle" "$HERE/react-navigation-example.hbc" "$HERE/react-navigation-example.debug.hbc"
