#!/usr/bin/env bash
# Regenerates the "light" hardened (C4) variant. See BUILD.md — needs a
# larger V8 heap (NODE_OPTIONS below) or javascript-obfuscator OOMs on this
# bundle's size at default limits.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$HERE/../../../../.." && pwd)"

if [ ! -f "$PARENT/index.android.bundle" ]; then
  echo "==> parent bundle missing, running $PARENT/fetch.sh first"
  "$PARENT/fetch.sh"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp "$PARENT/index.android.bundle" "$WORK/index.android.bundle.js"

echo "==> obfuscating (light config, 8GB heap)"
NODE_OPTIONS="--max-old-space-size=8192" npx --yes javascript-obfuscator@5.6.0 "$WORK/index.android.bundle.js" \
  --output "$WORK/obfuscated" \
  --compact true \
  --control-flow-flattening true \
  --control-flow-flattening-threshold 0.1 \
  --dead-code-injection false \
  --string-array true \
  --string-array-encoding rc4 \
  --string-array-threshold 0.5 \
  --self-defending false

cp "$WORK/obfuscated" "$HERE/index.android.bundle"

echo "==> fetching hermesc v98"
"$REPO_ROOT/tools/get-hermesc.sh" 98
HERMESC="$REPO_ROOT/tools/hermesc/v98/hermesc"

echo "==> compiling"
"$HERMESC" -O -emit-binary -out="$HERE/expensify-app.hardened.hbc" "$HERE/index.android.bundle"

echo "==> done. sha256:"
shasum -a 256 "$HERE/index.android.bundle" "$HERE/expensify-app.hardened.hbc"
