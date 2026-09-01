#!/usr/bin/env bash
# tools/pkgsig/bulk/continue-bulk.sh — D17c bulk signature build, round 2.
#
# Consumes tools/pkgsig/bulk/candidates.json (candidates.mjs's output;
# already excludes every (name, version) round 1 attempted) and runs the
# EXISTING worker.sh (same scaffold-slot semaphore, same
# $HBC2JS_BULK_DIR/db output, same $HBC2JS_BULK_DIR/log/results.jsonl) over
# it, exactly like run.sh's own `start` does for packages.json - this
# script only differs in its job-list source. Per-job temp-dir cleanup and
# "skip already-built (pkg, version, hbcVersion)" are both inherited from
# build-one.mjs's own alreadyBuilt() check (it looks at
# $HBC2JS_BULK_DIR/db, shared with round 1 and with round 2's own prior
# runs) - nothing extra needed here for either property, which is also
# what makes this resumable/safe-to-re-run: killing and re-running `start`
# just re-walks the same candidate list and skips whatever's already on
# disk.
#
# Usage:
#   tools/pkgsig/bulk/continue-bulk.sh start    # foreground - launch under
#                                               # nohup/tmux yourself, e.g.:
#                                               #   nohup bash continue-bulk.sh start \
#                                               #     > ~/hbc2js-bulk/round2.out 2>&1 &
#   tools/pkgsig/bulk/continue-bulk.sh status
#
# Env overrides: HBC2JS_BULK_DIR (default ~/hbc2js-bulk), HBC2JS_REPO_DIR
# (default ~/hbc2js), HBC2JS_BULK_SLOTS (default 16, must match run.sh
# setup's pools - round 2 reuses round 1's scaffold slots, no separate
# setup step), HBC2JS_BULK_ROUND2_PARALLELISM (default 12, deliberately
# below run.sh's own default parallelism so round 2 can run alongside other
# deb work without saturating all 32 cores), HBC2JS_ROUND2_CANDIDATES
# (default tools/pkgsig/bulk/candidates.json next to this script).
set -uo pipefail

BULK_DIR="${HBC2JS_BULK_DIR:-$HOME/hbc2js-bulk}"
REPO_DIR="${HBC2JS_REPO_DIR:-$HOME/hbc2js}"
SLOTS="${HBC2JS_BULK_SLOTS:-16}"
PARALLELISM="${HBC2JS_BULK_ROUND2_PARALLELISM:-12}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANDIDATES_JSON="${HBC2JS_ROUND2_CANDIDATES:-$SCRIPT_DIR/candidates.json}"
ROUND2_DIST="$BULK_DIR/dist/round2"
LOG="$BULK_DIR/round2.log"

mkdir -p "$BULK_DIR/log" "$ROUND2_DIST"

build_job_list() {
  # Same (package, version, hbcVersion) expansion as run.sh's own
  # build_job_list, over candidates.json instead of packages.json.
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
  ' "$CANDIDATES_JSON"
}

assemble_watcher() {
  # Every ~500 newly-written signature files in the shared db/, drop a
  # lightweight manifest (filenames + count + timestamp, NOT a full
  # tar/zst archive - deb was already at 92% disk when this was written,
  # see docs/DEB-CI.md; repeatedly re-archiving the whole, growing shared
  # db/ every few minutes is the kind of thing that fills a disk on an
  # unattended nohup run) into $ROUND2_DIST, so round 2's progress can be
  # inspected without stopping the workers. A full sigdb-*.tar.zst +
  # index.json snapshot (assemble.sh, same as round 1 used) is still the
  # right tool for an actual publish step - just not on every 500-file
  # tick here.
  local last=0
  while [ -f "$BULK_DIR/round2.pid" ]; do
    sleep 120
    local n
    n="$(find "$BULK_DIR/db" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
    if [ "$((n - last))" -ge 500 ]; then
      local tag
      tag="$(date -u +%Y%m%d%H%M%S)"
      echo "$(date -u +%FT%TZ) round2: incremental snapshot at $n signature files -> round2-manifest-$tag.txt" >> "$LOG"
      find "$BULK_DIR/db" -maxdepth 1 -name '*.json' -newer "$ROUND2_DIST/.last-snapshot" 2>/dev/null > "$ROUND2_DIST/round2-manifest-$tag.txt" || \
        find "$BULK_DIR/db" -maxdepth 1 -name '*.json' > "$ROUND2_DIST/round2-manifest-$tag.txt"
      touch "$ROUND2_DIST/.last-snapshot"
      echo "{\"generatedAt\":\"$(date -u +%FT%TZ)\",\"signatureFilesOnDisk\":$n}" > "$ROUND2_DIST/round2-progress.json"
      last="$n"
    fi
  done
}

start() {
  if [ ! -f "$CANDIDATES_JSON" ]; then
    echo "ERROR: $CANDIDATES_JSON not found - run candidates.mjs first." >&2
    exit 1
  fi
  if [ ! -d "$BULK_DIR/slots/72-1" ] || [ ! -d "$BULK_DIR/slots/87-1" ]; then
    echo "ERROR: slot pools not set up yet - run 'run.sh setup' first (round 2 reuses round 1's scaffolds)." >&2
    exit 1
  fi

  echo $$ > "$BULK_DIR/round2.pid"
  build_job_list > "$BULK_DIR/round2-jobs.tsv"
  local total
  total="$(wc -l < "$BULK_DIR/round2-jobs.tsv" | tr -d ' ')"
  echo "$(date -u +%FT%TZ) round2 starting: $total total (package, version, hbcVersion) candidate jobs (build-one.mjs skips whatever is already on disk), parallelism=$PARALLELISM" | tee -a "$LOG"

  export HBC2JS_BULK_DIR="$BULK_DIR"
  export HBC2JS_REPO_DIR="$REPO_DIR"
  export HBC2JS_BULK_SLOTS="$SLOTS"

  assemble_watcher &
  local watcher_pid=$!
  trap 'rm -f "$BULK_DIR/round2.pid"; kill "$watcher_pid" 2>/dev/null || true' EXIT

  xargs -a "$BULK_DIR/round2-jobs.tsv" -d '\n' -P "$PARALLELISM" -I{} bash "$SCRIPT_DIR/worker.sh" {}

  echo "$(date -u +%FT%TZ) round2: job list exhausted" | tee -a "$LOG"
}

status() {
  local total db_files running
  total=0
  [ -f "$BULK_DIR/round2-jobs.tsv" ] && total="$(wc -l < "$BULK_DIR/round2-jobs.tsv" | tr -d ' ')"
  db_files="$(find "$BULK_DIR/db" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
  running="NOT running"
  if [ -f "$BULK_DIR/round2.pid" ] && kill -0 "$(cat "$BULK_DIR/round2.pid")" 2>/dev/null; then
    running="running (pid $(cat "$BULK_DIR/round2.pid"))"
  fi
  echo "D17c round2 bulk build: $running | candidate jobs=$total | signature files on disk (shared db/, round1+round2)=$db_files"
  echo "note: log/results.jsonl (ok/fail counts) is shared with round 1 - use round2-jobs.tsv membership to isolate round 2's own results if needed."
  tail -5 "$LOG" 2>/dev/null
}

cmd="${1:-}"
case "$cmd" in
  start) start ;;
  status) status ;;
  *) echo "usage: $0 {start|status}" >&2; exit 1 ;;
esac
