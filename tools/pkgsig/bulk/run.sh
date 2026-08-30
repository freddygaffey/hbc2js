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
#   tools/pkgsig/bulk/run.sh setup          # one-time: clone N scaffold slots
#   tools/pkgsig/bulk/run.sh start          # run the build (foreground -
#                                           # launch under nohup/tmux yourself)
#   tools/pkgsig/bulk/run.sh status         # one-line-ish progress summary
#   tools/pkgsig/bulk/run.sh failures       # recent failure reasons
#   tools/pkgsig/bulk/run.sh baselines      # (re)generate the toolchain/
#                                           # foundation baselines (D17c fix,
#                                           # docs/PACKAGE-SIGNATURES.md §6.4)
#                                           # for both scaffolds x their HBC
#                                           # versions, from the scaffolds'
#                                           # OWN installed react/react-native/
#                                           # metro versions. Run this before
#                                           # `start`/`refingerprint` ever
#                                           # write a signature, and after any
#                                           # scaffold RN-version bump.
#   tools/pkgsig/bulk/run.sh refingerprint  # (foreground - launch under
#                                           # nohup/tmux yourself) re-derive
#                                           # every already-built signature
#                                           # that predates the D17c
#                                           # foundation-subtraction fix
#                                           # (missing `bulkBuildFixVersion`),
#                                           # from a cached compiled .hbc when
#                                           # one exists, else a full rebuild
#                                           # (see build-one.mjs's
#                                           # --refingerprint header comment).
#                                           # Safe to run alongside a live
#                                           # `start` - shares the same
#                                           # flock-based scaffold-slot
#                                           # semaphore, logs to
#                                           # log/refingerprint-results.jsonl
#                                           # (never results.jsonl), and only
#                                           # ever touches entries `start`'s
#                                           # job list has already finished
#                                           # (disjoint job sets at any
#                                           # snapshot - `start` only builds
#                                           # what ISN'T on disk yet,
#                                           # `refingerprint` only touches
#                                           # what IS). Resumable/idempotent:
#                                           # re-run to pick up whatever
#                                           # `start` finished since.
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

baselines() {
  if [ ! -d "$BULK_DIR/slots/72-1" ] || [ ! -d "$BULK_DIR/slots/87-1" ]; then
    echo "ERROR: slot pools not set up yet - run '$0 setup' first." >&2
    exit 1
  fi
  local rc=0
  # 72-1/87-1 (already-cloned, otherwise-idle-by-preference scaffold slots)
  # are used rather than the pristine ScaffoldRN72/87 - baselines are
  # regenerated rarely and this avoids a 4-way write race over the
  # *pristine* copy, which nothing else ever touches. IMPORTANT: these are
  # ALSO slot 1 of worker.sh's own live-build semaphore pool - claim the
  # SAME flock (locks/${FAMILY}-1.lock) worker.sh uses before touching a
  # slot, so this never races a concurrent `start`/`refingerprint` job over
  # the same node_modules/entry-file (measured: without this, a live build
  # sharing slot 72-1 produced a metro-cache ENOENT and an `npx` ETIMEDOUT).
  echo "Building baselines for RN 0.72.17 (HBC94, HBC96) from slots/72-1..."
  flock "$BULK_DIR/locks/72-1.lock" -c "node '$SCRIPT_DIR/build-baselines.mjs' 94 '$BULK_DIR/slots/72-1' '$REPO_DIR/tools/hermesc/v94/hermesc' '$BULK_DIR/db'" || rc=1
  flock "$BULK_DIR/locks/72-1.lock" -c "node '$SCRIPT_DIR/build-baselines.mjs' 96 '$BULK_DIR/slots/72-1' '$REPO_DIR/tools/hermesc/v96/hermesc' '$BULK_DIR/db'" || rc=1
  echo "Building baselines for RN 0.87.1 (HBC98, HBC99) from slots/87-1..."
  flock "$BULK_DIR/locks/87-1.lock" -c "node '$SCRIPT_DIR/build-baselines.mjs' 98 '$BULK_DIR/slots/87-1' '$REPO_DIR/tools/hermesc/v98/hermesc' '$BULK_DIR/db'" || rc=1
  flock "$BULK_DIR/locks/87-1.lock" -c "node '$SCRIPT_DIR/build-baselines.mjs' 99 '$BULK_DIR/slots/87-1' '$REPO_DIR/tools/hermesc/v99/hermesc' '$BULK_DIR/db'" || rc=1
  ls -la "$BULK_DIR/db/_baselines/"
  return $rc
}

