#!/usr/bin/env bash
# tools/pkgsig/bulk/round2b-runner.sh — D17c bulk signature build, round 2b.
#
# Unattended chain for the deb box: (1) node tools/pkgsig/bulk/candidates.mjs
# --registry (npm-registry-driven candidate list, docs/DEPS.md "Round 2b"),
# then (2) on success, tools/pkgsig/bulk/continue-bulk.sh start with
# HBC2JS_BULK_ROUND_TAG=round2b (namespaced log/pid/jobs/dist paths, so
# round 2b can run alongside/after round 2 without colliding - see
# continue-bulk.sh's own header). Both steps are individually resumable
# (candidates.mjs caches every search/downloads/package-doc fetch to
# ~/hbc2js-bulk/registry-cache.json; continue-bulk.sh skips whatever
# build-one.mjs already finds on disk) so killing and re-running this
# script picks up wherever it left off - including widening --top (see
# HBC2JS_ROUND2B_TOP below) to cover more packages later.
#
# Run detached, e.g. from the Mac: `ssh -f deb 'setsid bash
# ~/hbc2js-bulk/round2b-runner.sh < /dev/null > /dev/null 2>&1'` (setsid is
# required - a plain `nohup ... &` over a non-interactive ssh command can
# still die when the ssh session's channel closes, since the backgrounded
# job isn't in its own session; `ssh -f` + `setsid` together fully detach
# both the local ssh client and the remote process tree).
#
# Env overrides: HBC2JS_ROUND2B_TOP (default 500 - the first proof-of-
# pipeline slice; widen to 3000 for the full run per docs/DEPS.md "Round
# 2b" / QUEUE.md's round 2b bullet), HBC2JS_ROUND2B_CONCURRENCY (default
# 8, registry-fetch politeness cap - unrelated to continue-bulk.sh's own
# build parallelism), HBC2JS_BULK_ROUND2_PARALLELISM (continue-bulk.sh's
# own var, default 16 here - deliberately above round 2's 12 default per
# this task's brief).
set -uo pipefail
cd ~/hbc2js
export PATH="$HOME/.local/share/fnm:$PATH"
eval "$(fnm env)"
TOP="${HBC2JS_ROUND2B_TOP:-500}"
CONCURRENCY="${HBC2JS_ROUND2B_CONCURRENCY:-8}"
export HBC2JS_BULK_ROUND2_PARALLELISM="${HBC2JS_BULK_ROUND2_PARALLELISM:-16}"
LOG=~/hbc2js-bulk/round2b-autostart.log
echo "$(date -u +%FT%TZ) round2b-runner starting (top=$TOP concurrency=$CONCURRENCY)" >> "$LOG"
fnm exec --using 22 -- node tools/pkgsig/bulk/candidates.mjs --registry --top "$TOP" --concurrency "$CONCURRENCY" > ~/hbc2js-bulk/candidates-registry-gen.out 2>&1
rc=$?
echo "$(date -u +%FT%TZ) candidates.mjs registry gen exit=$rc" >> "$LOG"
if [ "$rc" -ne 0 ]; then
  echo "$(date -u +%FT%TZ) round2b-runner: candidates.mjs failed, not starting continue-bulk.sh" >> "$LOG"
  exit 1
fi
export HBC2JS_BULK_ROUND_TAG=round2b
fnm exec --using 22 -- bash tools/pkgsig/bulk/continue-bulk.sh start >> ~/hbc2js-bulk/round2b.out 2>&1
echo "$(date -u +%FT%TZ) round2b continue-bulk.sh start exit=$?" >> "$LOG"
