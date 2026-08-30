#!/usr/bin/env bash
# tools/pkgsig/bulk/assemble.sh — packages whatever D17c bulk-build signature
# files currently exist in $HBC2JS_BULK_DIR/db into a distributable archive
# plus a package/version/hbcVersion index, without touching the repo (the
# repo carries only the index and these build scripts - docs/DECISIONS.md
# D17c).
#
# Safe to run repeatedly WHILE tools/pkgsig/bulk/run.sh's build keeps writing
# into the same db/ directory (D17c's DB is append-only, files are never
# rewritten in place after their one writeSignature() call, so a snapshot
# taken here is always a valid subset of the final DB - "-partial" in the
# output name is a reminder of that, not a correctness caveat). Any file
# that happens to be mid-write when this runs is simply skipped (its JSON
# won't parse yet) and picked up next time this script is run.
#
# Usage:
#   tools/pkgsig/bulk/assemble.sh                    # dist/sigdb-<date>-partial.tar.zst + index.json
#   tools/pkgsig/bulk/assemble.sh --gzip              # .tar.gz instead (no zstd on host)
#   tools/pkgsig/bulk/assemble.sh --fixed-only        # only entries carrying
#                                                     # `bulkBuildFixVersion: 1`
#                                                     # (the D17c foundation-
#                                                     # subtraction fix,
#                                                     # docs/PACKAGE-SIGNATURES.md
#                                                     # §6.4/§6.1) - a
#                                                     # pre-fix, unsubtracted
#                                                     # file is silently
#                                                     # excluded rather than
#                                                     # shipped. Flags
#                                                     # combine, e.g.
#                                                     # `--fixed-only --gzip`.
#                                                     # Output archive is
#                                                     # named `sigdb-<date>-
#                                                     # fixed.tar.zst` instead
#                                                     # of `-partial` so it's
#                                                     # never confused with an
#                                                     # unsubtracted snapshot.
#
# Env overrides: HBC2JS_BULK_DIR (default ~/hbc2js-bulk).
set -uo pipefail

BULK_DIR="${HBC2JS_BULK_DIR:-$HOME/hbc2js-bulk}"
DB_DIR="$BULK_DIR/db"
DIST_DIR="$BULK_DIR/dist"
DATE_TAG="$(date -u +%Y%m%d)"

FORMAT="zstd"
FIXED_ONLY="0"
for arg in "$@"; do
  case "$arg" in
    --gzip) FORMAT="gzip" ;;
    --fixed-only) FIXED_ONLY="1" ;;
  esac
done
if [ "$FORMAT" = "zstd" ] && ! command -v zstd >/dev/null 2>&1; then
  echo "no zstd on this host, falling back to gzip" >&2
  FORMAT="gzip"
fi

if [ ! -d "$DB_DIR" ]; then
  echo "ERROR: $DB_DIR does not exist (has run.sh been run at least once?)" >&2
  exit 1
fi

mkdir -p "$DIST_DIR"

WORK="$(mktemp -d "$DIST_DIR/.assemble.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

INDEX_TMP="$WORK/index.json"
FILELIST_TMP="$WORK/files.txt"

# --- pass 1: enumerate + hash + build the index -----------------------
# One node process rather than N `sha256sum` processes - both faster and
# gives us a single consistent read per file (open once, hash the bytes we
# just parsed as JSON, rather than re-reading for a separate sha256sum).
# Any file that fails to read or parse as JSON is a file run.sh's workers
# are still writing (writeSignature() is a plain writeFileSync, not a
# temp+rename) - skip it, it'll be included next time this script runs.
node - "$DB_DIR" "$INDEX_TMP" "$FILELIST_TMP" "$FIXED_ONLY" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const [, , dbDir, indexOut, filelistOut, fixedOnlyArg] = process.argv;
const fixedOnly = fixedOnlyArg === "1";

const entries = fs.readdirSync(dbDir, { withFileTypes: true });
const packages = {};
let totalFiles = 0;
let totalBytes = 0;
let skipped = 0;
let excludedUnfixed = 0;
const goodFiles = [];

