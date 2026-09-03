# 2026-09-04 — sigdb schema review gate (lean Fable) — APPROVED

49k tokens, 8 calls, ~4 min. Commit 1fe4623 (spec 15 §12 + in-place hardenings).

- Rulings 1-5: node:sqlite (engines floor moot, already >=22.18); strings cap 64/fn x 1KiB + strings_truncated flag, full-set hash preserved; keep name in intern key v1; variant free-text matcher-blind v1; ambiguity constant stays in match.ts, hash_stats holds counts never verdicts.
- REAL CATCH: T4 tiered-export unsound (top-1000 AND <=1GiB infeasible by construction) -> amended: 1GiB hard, version-thin (latest per semver-major per hbc) before dropping packages, floor 500 names, report achieved.
- Hardenings applied: 24-hex hash validation, import_log atomic with rows, is_baseline_file in UNIQUE key, intern-hit backfill, --verify uses independent read path (DB never validates itself). Field completeness column-by-column vs sigdb-types.ts: nothing lost.
- Import step cleared to launch.
