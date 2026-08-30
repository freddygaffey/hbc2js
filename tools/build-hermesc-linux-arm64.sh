#!/usr/bin/env bash
# tools/build-hermesc-linux-arm64.sh — build `hermesc` (+ `hbcdump`) from
# source for Linux arm64 (aarch64), where no prebuilt binary is published
# (see docs/TOOLCHAIN.md: `tools/get-hermesc.sh` only has linux64 (x86_64)
# and macOS-universal binaries upstream; there is currently no publicly
# published Linux arm64 `hermesc` in any npm package it fetches from).
#
# This is a *separate* script from tools/build-hermes-vm.sh, not an
# extension of it: build-hermes-vm.sh builds the full VM/CLI (`hermes` +
# `hermesc` + `hbcdump`) for the two versions used as the D14 equivalence
# oracle (94, 99), on whatever arch it happens to run on, into
# tools/hermes-vm/vNN/bin/. This script instead builds only `hermesc` (+
# `hbcdump`, cheap once hermesc's objects exist) for arm64 specifically,
# gated hard on that architecture, into tools/hermesc/vNN/ — the exact
# layout tools/get-hermesc.sh already uses, so tests/support/hermesc.ts's
# `findHermesc` needs no arch-awareness: whichever script actually produced
# a working binary at that path, downstream code just finds it.
#
# Usage:
#   tools/build-hermesc-linux-arm64.sh --check [<84|94|96|98|99|all>]
#       Validate prerequisites (OS, arch, git, cmake, a generator, a C++14
#       compiler, python3, disk space) and report the per-version commit-pin
#       table. Does NOT clone or build anything. Safe to run on any host,
#       including non-arm64 (that's the point: CI or a maintainer on a
#       different machine can sanity-check the script without arm64
#       hardware). Exits 0 only if every check passes for a real build to
#       proceed on THIS host; a wrong-arch host always exits non-zero here.
#
#   tools/build-hermesc-linux-arm64.sh [--clean] <94|96|99|all>
#       Actually build. Refuses loudly (no cross-compiling, no silent
#       fallback to whatever arch the host actually is) unless run ON Linux
#       arm64 with every prerequisite present. `--clean` wipes this
#       script's own source/build trees first (see OUT_ROOT below) so a
#       stale configure doesn't linger.
#
#   84 and 98 are refused with a specific "not pinned" error: unlike 94, 96
#   and 99 (see docs/TOOLCHAIN.md "Hermes VM (source build)" and its "v96:
#   opcode table and layout" section), no facebook/hermes commit has been
#   derived for those two HBC versions in this repo yet. Guessing a commit
#   would silently risk shipping the wrong opcode table; pin one first using
#   the same derivation method (the version's `.hermesversion`/npm tarball
#   trail), then add it to the table below.
#
# Output: tools/hermesc/v<N>/{hermesc,hbcdump} (gitignored, same as
# tools/get-hermesc.sh's output — this script's job is to make that
# directory populated on arm64 too). Source clones and build trees live in
# tools/hermesc-build/src-<N>/ and tools/hermesc-build/build-<N>/ (also
# gitignored) and are left in place for an incremental rebuild; --clean
# wipes them first.
#
# Requires: git, cmake (>=3.13), a C++14 compiler (gcc or clang), python3,
# and a Ninja or Make generator. On Debian/Ubuntu arm64:
#   apt install cmake git ninja-build python3 zip libreadline-dev g++
# ICU: install libicu-dev, or pass -DICU_ROOT if your distro doesn't put it
# on the default search path (same note as tools/build-hermes-vm.sh).
#
# *** UNVERIFIED ON REAL ARM64 HARDWARE ***. This container is x86_64: the
# build/clone/configure path below has never actually run here (running it
# would just hit the arch gate and exit). Only `--check`'s prerequisite
# report has been exercised. See docs/TOOLCHAIN.md "Linux arm64 hermesc"
# for the exact commands a maintainer with real arm64 hardware must run to
# verify it, and what to report back.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_ROOT="$SCRIPT_DIR/hermesc-build"
HERMESC_ROOT="$SCRIPT_DIR/hermesc"
REPO_URL="${HERMES_REPO_URL:-https://github.com/facebook/hermes.git}"

# --- version -> commit pin table -----------------------------------------
# Same commits (and same derivation) as docs/TOOLCHAIN.md / tools/build-hermes-vm.sh
# for 94/99, and docs/TOOLCHAIN.md's "v96: opcode table and layout" section for 96.
version_94_sha="3815fec63d1a6667ca3195160d6e12fee6a0d8d5"
version_96_sha="644c8be78af1eae7c138fa4093fb87f0f4f8db85"
version_99_sha="913d31acd10aff31e0856657c9c566c3e72bd24a"
SUPPORTED_VERSIONS="94 96 99"
UNPINNED_VERSIONS="84 98"

