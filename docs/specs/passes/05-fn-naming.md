# 05 — `fn-naming` (stage B, catalogue row **R4**)

Reading list: `docs/AGENT-BRIEF.md`, `src/passes/README.md`, this file. Depends
on `01-framework-fixes.md` (`ctx.module`, `ctx.fnBody`, `src/passes/ast.ts`);
runs after `expr-rebuild` and `global-access`.

## 1. Purpose

The emitter names every function-table entry `_fnN` and puts the real name in a
provenance comment, because the bytecode name is untrusted input and may
collide, shadow, or not be an identifier at all. When it *is* a safe, unused
identifier, use it. Pure alpha-renaming: no statement moves, no expression
changes shape.

Before — `19-var-hoisting/v94.hbc`, `fn#0 "global"`:

```js
function _fn1() {
  // fn#1 "demo"
  …
}
r2 = _fn1;
r0.demo = r2;
```

After (`expr-rebuild` has already folded `r2`):

```js
function demo() {
  // fn#1 "demo"
  …
}
globalThis.demo = demo;
```

## 2. Baseline shape

`src/emit/function.ts` emits each child as `{k:"func", name:"_fnN", params,
body:[{k:"comment", text:`fn#N "name"`}, …]}`, hoisted into the *parent*
function's body list, and every reference as `{k:"ident", name:"_fnN"}`
(`fnName(n)` in `src/emit/names.ts`). Inline children (`loopLocalEnvSlots`
path) appear as `func` **expressions** with `name: null`. `_fn0`, the global
function, is additionally referenced by `emitModule` outside any function
(`_fn0.call(globalThis)`).

## 3. AST shape the rung owns

May match/rewrite: the `name` of a `k:"func"` statement, `func.params` (not in
this rung), and every `{k:"ident", name:"_fnN"}` in the same function body.
**Must not touch** anything else — this is alpha-renaming and nothing more.
The `// fn#N "name"` comment stays exactly as it is: it remains the provenance
link back to the function table.

## 4. Matcher

**The site is the function-body root list only**: `match` returns `null` unless
`node === ctx.fnBody`. `_fnN` is declared by a `func` statement in that list and
its scope is the whole body, so a per-sublist site could not see every use.

Walk the root list for `func` statements named `/^_fn(\d+)$/`. For **every** one
that qualifies, capture `{ index: N, from: "_fnN", to: name }`; the match's data
is the whole batch, in statement order (`renames`), and `at.offset` is the
first one's statement index. **Batched, not one per match** (P-1, 2026-08-31):
the verdicts are independent of each other — a rename only ever introduces a
`to` that no other candidate could have claimed (two candidates wanting the
same `raw` are both `duplicate-name`, condition 6), so renaming one per driver
iteration produced exactly the same output at O(K²·B) cost (K candidates
re-classified, each with whole-body walks, after every one of K splices; a
React Native bundle's global function has K≈440 over a multi-megabyte body —
hours). The batched match computes conditions 4–5's body-wide sets once per
classification and R4b's read counts in one walk (`identUsesMany`), O(B).
Qualification —
all required:

1. `!ctx.module.isGlobalFunction(N)` (never rename `_fn0`; `emitModule`
   references it from outside every function body).
