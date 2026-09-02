# 2026-09-02 — fuzzing spec, testing decisions 1-4 (lean Fable)

61k tokens, 21 tool calls, ~17 min, green first try (one load-flake rerun). Commit 4f39240.

- docs/specs/09-fuzzing.md: construct-level fuzzer (§1) + app-gen fuzzer (§2) + blind held-out (salted-hash list, evaluator-only reads, isolation test T6) + fuzz-matrix/1 report schema consumed by scoreboard + corpus harness.
- Decision-8 quadruples: A) divergences/1k-programs per traced version, exit ≤5/1k on final 2k of a ≥10k campaign, disjoint seed-range held-out. B) naming/classification/structure scores per triple via reused oss-benchmark scorers; ≥10 map-bearing triples over ≥3 HBC versions × 3 bundlers, ≥80% build success; every-3rd-triple held out, ≥85% of tuned score.
- Cost bounds: A ≤30 min/500-progs×5-versions on deb, ≤50MB persistent; B deb-only, preflight refuses <15GB free, ≤6GB transient, 24-triple store cap w/ eviction. v98 = roundtrip-only mode (no trace VM), never blended.
- Shipped pre-impl acceptance test: tests/fuzz/spec-consistency.test.ts (8/8; glob-form node --test pinned).
- Open questions (1-3) handed to the Fable reviewer gate. No pushbacks.