usage() {
  echo "Usage: $0 --check [<84|94|96|98|99|all>]" >&2
  echo "       $0 [--clean] <94|96|99|all>" >&2
  exit 1
}

is_supported() {
  local v="$1" s
  for s in $SUPPORTED_VERSIONS; do [ "$s" = "$v" ] && return 0; done
  return 1
}

is_unpinned() {
  local v="$1" s
  for s in $UNPINNED_VERSIONS; do [ "$s" = "$v" ] && return 0; done
  return 1
}

# --- --check ---------------------------------------------------------------
run_check() {
  local requested="${1:-all}"
  local ok=1

  echo "=== tools/build-hermesc-linux-arm64.sh --check ==="

  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  if [ "$os" = "Linux" ]; then
    echo "OS: Linux (ok)"
  else
    echo "OS: $os (FAIL — this script only targets Linux; on macOS, hermesc already ships a universal x86_64+arm64 binary via tools/get-hermesc.sh)"
    ok=0
  fi

  case "$arch" in
    aarch64|arm64)
      echo "Arch: $arch (ok)"
      ;;
    *)
      echo "Arch: $arch (FAIL — this script only builds for Linux arm64/aarch64; it is not a cross-compiler. Run it ON arm64 hardware. See docs/TOOLCHAIN.md \"Linux arm64 hermesc\".)"
      ok=0
      ;;
  esac

  if command -v git >/dev/null 2>&1; then
    echo "git: found ($(command -v git)) (ok)"
  else
    echo "git: NOT FOUND (FAIL — apt install git)"
    ok=0
  fi

  if command -v cmake >/dev/null 2>&1; then
    echo "cmake: found, $(cmake --version | head -1) (ok)"
  else
    echo "cmake: NOT FOUND (FAIL — apt install cmake, need >= 3.13)"
    ok=0
  fi

  if command -v ninja >/dev/null 2>&1; then
    echo "generator: ninja found (ok)"
  elif command -v make >/dev/null 2>&1; then
    echo "generator: make found, ninja not found — will fall back to Unix Makefiles (slower, but ok)"
  else
    echo "generator: NEITHER ninja NOR make found (FAIL — apt install ninja-build (preferred) or make)"
    ok=0
  fi

  if command -v c++ >/dev/null 2>&1 || command -v g++ >/dev/null 2>&1 || command -v clang++ >/dev/null 2>&1; then
    local cxx
    cxx="$(command -v c++ || command -v g++ || command -v clang++)"
    echo "C++ compiler: found ($cxx) (ok)"
  else
    echo "C++ compiler: NOT FOUND (FAIL — apt install g++ (or clang))"
    ok=0
  fi

  if command -v python3 >/dev/null 2>&1; then
    echo "python3: found ($(command -v python3)) (ok)"
  else
    echo "python3: NOT FOUND (FAIL — apt install python3)"
    ok=0
  fi

  local free_kb free_gb
  free_kb="$(df -Pk "$SCRIPT_DIR" 2>/dev/null | awk 'NR==2 {print $4}')"
  if [ -n "${free_kb:-}" ]; then
    free_gb=$((free_kb / 1024 / 1024))
    if [ "$free_gb" -ge 5 ]; then
      echo "disk space: ${free_gb}GB free at $SCRIPT_DIR (ok, need >= 5GB for a source clone + build tree)"
    else
      echo "disk space: ${free_gb}GB free at $SCRIPT_DIR (FAIL — need >= 5GB for a source clone + build tree)"
      ok=0
    fi
  else
    echo "disk space: could not determine free space at $SCRIPT_DIR (FAIL — df -Pk did not report usable output)"
    ok=0
  fi

  echo
  echo "Version pin table:"
  local v
  for v in 84 94 96 98 99; do
    if is_supported "$v"; then
      local sha_var="version_${v}_sha"
      echo "  v$v: pinned, commit ${!sha_var}"
    else
      echo "  v$v: NOT PINNED — no facebook/hermes commit derived yet for this HBC version; see docs/TOOLCHAIN.md"
    fi
  done

  if [ "$requested" != "all" ]; then
    echo
    if is_supported "$requested"; then
      echo "Requested version v$requested: pinned, buildable once the checks above are ok"
    else
      echo "Requested version v$requested: NOT PINNED (FAIL — cannot build this version yet)"
      ok=0
    fi
  fi

  echo
  if [ "$ok" = "1" ]; then
    echo "RESULT: ok — this host can build hermesc for: $SUPPORTED_VERSIONS"
    return 0
  else
    echo "RESULT: FAIL — see the FAIL line(s) above; nothing was built (--check never builds)"
    return 1
  fi
}

