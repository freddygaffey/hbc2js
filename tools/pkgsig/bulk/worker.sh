#!/usr/bin/env bash
# tools/pkgsig/bulk/worker.sh — runs ONE build-one.mjs job, having first
# claimed an exclusive Metro-scaffold "slot" (of HBC2JS_BULK_SLOTS, default
# 16, pre-cloned by run.sh's setup step into
# $HBC2JS_BULK_DIR/slots/{72,87}-<N>) so concurrent jobs never race on the
# same scaffold's node_modules/entry-file/etc. Family 72 (RN 0.72.17)
# serves HBC 94/96; family 87 (RN 0.87.1) serves HBC 98/99 - see
# docs/PACKAGE-SIGNATURES.md §5.5's "recompile identical Metro/Babel output
# with a different hermesc" shortcut for why one scaffold per RN era covers
# two HBC versions each.
#
# Invoked as: worker.sh "<pkg>\t<version>\t<hbcVersion>"  (one line from the
# job list, tab-separated - see run.sh)
set -uo pipefail

BULK_DIR="${HBC2JS_BULK_DIR:-$HOME/hbc2js-bulk}"
REPO_DIR="${HBC2JS_REPO_DIR:-$HOME/hbc2js}"
N="${HBC2JS_BULK_SLOTS:-16}"

LINE="$1"
IFS=$'\t' read -r PKG VER HBC <<< "$LINE"

log_result() {
  local json="$1"
  printf '%s\n' "$json" >> "$BULK_DIR/log/results.jsonl"
}

case "$HBC" in
  94|96) FAMILY=72 ;;
  98|99) FAMILY=87 ;;
  *)
    log_result "{\"package\":\"$PKG\",\"version\":\"$VER\",\"hbcVersion\":\"$HBC\",\"ok\":false,\"reason\":\"unknown hbc version\"}"
    exit 1
    ;;
esac

HERMESC="$REPO_DIR/tools/hermesc/v$HBC/hermesc"

# --- claim a free slot (mkdir-free flock-based semaphore) -----------------
SLOT=""
for i in $(seq 1 "$N"); do
  LOCKFILE="$BULK_DIR/locks/${FAMILY}-${i}.lock"
  exec 200>"$LOCKFILE"
  if flock -n 200; then
    SLOT="$i"
    break
  fi
  exec 200>&-
done

if [ -z "$SLOT" ]; then
  # Should not happen (slot pool size == parallelism), but never drop a job:
  # block on slot 1 rather than fail outright.
  LOCKFILE="$BULK_DIR/locks/${FAMILY}-1.lock"
  exec 200>"$LOCKFILE"
  flock 200
  SLOT=1
fi

SCAFFOLD="$BULK_DIR/slots/${FAMILY}-${SLOT}"

# Periodic slot hygiene: build-one.mjs's `npm uninstall --legacy-peer-deps`
# after each job is best-effort, not guaranteed to fully prune every
# transitive dependency a package uniquely pulled in - over many thousands
# of jobs sharing 16 long-lived slots, that residue could accumulate.
# Every 200 uses of a given slot (a per-slot counter file, safe to
# read-increment-write with no lock of its own since we already hold this
# slot's exclusive flock), wipe it back to a pristine copy of its scaffold
# before running this job.
COUNT_FILE="$BULK_DIR/locks/${FAMILY}-${SLOT}.count"
USE_COUNT=0
[ -f "$COUNT_FILE" ] && USE_COUNT="$(cat "$COUNT_FILE" 2>/dev/null || echo 0)"
USE_COUNT=$((USE_COUNT + 1))
echo "$USE_COUNT" > "$COUNT_FILE"
if (( USE_COUNT % 200 == 0 )); then
  PRISTINE="$BULK_DIR/ScaffoldRN${FAMILY}"
  if [ -d "$PRISTINE" ]; then
    rm -rf "$SCAFFOLD"
    cp -r "$PRISTINE" "$SCAFFOLD"
    echo "$(date -u +%FT%TZ) reset slot ${FAMILY}-${SLOT} after $USE_COUNT uses" >> "$BULK_DIR/log/run.log"
  fi
fi

OUT="$(node "$REPO_DIR/tools/pkgsig/bulk/build-one.mjs" "$PKG" "$VER" "$HBC" "$SCAFFOLD" "$HERMESC" "$BULK_DIR/db" 2>>"$BULK_DIR/log/${FAMILY}-${SLOT}.err")"
RC=$?

exec 200>&-   # release the slot

if [ -n "$OUT" ]; then
  log_result "$OUT"
else
  log_result "{\"package\":\"$PKG\",\"version\":\"$VER\",\"hbcVersion\":$HBC,\"ok\":false,\"reason\":\"build-one.mjs produced no output (exit $RC)\"}"
fi

exit 0   # never fail the xargs pipeline itself - failures are recorded, not fatal