2. `raw = ctx.module.functionName(N)` is non-empty and `isSafeIdentifier(raw)`
   (valid `[A-Za-z_$][A-Za-z0-9_$]*`, not a reserved word — `src/passes/ast.ts`,
   copied from the emitter's rule; rungs may not import `src/emit/names.ts`).
3. `raw` does not match `/^(_fn\d+|_e\d+_\d+|r\d+|__.*|_exc\d+|L\d+|__state\d+)$/` —
   it must not be able to collide with an emitter-generated name class.
4. `raw ∉ freeNames(ctx.fnBody)` — no free reference to that name anywhere in
   this function or any function nested in it (this is what stops a rename from
   capturing a global that `global-access` just exposed, e.g. a function named
   `print`).
5. `raw` is not already declared in `ctx.fnBody`: not another `func` statement's
   name, not a `decl`/`init` name, not a parameter of this function, not an env
   slot name the function declares.
6. No *other* `_fnM` (M ≠ N) in this list would claim the same `raw`. Two
   entries with the same bytecode name → refuse both (`duplicate-name`); do not
   invent `name_2` suffixes, they read worse than `_fnN`.

**R4b — name from the assignment site.** When `raw` is empty (anonymous) and the
root list contains exactly one statement of the form `X.key = _fnN` (a `member`
write with `computed:false`) or `{k:"init", name:key, value: ident _fnN}`, and
`_fnN` has exactly one read in `ctx.fnBody`, use `key` as `raw` and re-run
conditions 2–6. Refuse when there is more than one such site
(`ambiguous-name`).

## 5. Writer

Rebuild the root list with `mapStmts`/`mapExpr`, once for the whole batch
(`renameIdents(list, mapping)`): each renamed `func` statement's `name` becomes
its `to`, and every `{k:"ident", name: from}` in the body — including inside
nested `func` bodies, which is where a recursive self-reference lives — becomes
`{k:"ident", name: to}`. Nothing else changes; no statement is added, removed or
reordered.

## 6. Checker

Class: **alpha-renaming** (ladder §4.3). All four obligations, on the whole
root list, for every `(from, to)` pair at once — the pairs are recovered by
diffing `before`/`after` (each `func` statement whose `name` changed), and each
whole-body walk below is done once for the batch, not once per pair:

1. `freeNames(after)` equals `freeNames(before)` with `from` replaced by `to`
   — and `to` was not already in `freeNames(before)`;
2. `to` is not a declared name in `before`, in any enclosing scope the rung can
   see, or in any nested `func` (re-run §4 conditions 4–5 rather than trusting
   the match);
3. printing `before`, and printing `after` with the rename undone, is
   **byte-identical** — implement literally: `printProgram(before) ===
   printProgram(renameIdent(after, to, from))`;
4. the counts match: `identUses(before, from).reads + writes ===
   identUses(after, to).reads + writes`, and `identUses(after, from)` is zero.

`checkBindings` (EM-01) runs over the whole program afterwards and is the
backstop: an undeclared identifier is a hard error, not a degraded output.

## 7. Ordering, refusals, metrics

**Ordering.** `after: ["expr-rebuild", "global-access"]` — the rename must see
the free global names `global-access` exposes, or condition 4 cannot protect
them. `before: ["class-recover"]` (batch 4, which wants named callees) and
before `var-naming` (batch 2): naming a function first means `var-naming` never
spends a name on a register that only held a closure.

**IR ownership.** `ident` names and `func.name` only (ladder §3.2). No
statement order, no expression shape, no comment text.

**Refuse (per-site):** `global-function`, `anonymous`, `unsafe-identifier`,
`reserved-word`, `emitter-name-class`, `captures-free-name`, `already-declared`,
`duplicate-name`, `ambiguous-name`. Every refusal leaves `_fnN`, which is
already unique and correct — the fallback costs readability only.

**Obfuscated input.** `.obf` variants carry names like `_0x3a2f`; those are
valid identifiers and will be adopted. That is correct behaviour (it is the
name the bytecode carries) and it is why `string-array-decode` is a separate,
hard rung.

**Fixtures (red→green).** `targets: ["19-var-hoisting", "21-iife-closures",
"22-nested-closures-counters", "17-closure-loop-var"]`, all five versions plus
`.min`/`.obf` — `.min` is the interesting case, since minified bundles often
carry one-letter names that still pass every condition. Unit tests: ≥1 positive
per rule; negatives for a reserved word, a name equal to an exposed global, two
functions sharing a name, and the global function; ≥1 site `check` refuses.

**Corpus metric.** Share of emitted functions whose declaration is `_fnN`:
baseline **0 %** named, target **≥ 80 %** of non-global functions renamed over
`tests/fixtures/constructs/**` at v94 (where the fixture sources use named
declarations), and the count of surviving `_fn` tokens on the RN template
bundle reported in `docs/STATUS.md` with its abandonment histogram.

**Estimated size:** ~130 lines across `match/rewrite/check`, ~180 lines of
tests.