build_refingerprint_job_list() {
  # Every db/*.json (excluding _baselines/ and index.json) that predates the
  # D17c foundation-subtraction fix (no `bulkBuildFixVersion` marker yet).
  # Resumable by construction: a file `refingerprint-worker.sh` already fixed
  # carries the marker and drops out of this list on the next call.
  node -e '
    const fs = require("fs");
    const path = require("path");
    const dbDir = process.argv[1];
    const lines = [];
    for (const name of fs.readdirSync(dbDir)) {
      if (!name.endsWith(".json") || name === "index.json") continue;
      const full = path.join(dbDir, name);
      if (!fs.statSync(full).isFile()) continue;
      let doc;
      try { doc = JSON.parse(fs.readFileSync(full, "utf8")); } catch { continue; } // mid-write, skip - picked up next call
      if (!doc || typeof doc !== "object") continue;
      if (doc.toolchainBaseline) continue; // baselines are rebuilt via `baselines`, never refingerprinted
      if (doc.bulkBuildFixVersion === 1) continue; // already fixed
      if (!doc.package || !doc.version || !doc.hbcVersion) continue;
      lines.push(`${doc.package}\t${doc.version}\t${doc.hbcVersion}`);
    }
    process.stdout.write(lines.join("\n") + (lines.length ? "\n" : ""));
  ' "$BULK_DIR/db"
}

refingerprint() {
  if [ ! -d "$BULK_DIR/db" ]; then
    echo "ERROR: $BULK_DIR/db does not exist (has run.sh start ever run?)." >&2
    exit 1
  fi
  if [ ! -d "$BULK_DIR/db/_baselines" ]; then
    echo "ERROR: $BULK_DIR/db/_baselines does not exist - run '$0 baselines' first." >&2
    exit 1
  fi

  echo $$ > "$BULK_DIR/refingerprint.pid"
  build_refingerprint_job_list > "$BULK_DIR/refingerprint-jobs.tsv"
  local total
  total="$(wc -l < "$BULK_DIR/refingerprint-jobs.tsv" | tr -d ' ')"
  echo "$(date -u +%FT%TZ) starting refingerprint: $total entries missing bulkBuildFixVersion, parallelism=$PARALLELISM" | tee -a "$BULK_DIR/log/refingerprint.log"

  export HBC2JS_BULK_DIR="$BULK_DIR"
  export HBC2JS_REPO_DIR="$REPO_DIR"
  export HBC2JS_BULK_SLOTS="$SLOTS"

  xargs -a "$BULK_DIR/refingerprint-jobs.tsv" -d '\n' -P "$PARALLELISM" -I{} bash "$SCRIPT_DIR/refingerprint-worker.sh" {}

  echo "$(date -u +%FT%TZ) run.sh refingerprint: job list exhausted" | tee -a "$BULK_DIR/log/refingerprint.log"
  rm -f "$BULK_DIR/refingerprint.pid"
}

refingerprint_status() {
  local total done_ok done_fail running
  total=0
  if [ -f "$BULK_DIR/refingerprint-jobs.tsv" ]; then total="$(wc -l < "$BULK_DIR/refingerprint-jobs.tsv" | tr -d ' ')"; fi
  done_ok=0; done_fail=0
  if [ -f "$BULK_DIR/log/refingerprint-results.jsonl" ]; then
    done_ok="$(grep -c '"ok":true' "$BULK_DIR/log/refingerprint-results.jsonl" 2>/dev/null)"; done_ok="${done_ok:-0}"
    done_fail="$(grep -c '"ok":false' "$BULK_DIR/log/refingerprint-results.jsonl" 2>/dev/null)"; done_fail="${done_fail:-0}"
  fi
  if [ -f "$BULK_DIR/refingerprint.pid" ] && kill -0 "$(cat "$BULK_DIR/refingerprint.pid")" 2>/dev/null; then
    running="running (pid $(cat "$BULK_DIR/refingerprint.pid"))"
  else
    running="NOT running"
  fi
  local processed=$((done_ok + done_fail))
  local pct="n/a"
  if [ "$total" -gt 0 ]; then pct="$(awk -v p="$processed" -v t="$total" 'BEGIN{printf "%.1f", 100*p/t}')"; fi
  echo "D17c refingerprint: $running | $processed/$total processed (${pct}%) | ok=$done_ok fail=$done_fail"
  if [ -f "$BULK_DIR/log/refingerprint-results.jsonl" ]; then
    echo "Last 3 results:"
    tail -3 "$BULK_DIR/log/refingerprint-results.jsonl"
  fi
}

case "$cmd" in
  setup) setup ;;
  start) start ;;
  status) status ;;
  failures) failures "$@" ;;
  baselines) baselines ;;
  refingerprint) refingerprint ;;
  refingerprint-status) refingerprint_status ;;
  *)
    echo "usage: $0 {setup|start|status|failures|baselines|refingerprint|refingerprint-status}" >&2
    exit 1
    ;;
esac
