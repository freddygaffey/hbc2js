#!/usr/bin/env bash
# tools/get-hermesc.sh — fetch prebuilt `hermesc` (Hermes bytecode compiler) binaries
# for this host, without building Hermes from source and without committing binaries
# to the repo.
#
# Usage:
#   tools/get-hermesc.sh [84|94|99|all]   (default: all)
#
# Binaries land in tools/hermesc/v<N>/hermesc (gitignored). See docs/TOOLCHAIN.md
# for the version table, provenance, and known caveats (esp. v99 not being
# byte-identical to tests/fixtures/v99.hbc).
#
# Requires: npm (to fetch the tarball — no `npm install`, just `npm pack`), tar.
# Works on macOS (Darwin, any arch — the packages ship universal x86_64+arm64
# Mach-O binaries) and Linux x86_64. There is currently no publicly published
# hermesc build for Linux arm64; see docs/TOOLCHAIN.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_ROOT="${HERMESC_OUT_DIR:-$SCRIPT_DIR/hermesc}"

# --- version table -----------------------------------------------------
# hbc_version : npm_package@version : path-to-binary-inside-tarball-per-OS-dir
# The "OS dir" token is substituted with osx-bin / linux64-bin below.
version_84_pkg="hermes-engine-cli@0.8.1"
version_84_bindir="package/OSDIR_TOKEN"

version_94_pkg="react-native@0.72.17"
version_94_bindir="package/sdks/hermesc/OSDIR_TOKEN"

version_99_pkg="hermes-compiler@260318099.0.1"
version_99_bindir="package/hermesc/OSDIR_TOKEN"

usage() {
  echo "Usage: $0 [84|94|99|all]" >&2
  exit 1
}

detect_osdir() {
  case "$(uname -s)" in
    Darwin) echo "osx-bin" ;;
    Linux)
      if [ "$(uname -m)" != "x86_64" ]; then
        echo "WARNING: no published hermesc build for Linux $(uname -m); only linux64 (x86_64) binaries exist upstream. Trying anyway under emulation may work if you have qemu/box64, otherwise this will fail." >&2
      fi
      echo "linux64-bin"
      ;;
    *)
      echo "ERROR: unsupported OS $(uname -s). Only macOS and Linux are supported." >&2
      exit 1
      ;;
  esac
}

fetch_one() {
  local hbc_version="$1" pkgspec="$2" bindir_template="$3"
  local osdir bindir out_dir tmp_dir tarball

  osdir="$(detect_osdir)"
  bindir="${bindir_template//OSDIR_TOKEN/$osdir}"
  out_dir="$OUT_ROOT/v${hbc_version}"

  if [ -x "$out_dir/hermesc" ]; then
    echo "v${hbc_version}: already present at $out_dir/hermesc (skipping; delete it to re-fetch)"
    return 0
  fi

  echo "v${hbc_version}: fetching $pkgspec (${osdir})..."
  tmp_dir="$(mktemp -d)"

  ( cd "$tmp_dir" && npm pack "$pkgspec" --silent >/dev/null )
  tarball="$(ls "$tmp_dir"/*.tgz | head -1)"
  if [ -z "$tarball" ]; then
    echo "ERROR: npm pack produced no tarball for $pkgspec" >&2
    rm -rf "$tmp_dir"
    return 1
  fi

  mkdir -p "$out_dir"

  # Extract every binary that lives alongside hermesc in this package's bin dir
  # (hermes-engine-cli also ships hbcdump/hdb/hermes, which are handy for
  # disassembly and are documented in docs/TOOLCHAIN.md).
  local extracted=0
  for f in "$bindir/hermesc" "$bindir/hbcdump" "$bindir/hdb" "$bindir/hermes" "$bindir/hermes-lit"; do
    if tar tzf "$tarball" "$f" >/dev/null 2>&1; then
      tar xzf "$tarball" -C "$tmp_dir" "$f"
      cp "$tmp_dir/$f" "$out_dir/$(basename "$f")"
      chmod +x "$out_dir/$(basename "$f")"
      extracted=$((extracted + 1))
    fi
  done

  if [ "$extracted" -eq 0 ]; then
    echo "ERROR: could not find $bindir/hermesc inside $pkgspec's tarball. The package layout may have changed — check docs/TOOLCHAIN.md and update this script's *_bindir variable." >&2
    rm -rf "$tmp_dir"
    return 1
  fi

  rm -rf "$tmp_dir"
  echo "v${hbc_version}: installed $(ls "$out_dir")"
  "$out_dir/hermesc" --version 2>&1 | grep -E 'HBC bytecode version|Hermes release version' | sed 's/^/  /'
}

main() {
  local requested="${1:-all}"
  case "$requested" in
    84) fetch_one 84 "$version_84_pkg" "$version_84_bindir" ;;
    94) fetch_one 94 "$version_94_pkg" "$version_94_bindir" ;;
    99) fetch_one 99 "$version_99_pkg" "$version_99_bindir" ;;
    all)
      fetch_one 84 "$version_84_pkg" "$version_84_bindir"
      fetch_one 94 "$version_94_pkg" "$version_94_bindir"
      fetch_one 99 "$version_99_pkg" "$version_99_bindir"
      ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
}

main "$@"
