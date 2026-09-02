# 2026-09-02 — classify barrel-file boundary (P-10) — Sonnet, lean
Tokens 138k · tool calls 117 · green.

Confirmed per-module moduleOwnership (hash-matched, confirmed-tier) now overrides classify.ts's heuristic in segregate bucketing — a package barrel/index that fooled the app-vocabulary signal now files under node_modules/<pkg>/. react-navigation-example: module 1122 (@react-navigation/native barrel) → node_modules; whole-bundle 428 modules moved src/unclassified → node_modules (829/726/227 → 1257/345/180). Pins corrected 4→3 nav / 54→50 screens (documented). OSS recall 6.1→9.1%; precision artifact documented. P-10 resolved.
