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
| P-01 | 2026-08-31 | Opus 5 (spec batch 3: M5 rungs 14–18) | `docs/LOWERING-CATALOGUE.md` row 21 + `docs/lowering/template-literals.md` | Row 21 says template literals are **not** a distinct idiom ("the same `LoadConstString`/`Add`/`AddS` chain a hand-written `'a' + b + 'c'` would produce") and that any recovery pass is therefore a style heuristic. That is true only at `-O0`. At `-O` — what `build.sh` and every shipped bundle use — a template literal with ≥1 substitution lowers to `CallBuiltin HermesInternal.concat`, and ordinary `+` concatenation never does. | Decompiled at v94 **and** v99: `43-template-literals` emits `Reflect.apply(__hbc_HermesInternal.concat, C0, [S0, C1, …])` for every template; `01-if-else-chain` (`'check(' + n + ')'`), `44-tagged-templates` (`'cooked[' + i + ']=' + …`) and `51-default-params` (`'Hello, ' + name + '!'`) emit `+` chains and **zero** `concat` calls. The discriminator is semantic, not stylistic: `concat` is ToString per piece, `+` is ToPrimitive(default) — Hermes cannot emit `concat` for a `+` without being wrong. | `alternative` — spec `docs/specs/passes/14-template-literal.md` is written against the `-O` idiom (§0 states the correction), drops the `+`-chain heuristic row 21 warned about entirely, and makes rewriting row 21 to `✅ verified` a precondition of the pass landing (PL-06 refuses `catalogue: [21]` today). | open | |
| P-02 | 2026-08-31 | Opus 5 (spec batch 3: M5 rungs 14–18) | `docs/specs/passes/00-LADDER.md` §1.2, rows `optional-chain` and `destructure` | The ladder describes both rungs as `Expr` rewrites — `optional-chain`: "`x == null ? undefined : x.y` … → `x?.y`"; §3.2 gives sugar rungs "the `Expr` sub-tree of one statement". Neither idiom survives to stage B as an expression. Both arrive as **runs of statements** containing nested `if`/`else` with an empty consequent, writing a shared result register. A rung restricted to one `Expr` sub-tree matches nothing. | `48-optional-chaining-nullish` at v94/v99 emits `r6 = undefined; if (r13 == r4) {} else { r14 = r13.profile; r6 = undefined; if (r14 == r4) {} else { r6 = r14.name; } }` — never a `cond`. `37-destructuring-array` at v99 emits a `__hbc_iterBegin`/`__hbc_iterNext`/`__hbc_iterClose` statement run with done-flag registers, plus `__pc`/`__exc` at top level. | `alternative` — specs 16 and 18 are written as statement-run rewrites (site = one statement list, match a contiguous run, replace with one assignment / one `init`), which the stage-B driver's list granularity already supports; §3.2's "or a prologue statement run" clause is read as covering this. Ladder §1.2 and §3.2 wording should be corrected. | open | |
