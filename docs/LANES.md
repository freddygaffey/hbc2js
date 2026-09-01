# Lanes — how work is allocated (Fred's direction, 2026-09-01)

"A perfect ladder and none of this other stuff is still not the working product."
The product is: bytecode → a `src/` tree of readable (or at least AI-parsable)
JavaScript with library code stripped out and app code segregated into real
files — views, pages, navigators, stores separable. Three lanes, all always
moving; no lane starves another.

| Lane | Goal | Current step | Next |
|------|------|--------------|------|
| **A — Evidence (CI + E2E)** | Numbers you can trust; safe development | E2E tier 1 corpus round-trip ratchet (`tools/e2e/`) | CI app-metrics job; stage-3 feasibility (`docs/e2e/STAGE3-FEASIBILITY.md`); RN-web boot loop (tier 2); device (tier 3) |
| **B — Product (deps → segregation)** | Strip libraries, segregate app code into files/views | `hbc2js deps` + classify (corpus-free custom-vs-library) | fix `deps` on 12 MB bundles (Service NSW >10 min); wire M5 passes onto `--split`; **segregation spec** (D17i stage 3: name modules, detect screens/navigators/stores, emit `src/` + `node_modules/` tree) |
| **C — Ladder** | Readability rungs (`docs/specs/passes/00-LADDER.md`) | 11 live, jsx-recover in flight | reg-split (P-6) → real names; batch-3 sugar; batch 4 |

## Slot rule
- Two slots: one is always lane A or B; the other rotates A→B→C. With 3–4 lean slots: one per lane + one floating.
- Rotation: a lane waits at most one cycle. The orchestrator decides; Fred gives direction.
- Every agent: `lean` type, explicit ~100k budget, full gate before commit, regression test per fix.
