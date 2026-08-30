#!/usr/bin/env bash
# tools/pkgsig/bulk/run.sh — D17c bulk signature build driver.
#
# Builds a job list from tools/pkgsig/bulk/packages.json (package x version x
# HBC bytecode version {94,96,98,99}) and runs tools/pkgsig/bulk/worker.sh
# (which in turn calls build-one.mjs) over it with xargs -P, resumable
# (build-one.mjs skips any package@version__hbcN.json already present in the
# output DB), writing signatures to $HBC2JS_BULK_DIR/db and per-job JSON
# result lines to $HBC2JS_BULK_DIR/log/results.jsonl.
#
# Usage:
#   tools/pkgsig/bulk/run.sh setup     # one-time: clone N scaffold slots
#   tools/pkgsig/bulk/run.sh start     # run the build (foreground - launch
#                                      # under nohup/tmux/screen yourself)
#   tools/pkgsig/bulk/run.sh status    # one-line-ish progress summary
#   tools/pkgsig/bulk/run.sh failures  # recent failure reasons
#
# Env overrides: HBC2JS_BULK_DIR (default ~/hbc2js-bulk), HBC2JS_REPO_DIR
# (default ~/hbc2js), HBC2JS_BULK_SLOTS (default 16 - must match the slot
# pools `setup` created), HBC2JS_BULK_PARALLELISM (default = HBC2JS_BULK_SLOTS).
set -uo pipefail

BULK_DIR="${HBC2JS_BULK_DIR:-$HOME/hbc2js-bulk}"
REPO_DIR="${HBC2JS_REPO_DIR:-$HOME/hbc2js}"
SLOTS="${HBC2JS_BULK_SLOTS:-16}"
PARALLELISM="${HBC2JS_BULK_PARALLELISM:-$SLOTS}"
PACKAGES_JSON="$REPO_DIR/tools/pkgsig/bulk/packages.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$BULK_DIR/log" "$BULK_DIR/db" "$BULK_DIR/slots" "$BULK_DIR/locks"

cmd="${1:-start}"

setup() {
  echo "Scaffolding $SLOTS slots each for RN 0.72.17 (HBC94/96) and RN 0.87.1 (HBC98/99)..."
  if [ ! -d "$BULK_DIR/ScaffoldRN72" ] || [ ! -d "$BULK_DIR/ScaffoldRN87" ]; then
    echo "ERROR: $BULK_DIR/ScaffoldRN72 and/or ScaffoldRN87 don't exist yet." >&2
    echo "Create them first (see docs/PACKAGE-SIGNATURES.md §5.5's recipe / tools/pkgsig/bulk/run.sh's own header comment):" >&2
    echo "  npx --yes react-native@0.72.17 init ScaffoldRN72 --version 0.72.17 --skip-install --npm && (cd ScaffoldRN72 && npm install)" >&2
    echo "  npx --yes @react-native-community/cli@latest init ScaffoldRN87 --version 0.87.1 --skip-install --pm npm && (cd ScaffoldRN87 && npm install)" >&2
    exit 1
  fi
  local i
  local n_jobs=0
  for i in $(seq 1 "$SLOTS"); do
    if [ ! -d "$BULK_DIR/slots/72-$i" ]; then
      cp -r "$BULK_DIR/ScaffoldRN72" "$BULK_DIR/slots/72-$i" &
      n_jobs=$((n_jobs + 1))
    fi
    if [ ! -d "$BULK_DIR/slots/87-$i" ]; then
      cp -r "$BULK_DIR/ScaffoldRN87" "$BULK_DIR/slots/87-$i" &
      n_jobs=$((n_jobs + 1))
    fi
    if (( n_jobs >= 4 )); then wait; n_jobs=0; fi
  done
  wait
  du -sh "$BULK_DIR/slots"
  echo "Setup done."
}

build_job_list() {
  # Emits "pkg<TAB>version<TAB>hbcVersion" lines, one per (package, chosen
  # version, HBC version) triple, straight from packages.json - a Node
  # one-liner rather than jq (no jq dependency assumed on deb).
  node -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const hbcVersions = [94, 96, 98, 99];
    const lines = [];
    for (const p of data.packages) {
      for (const v of p.versions) {
        for (const h of hbcVersions) {
          lines.push(`${p.name}\t${v}\t${h}`);
        }
      }
    }
    process.stdout.write(lines.join("\n") + "\n");
  ' "$PACKAGES_JSON"
}

