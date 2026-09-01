#!/usr/bin/env bash
# tools/deb/run.sh — run a command on the `deb` job server, one tool call,
# tiny output. See docs/DEB-CI.md.
#
# Usage:
#   tools/deb/run.sh [--ref <branch>] [--sha <sha>] [--timeout <min>] [--keep] -- <cmd...>
#   tools/deb/run.sh --status [id]      # list recent jobs, or one job's status
#   tools/deb/run.sh --log <id>         # full log for a job
#
# Default ref: the current local branch, which is pushed to origin first
# (`git push -q origin HEAD`) so the server can fetch it. Use --sha to skip
# the push and run an already-pushed commit.
set -euo pipefail

URL="${DEB_CI_URL:-http://deb.local:8787}"
REF=""
SHA=""
TIMEOUT_MIN=30
KEEP=false
CMD=()
MODE=run

while [ $# -gt 0 ]; do
  case "$1" in
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

node_json() { node -e "$1"; }

if [ "$MODE" = "status" ]; then
  ID="${CMD[0]:-${1:-}}"
  if [ -n "$ID" ]; then
    curl -sf "$URL/jobs/$ID" | node -e '
      const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
      console.log(`${j.id} ${j.status} exit=${j.exitCode} ${j.durationS ?? ""}s ref=${j.ref}`);
      console.log((j.tail||[]).join("\n"));
    '
  else
    curl -sf "$URL/jobs" | node -e '
      const list = JSON.parse(require("fs").readFileSync(0, "utf8"));
      for (const j of list) console.log(`${j.id}  ${j.status.padEnd(8)} exit=${String(j.exitCode)} ${j.ref}  ${j.cmd}`);
    '
  fi
  exit 0
fi

if [ "$MODE" = "log" ]; then
  ID="${SHA_OR_ID:-${CMD[0]:-}}"
  curl -sf "$URL/jobs/$ID/log"
  exit 0
fi

if [ ${#CMD[@]} -eq 0 ]; then
  echo "usage: run.sh [--ref R|--sha S] [--timeout MIN] [--keep] -- <cmd...>" >&2
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
