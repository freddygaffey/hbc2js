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
# (default tools/pkgsig/bulk/candidates.json next to this script, or, for
# round 2b, $BULK_DIR/candidates-registry.json - see HBC2JS_BULK_ROUND_TAG
# below).
#
# HBC2JS_BULK_ROUND_TAG (default "round2") - round 2b (the npm-registry-
# driven candidate list, docs/DEPS.md "Round 2b") reuses this same script
# unchanged by setting HBC2JS_BULK_ROUND_TAG=round2b: every round-scoped
# path (log, pid file, jobs list, incremental-assemble dist dir) is
# namespaced by this tag, so round 2 and round 2b can even run
# concurrently without colliding - only $BULK_DIR/db (signatures) and
# $BULK_DIR/log/results.jsonl (shared across every round, per worker.sh)
# are shared on purpose.
set -uo pipefail

BULK_DIR="${HBC2JS_BULK_DIR:-$HOME/hbc2js-bulk}"
REPO_DIR="${HBC2JS_REPO_DIR:-$HOME/hbc2js}"
SLOTS="${HBC2JS_BULK_SLOTS:-16}"
PARALLELISM="${HBC2JS_BULK_ROUND2_PARALLELISM:-12}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAG="${HBC2JS_BULK_ROUND_TAG:-round2}"
case "$TAG" in
  round2b) DEFAULT_CANDIDATES="$BULK_DIR/candidates-registry.json" ;;
  *) DEFAULT_CANDIDATES="$SCRIPT_DIR/candidates.json" ;;
esac
CANDIDATES_JSON="${HBC2JS_ROUND2_CANDIDATES:-$DEFAULT_CANDIDATES}"
ROUND2_DIST="$BULK_DIR/dist/$TAG"
LOG="$BULK_DIR/$TAG.log"

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
  while [ -f "$BULK_DIR/$TAG.pid" ]; do
    sleep 120
    local n
    n="$(find "$BULK_DIR/db" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
    if [ "$((n - last))" -ge 500 ]; then
      local ts
      ts="$(date -u +%Y%m%d%H%M%S)"
      echo "$(date -u +%FT%TZ) $TAG: incremental snapshot at $n signature files -> $TAG-manifest-$ts.txt" >> "$LOG"
      find "$BULK_DIR/db" -maxdepth 1 -name '*.json' -newer "$ROUND2_DIST/.last-snapshot" 2>/dev/null > "$ROUND2_DIST/$TAG-manifest-$ts.txt" || \
        find "$BULK_DIR/db" -maxdepth 1 -name '*.json' > "$ROUND2_DIST/$TAG-manifest-$ts.txt"
      touch "$ROUND2_DIST/.last-snapshot"
      echo "{\"generatedAt\":\"$(date -u +%FT%TZ)\",\"signatureFilesOnDisk\":$n}" > "$ROUND2_DIST/$TAG-progress.json"
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
    echo "ERROR: slot pools not set up yet - run 'run.sh setup' first ($TAG reuses round 1's scaffolds)." >&2
    exit 1
  fi

  echo $$ > "$BULK_DIR/$TAG.pid"
  build_job_list > "$BULK_DIR/$TAG-jobs.tsv"
  local total
  total="$(wc -l < "$BULK_DIR/$TAG-jobs.tsv" | tr -d ' ')"
  echo "$(date -u +%FT%TZ) $TAG starting: $total total (package, version, hbcVersion) candidate jobs (build-one.mjs skips whatever is already on disk), parallelism=$PARALLELISM" | tee -a "$LOG"

  export HBC2JS_BULK_DIR="$BULK_DIR"
  export HBC2JS_REPO_DIR="$REPO_DIR"
  export HBC2JS_BULK_SLOTS="$SLOTS"

  assemble_watcher &
  local watcher_pid=$!
  trap 'rm -f "$BULK_DIR/$TAG.pid"; kill "$watcher_pid" 2>/dev/null || true' EXIT

  xargs -a "$BULK_DIR/$TAG-jobs.tsv" -d '\n' -P "$PARALLELISM" -I{} bash "$SCRIPT_DIR/worker.sh" {}

  echo "$(date -u +%FT%TZ) $TAG: job list exhausted" | tee -a "$LOG"
}

status() {
  local total db_files running
  total=0
  [ -f "$BULK_DIR/$TAG-jobs.tsv" ] && total="$(wc -l < "$BULK_DIR/$TAG-jobs.tsv" | tr -d ' ')"
  db_files="$(find "$BULK_DIR/db" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
  running="NOT running"
  if [ -f "$BULK_DIR/$TAG.pid" ] && kill -0 "$(cat "$BULK_DIR/$TAG.pid")" 2>/dev/null; then
    running="running (pid $(cat "$BULK_DIR/$TAG.pid"))"
  fi
  echo "D17c $TAG bulk build: $running | candidate jobs=$total | signature files on disk (shared db/, all rounds)=$db_files"
  echo "note: log/results.jsonl (ok/fail counts) is shared across every round - use $TAG-jobs.tsv membership to isolate this round's own results if needed."
  tail -5 "$LOG" 2>/dev/null
}

cmd="${1:-}"
case "$cmd" in
  start) start ;;
  status) status ;;
  *) echo "usage: $0 {start|status}" >&2; exit 1 ;;
esac