# --- actual build ------------------------------------------------------------
build_one() {
  local version="$1" clean="$2"

  if is_unpinned "$version"; then
    echo "ERROR: no facebook/hermes commit is pinned for v$version yet (see docs/TOOLCHAIN.md \"Linux arm64 hermesc\" and \"v96: opcode table and layout\" for the derivation method used for 94/96/99). Refusing to guess a commit — pin one first, add it to this script's table, then re-run." >&2
    return 1
  fi
  if ! is_supported "$version"; then
    echo "ERROR: unknown version '$version' (supported: $SUPPORTED_VERSIONS; also refused-with-reason: $UNPINNED_VERSIONS)" >&2
    return 1
  fi

  local sha_var="version_${version}_sha"
  local sha="${!sha_var}"
  local src_dir="$OUT_ROOT/src-$version"
  local build_dir="$OUT_ROOT/build-$version"
  local out_dir="$HERMESC_ROOT/v$version"

  if [ "$clean" = "1" ]; then
    echo "Removing $src_dir and $build_dir" >&2
    rm -rf "$src_dir" "$build_dir"
  fi

  mkdir -p "$OUT_ROOT"

  if [ -d "$src_dir/.git" ]; then
    echo "Reusing existing clone at $src_dir" >&2
  else
    echo "Cloning $REPO_URL (blob-filtered) -> $src_dir" >&2
    git clone --filter=blob:none "$REPO_URL" "$src_dir"
  fi
  ( cd "$src_dir" && git checkout --detach "$sha" )

  # v94-only CMP0026 compat patch — same fix and same reasoning as
  # tools/build-hermes-vm.sh (CMake >= 4.0 removed CMP0026-OLD outright; the
  # only consumer is HERMES_BUILD_APPLE_DSYM, which we never enable).
  if [ "$version" = "94" ]; then
    local cmakelists="$src_dir/CMakeLists.txt"
    if grep -q '^  cmake_policy(SET CMP0026 OLD)$' "$cmakelists"; then
      echo "Patching $cmakelists: dropping CMP0026-OLD (removed in CMake >= 4.0; only needed for HERMES_BUILD_APPLE_DSYM, which is off)" >&2
      python3 - "$cmakelists" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path) as f:
    text = f.read()
needle = "if (POLICY CMP0026)\n  cmake_policy(SET CMP0026 OLD)\nendif()\n"
replacement = (
    "# NOTE(tools/build-hermesc-linux-arm64.sh): CMP0026 OLD is removed outright by\n"
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

  local generator="Ninja"
  if ! command -v ninja >/dev/null 2>&1; then
    echo "ninja not found; falling back to Unix Makefiles (slower)." >&2
    generator="Unix Makefiles"
  fi

  echo "Configuring ($generator, Release) -> $build_dir" >&2
  cmake -S "$src_dir" -B "$build_dir" -G "$generator" -DCMAKE_BUILD_TYPE=Release

  local jobs
  jobs="${HERMES_BUILD_JOBS:-$( (command -v nproc >/dev/null 2>&1 && nproc) || echo 4)}"
  echo "Building hermesc hbcdump with -j$jobs" >&2
  cmake --build "$build_dir" --target hermesc hbcdump -j "$jobs"

  mkdir -p "$out_dir"
  local tool found
  for tool in hermesc hbcdump; do
    found="$build_dir/bin/$tool"
    if [ -f "$found" ]; then
      cp "$found" "$out_dir/$tool"
      chmod +x "$out_dir/$tool"
    else
      echo "WARNING: expected binary not found at $found" >&2
    fi
  done

  echo "Done. v$version binaries in $out_dir:" >&2
  ls -la "$out_dir" >&2
  echo "Verify: $out_dir/hermesc --version" >&2
}

main() {
  local check=0 clean=0 version=""
  for arg in "$@"; do
    case "$arg" in
      --check) check=1 ;;
      --clean) clean=1 ;;
      84|94|96|98|99|all) version="$arg" ;;
      -h|--help) usage ;;
      *) usage ;;
    esac
  done

  if [ "$check" = "1" ]; then
    run_check "${version:-all}"
    return $?
  fi

  [ -n "$version" ] || usage

  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  if [ "$os" != "Linux" ]; then
    echo "ERROR: this script only builds for Linux (detected $os). On macOS, tools/get-hermesc.sh already provides a universal x86_64+arm64 hermesc — nothing to build here." >&2
    exit 1
  fi
  case "$arch" in
    aarch64|arm64) ;;
    *)
      echo "ERROR: this script only builds for Linux arm64/aarch64 (detected $arch). It is not a cross-compiler and will not silently build for the host's actual architecture. Run it ON arm64 hardware, or use tools/get-hermesc.sh for a prebuilt x86_64 binary. See docs/TOOLCHAIN.md \"Linux arm64 hermesc\"." >&2
      exit 1
      ;;
  esac

  if [ "$version" = "all" ]; then
    local v
    for v in $SUPPORTED_VERSIONS; do
      build_one "$v" "$clean"
    done
  else
    build_one "$version" "$clean"
  fi
}

main "$@"
