# Pushback ledger — agents disputing a spec, brief or decision

An implementation or design agent that believes its spec/brief is **wrong,
unsafe, or in conflict with a decision** (`docs/DECISIONS.md`) must not work
around it silently. It records the dispute here, commits the row, and says
`PUSHBACK P-nn` in its report. The overseer triages every open row each tick:

- **overseer** answers when the resolution is obvious;
- **Fred** decides when it is a design/priority call;
- a **short checker agent** verifies when it is a factual claim about bytecode
  or semantics (verdict: valid / invalid + why).

The resolution is written back into the spec's "Review responses" section
(the spec stays the single source of truth) and the row is closed here.
Never delete rows.

Meanwhile the agent does one of: `stopped` (default when the whole deliverable
depends on it), `as-specced` (implemented the spec as written, flagged), or
`alternative` (implemented a clearly-marked alternative — say which in the
commit message). Prefer `stopped` over guessing on anything semantic (D14).

| Id | Date | Agent (model, task) | Spec / doc | Claim | Evidence | Meanwhile | Status | Resolution |
|----|------|---------------------|------------|-------|----------|-----------|--------|------------|
| P-01 | 2026-08-31 | Sonnet 5 (var-naming, M5 rung R5) | `docs/specs/passes/07-var-naming.md` §1 example + §8 fixture list | The spec's §1 before/after example claims `r11` (04-for-loop-basic's outer-loop induction var) clears the §4.1 reuse gate and is renamed to `i`, and §8 lists "nested-loop induction vars (i/j)" as an expected red→green outcome for the `04-for-loop-basic` target fixture. In the actual compiled v94 output (all earlier stage-A/B rungs applied, dumped via `npm run cli`), `r11` is *not* single-role: besides the first loop's init/update, it is later reassigned `r11 = print` (a call-target alias), reused as a do-while accumulator step, and reused again as the innermost nested loop's own induction var — four unrelated roles in one frame. Per §4.1's own rule ("every def matches exactly one of the two recognised whole-frame roles"), a register with defs spanning loop-induction *and* plain-alias *and* accumulator roles must be refused as `reuse-conflict`, not renamed. Likewise `r1` (second loop's counter) is separately reused as a constant (`r1 = 5`) and a `print` alias. So the letter of §4.1 and the illustrative example/§8 claim contradict each other on this exact fixture: implementing the gate as specified means `04-for-loop-basic`'s loop counters keep `rN`, only the single-def `new Array(0)` register (`r15`→`arr`) is renamed there. | `npm run cli -- tests/fixtures/constructs/04-for-loop-basic/v94.hbc` (all default passes; var-naming not yet registered) shows `r11`/`r1`/`r14` each reassigned to `print`, loop counters, and (for `r11`) an accumulator step, all in the same function frame. | as-specced | open | |
