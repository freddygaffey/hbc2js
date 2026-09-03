# 2026-09-03 — P2.3 spec review gate (lean Fable) — APPROVED

68k tokens, 13 tool calls, ~6 min. Commit 55b9a74 (temp-index commit, clean of concurrent agent's staged work).

- R1: refuted-never-resurrected was cache-driven — a pattern-set bump would resurrect every refuted finding; now store-driven off the active refuted slot record.
- R2 LICENSING CATCH: trufflehog v3 is AGPL-3.0 (spec claimed permissive) — copying regexes from either oracle ruleset is now a stated violation; per-pattern vendor-doc/RFC citations enforced by T1.
- R3: patternId pinned as finding-slot discriminator (spec-11 slot key alone would cross-supersede same-sid findings).
- Rulings: taxonomy EXTENDED w/ six surface categories (ratified; spec-11 edit rides impl step 3); FP bars accepted as ratchets + R4 (red T8 fires promote-and-replace, never a quiet threshold tweak); indexer-as-analyst-of-record OK (fixed versioned mapping); step-3 stall = wait, or a shim meeting append-only/evidence/final-shapes — raw JSONL appends forbidden.
- Impl step 0 cleared: patterns.ts + T1-T8 verbatim + seeded ground-truth fixture.
