#!/usr/bin/env bash
# tools/deb/start-local.sh — start tools/deb/server.mjs on THIS machine (the
# Mac, or any other box that isn't `deb`) as a second compute-node candidate
# for load-aware picking (docs/DEB-CI.md "Load-aware picking + running a
# node on the Mac"). Not a systemd install (that's tools/deb/install.sh, for
# a remote Debian/Ubuntu host reachable over SSH) -- this just backgrounds
# the server under nohup on the local machine, since a Mac has no systemd.
#
# Idempotent: if something is already listening on the target port, prints
# that and exits 0 without starting a second copy.
#
# Usage: tools/deb/start-local.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PORT="${PORT:-8788}"
export HBC2JS_CI_DIR="${HBC2JS_CI_DIR:-$HOME/hbc2js-ci-local}"
export HBC2JS_TOOLCHAIN_DIR="${HBC2JS_TOOLCHAIN_DIR:-$REPO_ROOT/tools}"
NPROC="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)"
HALF=$((NPROC / 2))
if [ "$HALF" -lt 1 ]; then HALF=1; fi
export MAX_PARALLEL="${MAX_PARALLEL:-$HALF}"
export PORT

mkdir -p "$HBC2JS_CI_DIR"
LOG="$HBC2JS_CI_DIR/server.log"

if curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/jobs" 2>/dev/null; then
  echo "start-local.sh: something is already listening on port $PORT (http://127.0.0.1:$PORT), leaving it alone" >&2
  exit 0
fi

echo "start-local.sh: starting server.mjs on port $PORT (HBC2JS_CI_DIR=$HBC2JS_CI_DIR, HBC2JS_TOOLCHAIN_DIR=$HBC2JS_TOOLCHAIN_DIR, MAX_PARALLEL=$MAX_PARALLEL)" >&2
nohup node "$SCRIPT_DIR/server.mjs" >>"$LOG" 2>&1 &
disown || true
echo "start-local.sh: started (pid $!), log at $LOG" >&2
echo "try: curl http://127.0.0.1:$PORT/load" >&2
