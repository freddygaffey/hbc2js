#!/usr/bin/env bash
# tools/build-hermes-vm.sh — build a `hermes` VM/CLI binary (plus `hermesc` and
# `hbcdump`) from source, from the exact facebook/hermes commit that emits a
# given HBC bytecode version, for versions the prebuilt npm route can't reach
# (see docs/TOOLCHAIN.md: prebuilt hermes-engine-cli's VM tops out at HBC 89;
# react-native/hermes-compiler ship hermesc only, no VM).
#
# Usage:
#   tools/build-hermes-vm.sh <94|99>
#
# Output: tools/hermes-vm/v<N>/bin/{hermes,hermesc,hbcdump} (gitignored).
# Source clones and build trees live in tools/hermes-vm/src-<N>/ and
# tools/hermes-vm/build-<N>/ (also gitignored) and are left in place so a
# rebuild after a source patch is incremental; pass --clean to wipe them first.
#
# Requires: git, cmake (>=3.13), a C++14 compiler (Xcode CLT on macOS, gcc/clang
# on Linux), python3, and a Ninja or Make generator. On macOS via Homebrew:
#   brew install cmake ninja
# On Ubuntu/Debian:
#   apt install cmake git ninja-build python3 zip libreadline-dev
# ICU: not needed on macOS (Hermes uses Apple's built-in ICU); on Linux install
# libicu-dev or pass -DICU_ROOT if your distro doesn't have it on the default
# search path.
#
# Commit selection (see docs/HBC-FORMAT.md and docs/TOOLCHAIN.md for the full
# derivation):
#   94 -> 3815fec63d1a6667ca3195160d6e12fee6a0d8d5
#         "main" (classic Hermes) lineage, frozen at BYTECODE_VERSION=96 but
#         this specific commit is the one react-native@0.72.17 vendors
#         (packages/react-native/sdks/.hermesversion:
#          hermes-2024-04-29-RNv0.72.14-3815fec63d1a6667ca3195160d6e12fee6a0d8d5).
#         tools/get-hermesc.sh 94's hermesc reproduces
#         tests/fixtures/hermes-dec-sample/v94.hbc byte-identically, so this is
#         a confirmed match, not a guess.
#   99 -> 913d31acd10aff31e0856657c9c566c3e72bd24a
#         "static_h" (Static Hermes) lineage. This is "Revert bytecode version
#         to 99" (2026-03-05), the commit that inserts NewTypedObjectWithBuffer
#         at opcode index 4, producing the 220-opcode table that both
#         v99.hbc and v99-public.hbc decode against (docs/HBC-FORMAT.md sec 0
#         and sec 11.2). hermes-compiler@260318099.0.x's npm tarball carries no
#         embedded commit hash (checked: package.json has no gitHead, binary
#         strings have none either) and its output is confirmed NOT
#         byte-identical to either v99 fixture (docs/TOOLCHAIN.md) — different
#         builtin table and dead-code emission — so there is no way to pin the
#         *exact* commit any more precisely than "on the 220-opcode side of
#         913d31acd10a"; this is the earliest such commit, which is the most
#         specific defensible choice.
#
# Build scope: only the `hermes` (VM+CLI, executes .hbc, also compiles), and
# `hermesc` + `hbcdump` (both cheap once `hermes`'s object files exist, since
# they share almost all the same libraries) are built — not the full test
# suite, not node-hermes, not the Apple framework/dSYM machinery, not fuzzers.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_ROOT="$SCRIPT_DIR/hermes-vm"
REPO_URL="${HERMES_REPO_URL:-https://github.com/facebook/hermes.git}"

version_94_sha="3815fec63d1a6667ca3195160d6e12fee6a0d8d5"
version_99_sha="913d31acd10aff31e0856657c9c566c3e72bd24a"

usage() {
  echo "Usage: $0 [--clean] <94|99>" >&2
  exit 1
}

CLEAN=0
VERSION=""
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    94|99) VERSION="$arg" ;;
    *) usage ;;
  esac
done
[ -n "$VERSION" ] || usage

sha_var="version_${VERSION}_sha"
SHA="${!sha_var}"

SRC_DIR="$OUT_ROOT/src-$VERSION"
BUILD_DIR="$OUT_ROOT/build-$VERSION"
BIN_DIR="$OUT_ROOT/v$VERSION/bin"

