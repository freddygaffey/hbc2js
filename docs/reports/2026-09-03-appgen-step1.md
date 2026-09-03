# 2026-09-03 — app-gen fuzzer step 1: generator + first real triple (lean Sonnet)

121k tokens, 70 calls, ~14 min, on budget. Gate 1924 tests (flake verified green isolated).

- Seeded deterministic app generator: router axis (stack / tabs / weird = routes mapped from a barrel-re-exported array), dep-loading axis (static / lazyRequire / reexport barrel), 2-4 seeded screens; manifest-fingerprint dedup; §2.4 bounds implemented (15GB preflight, 24-triple cap w/ eviction, every-3rd held-out flag).
- ONE REAL TRIPLE built locally (RN 0.73.11 -> HBC 96, no Gradle, workspace deleted): tabs+lazyRequire, 4 screens.
- FIRST GROUND-TRUTH FINDING (untuned, unfixed — the instrument works): 619 modules, navigator DETECTED, screens 0/4 detected, 2 named src modules. Lazy-require screen loading defeats current screen detection — exactly Fred's flagged edge case, now measured.
- Next increments: Expo, RAM bundles, obfuscation, version rotation (94/98/99), sampling quotas, appgen-benchmark, held-out eval.
