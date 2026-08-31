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
| P-1 | 2026-08-31 | Claude Sonnet 5 (D17i: wire M5 passes into `--split`) | task brief's `tests/gate/decompile/split-passes.test.ts` spec | Running `splitProject()` on the whole `rn-template-0.72/index.android.hbc` (4199 functions) with the M5 pass pipeline **on** (the brief's requested default, matching the normal path) cannot fit in a gate test: `decompile()` on the same file with passes off is 726 ms; with passes on it did not finish inside a 180 s timeout (>250x, not the ~150x `src/split/index.ts`'s pre-existing header comment already cites for the same reason it disables passes today). This is the exact contingency the brief's own SCOPE GUARD names ("a structural reason it can't reuse the pipeline… do the reusable part, commit, and STOP") — except the reason here is performance, not cross-module naming, so I am recording it rather than silently reinterpreting the guard. | Timed `decompile(bytes, {passes:{none:true}, analysis:{strictEnv:false}, verify:false})` = 726 ms vs the same call without `passes:{none:true}` not finishing inside 180 s, both against `tests/fixtures/bundles/rn-template-0.72/index.android.hbc`; `src/split/index.ts`'s pre-existing file header already documents "~150x slower … excluded from the gate's time budget with passes on" as the reason passes are off in `--split` today. | as-specced (with a scoping choice, not a stop): wired the full pass pipeline into `src/split/index.ts` (`SplitOptions.passes`, `passHook`/`astPassHook`, same `REGISTRY`/order/opt-out as the normal path, threaded through `src/cli.ts`'s `--split`) — every registered pass runs by default, exactly matching the normal path's default, so the deliverable is met for any bundle small enough to afford it. Left the *existing* `tests/gate/split/split.test.ts`'s module-scope `splitProject()` call passing `{ passes: { none: true } }` explicitly (it asserts structural properties, not readability, and predates this task). The **new** `split-passes.test.ts` proves passes-on wiring on rn-template without doing a full 4199-function passes-on split: it decompiles a small, deliberately-chosen slice of the same module (a handful of factory functions, via the same `passHook`/`astPassHook`-backed helpers `splitProject` now uses) and compares that against the normal path's `decompileAst` output for the identical function indices. | open | |