if [ "$CLEAN" = "1" ]; then
  echo "Removing $SRC_DIR and $BUILD_DIR" >&2
  rm -rf "$SRC_DIR" "$BUILD_DIR"
fi

mkdir -p "$OUT_ROOT"

# --- fetch / checkout ---------------------------------------------------
if [ -d "$SRC_DIR/.git" ]; then
  echo "Reusing existing clone at $SRC_DIR" >&2
else
  echo "Cloning $REPO_URL (blob-filtered) -> $SRC_DIR" >&2
  git clone --filter=blob:none "$REPO_URL" "$SRC_DIR"
fi
(
  cd "$SRC_DIR"
  git checkout --detach "$SHA"
)

# --- CMake 4.x compat patch (v94 only) ----------------------------------
# facebook/hermes's top-level CMakeLists.txt at the v94 commit sets
# CMP0026 to OLD (needed only for HERMES_BUILD_APPLE_DSYM, which we never
# enable). CMake >= 4.0 removed CMP0026-OLD support outright (not just
# gated behind a policy-version minimum), so cmake_policy(SET CMP0026 OLD)
# hard-errors at configure time on a modern CMake. Comment the block out;
# it is dead code for our build (dSYM bundling is off by default and we
# don't turn it on). The v99/static_h CMakeLists.txt has already dropped
# this block upstream, so no patch is needed there.
if [ "$VERSION" = "94" ]; then
  cmakelists="$SRC_DIR/CMakeLists.txt"
  if grep -q '^  cmake_policy(SET CMP0026 OLD)$' "$cmakelists"; then
    echo "Patching $cmakelists: dropping CMP0026-OLD (removed in CMake >= 4.0; only needed for HERMES_BUILD_APPLE_DSYM, which is off)" >&2
    python3 - "$cmakelists" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path) as f:
    text = f.read()
needle = "if (POLICY CMP0026)\n  cmake_policy(SET CMP0026 OLD)\nendif()\n"
replacement = (
    "# NOTE(tools/build-hermes-vm.sh): CMP0026 OLD is removed outright by\n"
    "# CMake >= 4.0. It only mattered for HERMES_BUILD_APPLE_DSYM (off here).\n"
    "# if (POLICY CMP0026)\n"
    "#   cmake_policy(SET CMP0026 OLD)\n"
    "# endif()\n"
)
if needle in text:
    text = text.replace(needle, replacement, 1)
    with open(path, "w") as f:
        f.write(text)
PYEOF
  fi
fi

# --- configure -----------------------------------------------------------
GENERATOR="Ninja"
if ! command -v ninja >/dev/null 2>&1; then
  echo "ninja not found; falling back to Unix Makefiles (slower). Install ninja for faster builds:" >&2
  echo "  macOS: brew install ninja" >&2
  echo "  Linux: apt install ninja-build" >&2
  GENERATOR="Unix Makefiles"
fi

echo "Configuring ($GENERATOR, Release) -> $BUILD_DIR" >&2
# GCC >= 13 (Ubuntu 24.04) no longer transitively includes <cstdint>; the v94
# commit's lib/Support/SHA1.h uses uint8_t without it. Force-include it on
# Linux (harmless where not needed; clang/macOS builds are unaffected).
EXTRA_CXX_FLAGS=""
if [ "$(uname -s)" = "Linux" ]; then EXTRA_CXX_FLAGS="-include cstdint"; fi
cmake -S "$SRC_DIR" -B "$BUILD_DIR" -G "$GENERATOR" -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS="$EXTRA_CXX_FLAGS"

# --- build ---------------------------------------------------------------
JOBS="${HERMES_BUILD_JOBS:-$( (command -v nproc >/dev/null 2>&1 && nproc) || sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
echo "Building hermes hermesc hbcdump with -j$JOBS" >&2
cmake --build "$BUILD_DIR" --target hermes hermesc hbcdump -j "$JOBS"

# --- install into tools/hermes-vm/vNN/bin/ -------------------------------
mkdir -p "$BIN_DIR"
for tool in hermes hermesc hbcdump; do
  found="$BUILD_DIR/bin/$tool"
  if [ -f "$found" ]; then
    cp "$found" "$BIN_DIR/$tool"
  else
    echo "WARNING: expected binary not found at $found" >&2
  fi
done

echo "Done. Binaries in $BIN_DIR:" >&2
ls -la "$BIN_DIR"
echo
echo "Verify version:" >&2
echo "  $BIN_DIR/hermes -version" >&2
