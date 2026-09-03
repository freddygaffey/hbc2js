# 2026-09-04 — P2.5 spec review gate (lean Fable) — APPROVED

40k tokens, 7 calls, ~3 min. Commit 7023f34.

- R1 truth-map non-injectivity fixed (ambiguous keys -> reported excluded bucket; target 1 stays meaningful); removed-check detector confirmed non-tautological; R3 orphan re-proposal loop closed (rebindOf-aware liveness); R4 diff-dir explicitly outside spec-10 hash coverage w/ step-3 amendment.
- Rulings: no reg-level rebind carve-out (and the proposed opcSeqHash key was unsound — drops register operands); thresholds pre-registered w/ binding retune rule; recall-first confirmed.
- Impl step 0 cleared: tests/diff red harness + guard-pair fixture. Step 7 (appgen mutation flags) sequenced AFTER appgen increment 2 lands.
