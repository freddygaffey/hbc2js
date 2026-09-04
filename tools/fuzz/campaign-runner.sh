#!/usr/bin/env bash
# tools/fuzz/campaign-runner.sh — docs/specs/09-fuzzing.md §1.5(ii): the
# first construct-fuzz campaign (>= 10,000 programs per traced version).
# Thin, resumable, chunked wrapper around tools/fuzz/construct-fuzz.mjs.
# Intended to run detached on deb (or any machine with the target versions'
# hermesc/VMs installed) — see docs/fuzz/CONSTRUCT-FUZZER.md's "Campaign 1"
# section for status/resume/kill one-liners.
#
# WORK-RANGE seeds only (§1.5.iv): each chunk's seed-base is
# campaign-seed-base + programs-already-done, so the full campaign for a
# version stays within [seed-base, seed-base + target) — well inside the
# 80,000-wide work range and never touching the frozen evaluation range
# (seed-base + 900,000 .. + 902,000), which is reserved for campaign close
# and run exactly once by a separate, explicit `--eval` invocation of the
# driver itself, never by this script.
#
# Resumable: state/v<version>.count records programs completed for that
# version. Interrupt any time — state only advances after a chunk's report
# is written, so a killed mid-chunk run loses at most one chunk's work, not
# already-recorded progress, and no seed is ever re-run.
#
# Usage:
#   tools/fuzz/campaign-runner.sh [--campaign-dir DIR] [--seed-base N]
#       [--versions 84,94,96,99] [--chunk-size 500] [--target 10000]
#       [--wall-cap-min 480]
#
# Status:  see docs/fuzz/CONSTRUCT-FUZZER.md
# Resume:  re-run with the same --campaign-dir/--seed-base (defaults below
#          are the campaign-1 values; safe to omit on every resume).
# Kill:    pkill -f campaign-runner.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CAMPAIGN_DIR="${HOME}/hbc2js-fuzz/campaign1"
SEED_BASE=1000000
VERSIONS="84,94,96,99"
CHUNK_SIZE=500
TARGET=10000
WALL_CAP_MIN=480   # whole-runner safety net; each driver invocation is also
                    # bounded by its own hard cap (spec §1.6, 2h/run)
MIN_FREE_GB=15
MAX_FINDS="${MAX_FINDS:-200}"  # per-campaign raw-find cap (env-overridable for long deb runs) (spec §1.4 step 3), enforced
                     # here since finds are relocated out of the repo tree

while [ $# -gt 0 ]; do
  case "$1" in
    --campaign-dir) CAMPAIGN_DIR="$2"; shift 2 ;;
    --seed-base) SEED_BASE="$2"; shift 2 ;;
    --versions) VERSIONS="$2"; shift 2 ;;
    --chunk-size) CHUNK_SIZE="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --wall-cap-min) WALL_CAP_MIN="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$CAMPAIGN_DIR"/reports "$CAMPAIGN_DIR"/finds "$CAMPAIGN_DIR"/state "$CAMPAIGN_DIR"/logs

free_gb() { df -Pk "$CAMPAIGN_DIR" | tail -1 | awk '{print int($4/1024/1024)}'; }

FREE_GB=$(free_gb)
if [ "$FREE_GB" -lt "$MIN_FREE_GB" ]; then
  echo "preflight: ${FREE_GB}GB free < ${MIN_FREE_GB}GB minimum, refusing to start" >&2
  exit 1
fi

START_TS=$(date +%s)
IFS=',' read -ra VERSION_LIST <<< "$VERSIONS"

cd "$REPO_ROOT"
export PATH="$HOME/.local/share/fnm:$PATH"

state_file() { echo "$CAMPAIGN_DIR/state/v$1.count"; }
completed_count() {
  local f; f=$(state_file "$1")
  if [ -f "$f" ]; then cat "$f"; else echo 0; fi
}

relocate_finds() {
  # Move any new raw finds out of the repo tree (reports/ is gitignored and
  # machine-local, §4.2) into the campaign dir, then enforce the campaign's
  # own MAX_FINDS cap (oldest evicted first) — the driver's own 200-per-run
  # cap resets every invocation once we empty its source directory, so the
  # cross-chunk cap has to live here.
  if [ -d "$REPO_ROOT/reports/fuzz/finds" ]; then
    find "$REPO_ROOT/reports/fuzz/finds" -type f -exec mv {} "$CAMPAIGN_DIR/finds/" \; 2>/dev/null || true
  fi
  local count
  count=$(find "$CAMPAIGN_DIR/finds" -type f | wc -l | tr -d ' ')
  if [ "$count" -gt "$MAX_FINDS" ]; then
    ls -t "$CAMPAIGN_DIR/finds" | tail -n "+$((MAX_FINDS + 1))" | \
      while IFS= read -r old; do rm -f "$CAMPAIGN_DIR/finds/$old"; done
  fi
}

for VERSION in "${VERSION_LIST[@]}"; do
  DONE=$(completed_count "$VERSION")
  while [ "$DONE" -lt "$TARGET" ]; do
    NOW=$(date +%s)
    ELAPSED_MIN=$(( (NOW - START_TS) / 60 ))
    if [ "$ELAPSED_MIN" -ge "$WALL_CAP_MIN" ]; then
      echo "wall-clock cap (${WALL_CAP_MIN}min) reached, stopping (resumable)" >&2
      exit 0
    fi
    FREE_GB=$(free_gb)
    if [ "$FREE_GB" -lt "$MIN_FREE_GB" ]; then
      echo "disk cap (${MIN_FREE_GB}GB free) reached, stopping (resumable)" >&2
      exit 1
    fi

    REMAINING=$((TARGET - DONE))
    THIS_CHUNK=$CHUNK_SIZE
    if [ "$THIS_CHUNK" -gt "$REMAINING" ]; then THIS_CHUNK=$REMAINING; fi
    CHUNK_SEED_BASE=$((SEED_BASE + DONE))
    CHUNK_IDX=$((DONE / CHUNK_SIZE))
    OUT="$CAMPAIGN_DIR/reports/construct-v${VERSION}-chunk$(printf '%05d' "$CHUNK_IDX").json"
    LOG="$CAMPAIGN_DIR/logs/v${VERSION}-chunk$(printf '%05d' "$CHUNK_IDX").log"

    echo "$(date -u +%FT%TZ) v${VERSION} chunk ${CHUNK_IDX} seed-base=${CHUNK_SEED_BASE} count=${THIS_CHUNK}" >&2
    if fnm exec --using 22 -- node tools/fuzz/construct-fuzz.mjs \
        --versions "$VERSION" --count "$THIS_CHUNK" --seed-base "$CHUNK_SEED_BASE" \
        --out "$OUT" > "$LOG" 2>&1; then
      DONE=$((DONE + THIS_CHUNK))
      echo "$DONE" > "$(state_file "$VERSION")"
    else
      echo "chunk v${VERSION}#${CHUNK_IDX} FAILED, see $LOG; state not advanced, re-run to retry" >&2
      exit 1
    fi

    relocate_finds
  done
  echo "v${VERSION}: target ${TARGET} reached" >&2
done

echo "campaign chunk pass complete ($(date -u +%FT%TZ))" >&2
