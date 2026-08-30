#!/usr/bin/env bash
# tools/pkgsig/bulk/refingerprint-worker.sh — runs ONE build-one.mjs
# --refingerprint job (D17c fix, docs/PACKAGE-SIGNATURES.md §6.4: re-derive
# an already-built signature with foundation subtraction applied, from a
# cached .hbc when one exists, else a full rebuild). Identical to
# worker.sh's slot-claiming/hygiene logic (same lock files, same scaffold
# slots) so it is safe to run concurrently with a live `run.sh start` -
# they share the exact same flock semaphore over $BULK_DIR/locks/, so the
# two never touch the same scaffold slot at once. Logs to
# log/refingerprint-results.jsonl, never results.jsonl, so `run.sh status`
# and `run.sh refingerprint-status` stay independently readable.
#
# Invoked as: refingerprint-worker.sh "<pkg>\t<version>\t<hbcVersion>"  (one
# line from run.sh's refingerprint-jobs.tsv)
set -uo pipefail

BULK_DIR="${HBC2JS_BULK_DIR:-$HOME/hbc2js-bulk}"
REPO_DIR="${HBC2JS_REPO_DIR:-$HOME/hbc2js}"
N="${HBC2JS_BULK_SLOTS:-16}"

LINE="$1"
IFS=$'\t' read -r PKG VER HBC <<< "$LINE"

log_result() {
  local json="$1"
  printf '%s\n' "$json" >> "$BULK_DIR/log/refingerprint-results.jsonl"
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

# --- claim a free slot (flock-based semaphore, SAME lock files as worker.sh) ---
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
  LOCKFILE="$BULK_DIR/locks/${FAMILY}-1.lock"
  exec 200>"$LOCKFILE"
  flock 200
  SLOT=1
fi

SCAFFOLD="$BULK_DIR/slots/${FAMILY}-${SLOT}"

OUT="$(node "$REPO_DIR/tools/pkgsig/bulk/build-one.mjs" "$PKG" "$VER" "$HBC" "$SCAFFOLD" "$HERMESC" "$BULK_DIR/db" --refingerprint 2>>"$BULK_DIR/log/${FAMILY}-${SLOT}.err")"
RC=$?

exec 200>&-   # release the slot

if [ -n "$OUT" ]; then
  log_result "$OUT"
else
  log_result "{\"package\":\"$PKG\",\"version\":\"$VER\",\"hbcVersion\":$HBC,\"ok\":false,\"reason\":\"build-one.mjs produced no output (exit $RC)\"}"
fi

exit 0   # never fail the xargs pipeline itself - failures are recorded, not fatal