start() {
  if [ ! -f "$PACKAGES_JSON" ]; then
    echo "ERROR: $PACKAGES_JSON not found." >&2
    exit 1
  fi
  if [ ! -d "$BULK_DIR/slots/72-1" ] || [ ! -d "$BULK_DIR/slots/87-1" ]; then
    echo "ERROR: slot pools not set up yet - run '$0 setup' first." >&2
    exit 1
  fi

  echo $$ > "$BULK_DIR/run.pid"
  build_job_list > "$BULK_DIR/jobs.tsv"
  local total
  total="$(wc -l < "$BULK_DIR/jobs.tsv" | tr -d ' ')"
  echo "$(date -u +%FT%TZ) starting run: $total total (package, version, hbcVersion) jobs, parallelism=$PARALLELISM, slots=$SLOTS" | tee -a "$BULK_DIR/log/run.log"

  export HBC2JS_BULK_DIR="$BULK_DIR"
  export HBC2JS_REPO_DIR="$REPO_DIR"
  export HBC2JS_BULK_SLOTS="$SLOTS"

  xargs -a "$BULK_DIR/jobs.tsv" -d '\n' -P "$PARALLELISM" -I{} bash "$SCRIPT_DIR/worker.sh" {}

  echo "$(date -u +%FT%TZ) run.sh start: job list exhausted" | tee -a "$BULK_DIR/log/run.log"
  rm -f "$BULK_DIR/run.pid"
}

status() {
  local total done_ok done_fail done_skip running
  total=0
  if [ -f "$BULK_DIR/jobs.tsv" ]; then total="$(wc -l < "$BULK_DIR/jobs.tsv" | tr -d ' ')"; fi
  if [ -f "$BULK_DIR/log/results.jsonl" ]; then
    # grep -c always prints a count (even "0") but exits nonzero on zero
    # matches - `|| echo 0` after that would print a *second* "0" into the
    # same command substitution. Just take grep's own count.
    done_ok="$(grep -c '"ok":true' "$BULK_DIR/log/results.jsonl" 2>/dev/null)"
    done_fail="$(grep -c '"ok":false' "$BULK_DIR/log/results.jsonl" 2>/dev/null)"
    done_skip="$(grep -c '"skipped":true' "$BULK_DIR/log/results.jsonl" 2>/dev/null)"
    done_ok="${done_ok:-0}"; done_fail="${done_fail:-0}"; done_skip="${done_skip:-0}"
  else
    done_ok=0; done_fail=0; done_skip=0
  fi
  local db_files
  db_files="$(find "$BULK_DIR/db" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
  if [ -f "$BULK_DIR/run.pid" ] && kill -0 "$(cat "$BULK_DIR/run.pid")" 2>/dev/null; then
    running="running (pid $(cat "$BULK_DIR/run.pid"))"
  else
    running="NOT running"
  fi
  local processed=$((done_ok + done_fail))
  local pct="n/a"
  if [ "$total" -gt 0 ]; then pct="$(awk -v p="$processed" -v t="$total" 'BEGIN{printf "%.1f", 100*p/t}')"; fi
  echo "D17c bulk build: $running | $processed/$total processed (${pct}%) | ok=$done_ok (skipped=$done_skip) fail=$done_fail | signature files on disk=$db_files"
  if [ -f "$BULK_DIR/log/results.jsonl" ]; then
    echo "Last 3 results:"
    tail -3 "$BULK_DIR/log/results.jsonl"
  fi
}

failures() {
  if [ ! -f "$BULK_DIR/log/results.jsonl" ]; then echo "no results yet"; exit 0; fi
  echo "Most recent failures (reason, truncated):"
  grep '"ok":false' "$BULK_DIR/log/results.jsonl" | tail -n "${2:-30}"
}

case "$cmd" in
  setup) setup ;;
  start) start ;;
  status) status ;;
  failures) failures "$@" ;;
  *)
    echo "usage: $0 {setup|start|status|failures}" >&2
    exit 1
    ;;
esac
