# 2026-09-02 — deps cluster: nearest-by-date resolver — Sonnet, lean
Tokens 68k · tool calls 49 · green first try.

`nearestVersionByDateDetailed` filters to stable semver first, falls back to the nearest prerelease only when a package has no stable release, and flags it (`usedPrereleaseVersion`) through `--confirm` progress/results. Two regression tests; BUGS row → Resolved (Open 18 / Resolved 17).