for (const e of entries) {
  if (!e.isFile()) continue;
  if (!e.name.endsWith(".json")) continue;
  if (e.name === "index.json") continue; // src/deps/db.ts's own flat manifest, not a signature file
  const full = path.join(dbDir, e.name);
  let raw;
  try {
    raw = fs.readFileSync(full);
  } catch {
    skipped++;
    continue;
  }
  let doc;
  try {
    doc = JSON.parse(raw.toString("utf8"));
  } catch {
    skipped++; // mid-write file - not atomic, expected under a live build
    continue;
  }
  if (!doc || typeof doc !== "object" || !doc.package || !doc.version || !doc.hbcVersion) {
    skipped++;
    continue;
  }
  // --fixed-only: exclude any entry predating the D17c foundation-
  // subtraction fix (docs/PACKAGE-SIGNATURES.md §6.4) - identified by the
  // absence of `bulkBuildFixVersion` (set unconditionally by the patched
  // build-one.mjs, see its own header comment). Not a "skip" (not
  // malformed/mid-write) - counted separately so index.json can tell the
  // two apart.
  if (fixedOnly && doc.bulkBuildFixVersion !== 1) {
    excludedUnfixed++;
    continue;
  }
  const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
  const pkg = doc.package;
  const ver = String(doc.version);
  const hbc = String(doc.hbcVersion);
  packages[pkg] ??= {};
  packages[pkg][ver] ??= {};
  packages[pkg][ver][hbc] = {
    file: e.name,
    size: raw.length,
    sha256,
    totalFunctions: doc.totalFunctions ?? null,
    rawFunctionCount: doc.rawFunctionCount ?? null,
    moduleCount: Array.isArray(doc.modules) ? doc.modules.length : null,
    toolchainBaseline: !!doc.toolchainBaseline,
    subtractedBaselines: doc.subtractedBaselines ?? [],
    provenance: doc.provenance ?? null,
  };
  totalFiles++;
  totalBytes += raw.length;
  goodFiles.push(e.name);
}

const index = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  source: "D17c bulk build (tools/pkgsig/bulk/run.sh) on host " + require("node:os").hostname(),
  fixedOnly,
  totalFiles,
  totalBytes,
  skippedUnreadableOrPartial: skipped,
  excludedUnfixed,
  packageCount: Object.keys(packages).length,
  packages,
};

fs.writeFileSync(indexOut, JSON.stringify(index));
fs.writeFileSync(filelistOut, goodFiles.join("\n") + (goodFiles.length ? "\n" : ""));
console.error(`indexed ${totalFiles} files (${totalBytes} bytes), skipped ${skipped} (mid-write or malformed)${fixedOnly ? `, excluded ${excludedUnfixed} pre-fix (unsubtracted) files` : ""}`);
NODE

N_FILES="$(wc -l < "$FILELIST_TMP" | tr -d ' ')"
if [ "$N_FILES" -eq 0 ]; then
  echo "ERROR: no readable signature files found in $DB_DIR - nothing to assemble." >&2
  exit 1
fi

# --fixed-only archives are named "-fixed" instead of "-partial" so they can
# never be confused with an earlier unsubtracted snapshot (docs/PACKAGE-
# SIGNATURES.md §6.4's "do not fetch/layer this partial archive" warning);
# their index.json is likewise kept under its own name, never overwriting
# the plain index.json/-partial archive a concurrent unfiltered assemble.sh
# run might be producing.
TAG="partial"
if [ "$FIXED_ONLY" = "1" ]; then TAG="fixed"; fi

# Final index.json lands in dist/ regardless of archive format, unversioned
# (always "current $TAG index") plus a dated copy for provenance.
cp "$INDEX_TMP" "$DIST_DIR/index-$TAG.json"
cp "$INDEX_TMP" "$DIST_DIR/index-$TAG-$DATE_TAG.json"
# also embed a copy inside the archive itself, so the archive is
# self-describing even if index.json is fetched separately and goes stale
STAGE="$WORK/stage"
mkdir -p "$STAGE"
cp "$INDEX_TMP" "$STAGE/index.json"

# --- pass 2: tar the snapshot -------------------------------------------
# Chained -C: file list is resolved against $DB_DIR, then the explicit
# "index.json" arg after the second -C is resolved against $STAGE. GNU tar
# (this host is Linux) supports multiple -C options in one invocation.
if [ "$FORMAT" = "zstd" ]; then
  ARCHIVE="$DIST_DIR/sigdb-${DATE_TAG}-${TAG}.tar.zst"
  ARCHIVE_TMP="$WORK/out.tar.zst"
  tar --ignore-failed-read -cf - -C "$DB_DIR" -T "$FILELIST_TMP" -C "$STAGE" index.json \
    | zstd -T0 -q -o "$ARCHIVE_TMP"
else
  ARCHIVE="$DIST_DIR/sigdb-${DATE_TAG}-${TAG}.tar.gz"
  ARCHIVE_TMP="$WORK/out.tar.gz"
  tar --ignore-failed-read -czf "$ARCHIVE_TMP" -C "$DB_DIR" -T "$FILELIST_TMP" -C "$STAGE" index.json
fi

# Atomic-ish publish: same filesystem, so mv is a rename, not a copy - a
# concurrent fetcher never sees a half-written archive at the final name.
mv "$ARCHIVE_TMP" "$ARCHIVE"

ARCHIVE_SIZE="$(du -h "$ARCHIVE" | cut -f1)"
DB_RAW_SIZE="$(du -sh "$DB_DIR" | cut -f1)"

echo "assembled: $N_FILES signature files, $ARCHIVE ($ARCHIVE_SIZE compressed, $DB_RAW_SIZE raw db/), index: $DIST_DIR/index-$TAG.json"
