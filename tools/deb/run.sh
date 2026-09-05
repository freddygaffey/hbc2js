#!/usr/bin/env bash
# tools/deb/run.sh — run a command on a compute-node job server, one tool
# call, tiny output. See docs/DEB-CI.md and docs/specs/24-compute-node.md.
#
# Usage:
#   tools/deb/run.sh [--host <url>] [--ref <branch>] [--sha <sha>] [--timeout <min>] [--keep] -- <cmd...>
#   tools/deb/run.sh [--host <url>] --status [id]      # list recent jobs, or one job's status
#   tools/deb/run.sh [--host <url>] --log <id>         # full log for a job
#
# Host selection (spec 24 §3, docs/DEB-CI.md "Load-aware picking"):
# HBC2JS_CI_HOSTS is a space-separated list of candidate host URLs (default
# "http://deb.local:8787 http://127.0.0.1:8788" -- deb, and a Mac instance
# started via tools/deb/start-local.sh). DEB_CI_URL is a one-host override
# (kept for back-compat with single-node setups). --host pins a host and
# skips the pick entirely. Otherwise every candidate host's GET /load is
# polled (2s timeout each, via tools/deb/pick.mjs) and the host with the
# lowest load score is chosen (loadavg/nproc + queue pressure, so an idle
# box with a full queue does not win); unreachable hosts are skipped with a
# warning on stderr; ties go to list order. A host that only understands the
# older GET /jobs falls back to a queued+running count for itself.
#
# --status with no id lists jobs from every candidate host (or just the
# pinned host with --host), each line prefixed with its host.
#
# Default ref: the current local branch, which is pushed to origin first
# (`git push -q origin HEAD`) so the server can fetch it. Use --sha to skip
# the push and run an already-pushed commit or branch name. Note: GitHub
# only serves a FULL 40-char sha over `git fetch` for a public repo, not a
# short/abbreviated one -- a short --sha will fail server-side with "could
# not find <sha> in upstream origin".
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

HOST_PIN="${DEB_CI_URL:-}"
HOSTS="${HBC2JS_CI_HOSTS:-http://deb.local:8787 http://127.0.0.1:8788}"
REF=""
SHA=""
TIMEOUT_MIN=30
KEEP=false
CMD=()
MODE=run

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST_PIN="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --sha) SHA="$2"; shift 2 ;;
    --timeout) TIMEOUT_MIN="$2"; shift 2 ;;
    --keep) KEEP=true; shift ;;
    --status) MODE=status; shift ;;
    --log) MODE=log; shift; SHA_OR_ID="${1:-}"; shift || true ;;
    --) shift; CMD=("$@"); break ;;
    *) CMD+=("$1"); shift ;;
  esac
done

# Resolve which URL to use: --host / DEB_CI_URL pin it outright; otherwise
# pick among HBC2JS_CI_HOSTS by current load. Bash 3.2-compatible (no
# mapfile, no ${var,,}) — must run on macOS's stock bash and on Linux.
resolve_url() {
  if [ -n "$HOST_PIN" ]; then
    URL="$HOST_PIN"
    return 0
  fi
  # Split HOSTS on whitespace into positional args, then hand them to pick.mjs.
  set -- $HOSTS
  if [ "$#" -eq 0 ]; then
    echo "run.sh: HBC2JS_CI_HOSTS is empty" >&2
    exit 1
  fi
  if [ "$#" -eq 1 ]; then
    URL="$1"
    return 0
  fi
  if ! URL="$(node "$SCRIPT_DIR/pick.mjs" "$@")"; then
    exit 1
  fi
}

if [ "$MODE" = "status" ]; then
  ID="${CMD[0]:-${1:-}}"
  if [ -n "$ID" ]; then
    resolve_url
    URL="${URL%/}"
    curl -sf "$URL/jobs/$ID" | node -e '
      const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
      console.log(`${j.id} ${j.status} exit=${j.exitCode} ${j.durationS ?? ""}s ref=${j.ref}`);
      console.log((j.tail||[]).join("\n"));
    '
    exit 0
  fi
  # No id: list jobs from every candidate host (or just the pinned host),
  # prefixed by host, instead of picking one -- you want the full picture
  # when there's more than one node. No pick.mjs call here, so this never
  # touches the network beyond the plain GETs below.
  STATUS_HOSTS="${HOST_PIN:-$HOSTS}"
  for h in $STATUS_HOSTS; do
    h="${h%/}"
    OUT="$(curl -sf --max-time 3 "$h/jobs" 2>/dev/null)" || { echo "$h  (unreachable)"; continue; }
    echo "$OUT" | node -e '
      const list = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const host = process.argv[1];
      for (const j of list) console.log(`${host}  ${j.id}  ${j.status.padEnd(8)} exit=${String(j.exitCode)} ${j.ref}  ${j.cmd}`);
    ' "$h"
  done
  exit 0
fi

if [ "$MODE" = "log" ]; then
  resolve_url
  URL="${URL%/}"
  ID="${SHA_OR_ID:-${CMD[0]:-}}"
  curl -sf "$URL/jobs/$ID/log"
  exit 0
fi

resolve_url
URL="${URL%/}"

if [ ${#CMD[@]} -eq 0 ]; then
  echo "usage: run.sh [--host URL] [--ref R|--sha S] [--timeout MIN] [--keep] -- <cmd...>" >&2
  exit 2
fi

if [ -n "$SHA" ]; then
  REF="$SHA"
else
  REF="${REF:-$(git rev-parse --abbrev-ref HEAD)}"
  echo "pushing $REF to origin..." >&2
  git push -q origin "HEAD:refs/heads/$REF"
fi

CMD_STR="${CMD[*]}"
PAYLOAD=$(node -e "console.log(JSON.stringify({ref: process.argv[1], cmd: process.argv[2], timeoutMin: Number(process.argv[3]), keep: process.argv[4] === 'true'}))" "$REF" "$CMD_STR" "$TIMEOUT_MIN" "$KEEP")

RESP=$(curl -sf -X POST "$URL/jobs" -H 'Content-Type: application/json' -d "$PAYLOAD")
ID=$(echo "$RESP" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).id)')
echo "job $ID queued on $URL (ref=$REF, timeout=${TIMEOUT_MIN}min)" >&2

POLL=0
STATUS=queued
while true; do
  sleep 5
  POLL=$((POLL+1))
  JOB=$(curl -sf "$URL/jobs/$ID")
  STATUS=$(echo "$JOB" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).status)')
  if [ $((POLL % 12)) -eq 0 ]; then
    echo "[$((POLL*5/60))m] $ID $STATUS" >&2
  fi
  if [ "$STATUS" = "done" ]; then
    echo "$JOB" | node -e '
      const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
      console.log(`--- ${j.id} done: exit=${j.exitCode} in ${j.durationS}s (sha ${j.sha}) ---`);
      console.log((j.tail||[]).join("\n"));
    '
    EXIT=$(echo "$JOB" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).exitCode)')
    exit "${EXIT:-1}"
  fi
done
