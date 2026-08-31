# 09 — `if-chain` (stage A, catalogue row **1**)

Reading list: `docs/AGENT-BRIEF.md`, `src/passes/README.md`, this file. Nothing
else — everything this rung needs about the idiom is quoted below.

Catalogue row 1 (`docs/lowering/if-else-chain.md`) is **✅ verified** at
84/94/98/99 and is the one idiom in the corpus with *zero* version
sensitivity: "v84, v94, v98, v99 all produce byte-for-byte identical
instruction sequences for `check`'s body (only string-table indices differ)".
So `versions` is unset — this rung runs everywhere.

## 1. Purpose

Hermes lowers `if / else if / else` to a plain conditional-jump tree, and the
structurer faithfully rebuilds that tree as nested `if` nodes. Nothing is
wrong with the output; it is just a staircase. Two things make it read like
source again:

* **most arms end abruptly** (`return`, `throw`, `break`, `continue`), so the
  `else` is redundant and the chain can be flattened to a run of guards;
* what is left is genuinely `else { if … }`, which JS spells `else if`.

The first is a tree rewrite and is this rung's whole job. The second is a
*printing* decision that cannot be made until `expr-rebuild` (stage B) has
folded the condition-computing statements into the condition, so this rung
only **marks the intent** and the printer decides (§5 C3, §7 F11).

Observed today — `01-if-else-chain/v94.hbc`, function `check` (source:
`if (…) return 'negative'; else if (n === 0) return 'zero'; else if (n < 10)
… else return 'large';`):

```js
      r0 = 0;
      if (r1 === r0) {
        r0 = "zero";
        return r0;
      } else {
        r0 = 10;
        if (r1 < r0) {
          r0 = "small";
          return r0;
        } else {
          r0 = 100;
          if (r1 < r0) {
            r0 = "medium";
            return r0;
          } else {
            r0 = "large";
            return r0;
          }
        }
      }
```

Wanted (this rung only; `expr-rebuild` and `var-naming` then take `r0`/`r1`):

```js
      r0 = 0;
      if (r1 === r0) {
        r0 = "zero";
        return r0;
      }
      r0 = 10;
      if (r1 < r0) {
        r0 = "small";
        return r0;
      }
      r0 = 100;
      if (r1 < r0) {
        r0 = "medium";
        return r0;
      }
      r0 = "large";
      return r0;
```

Nesting depth 5 → 1; four `else` blocks → zero. Note that the `else` arm here
is **not** a bare `if`: it is `block b3; if b3 {…} else {…}` — the block that
computes the next condition, then the branch on it. That pair is inseparable
in stage A, which is exactly why `else if` is deferred to the printer.

## 2. Baseline shape

`--emit-tree` for the same function, after `label-clean`:

```
; fn#1 "check"  {"blocks":10,…,"maxNesting":7,"labels":1}  passes=label-clean@89
block b0
if b0 {
} else {
  block b1
  if b1 {
    return b9
  } else {
  }
}
block b2
if b2 {
  return b8
} else {
  block b3
  if b3 {
    return b7
  } else {
    block b4
    if b4 {
      return b6
    } else {
      return b5
    }
  }
}
```

Two facts the matcher lives on:

1. `{k:"if", cfgBlock, then, else}` (`src/structure/ir.ts`) carries **no
   condition of its own** — the condition is `conditionFor(cfgBlock)`, i.e.
   the terminator of `cfgBlock`. There is **no `negate` field**, so this rung
   can never swap arms: the shape `if C { } else { E }` (empty *then*) is a
   refusal, not a rewrite (§7 `empty-then-needs-negation`).
2. `src/emit/function.ts`'s `case "if"` does **not** lower `cfgBlock` —
   the sibling `block bX` node preceding the `if` does. Deleting or reordering
   a `block` node is therefore forbidden (`blocksMultiset` invariant, ladder
   §3.3), and a rewrite may only move whole `[block bX, if bX …]` runs
   together with their surrounding statements. This rung never moves anything;
   it only *unwraps*.
3. `src/emit/print.ts` prints `} else {` unconditionally when `s.else` is
   non-empty and prints no `else` at all when it is empty. So "delete the
   `else`" and "make the `else` empty" are the same output.

## 3. IR shape the rung owns

Ladder §3.1: **may match/rewrite** `if`, `seq`, `return`. **Must not touch**
`loop`, `try`, `switch`, `labeled`, `break`, `continue`, `setState`,
`unreachable`, or any `block` leaf — pattern *through* them with
`items()`/`children()`, never rebuild them.

Adds one optional annotation to `ir.ts`, transparent to `verify.ts` exactly as
`LoopForm` and `hideLabel` are (§7 F11):

```ts
| { readonly k: "if"; readonly cfgBlock: BlockId; readonly then: Stmt;
    readonly else: Stmt; readonly elseIf?: boolean }
```

## 4. Matcher

Post-order, innermost first (the driver's order). Return the first applicable
of C1…C3; `null` otherwise. `items(s)` and `completesNormally(s)` are in
`src/passes/tree.ts`.

**C1 — else-drop (the early-return flatten).** `node.k === "if"` and:

* `items(node.else).length > 0` — there is an `else` to drop; and
* `completesNormally(node.then) === false` — *every* path through the `then`
  arm ends in `return`, `throw`, `break`, `continue` or `unreachable`, so
  control can never reach the statement after the `if` from the `then` side;
  and
* `node.then` is not `{k:"seq",body:[]}` (an empty arm completes normally
  anyway, so this is implied — assert it, do not rely on it); and
* `node.elseIf !== true` (idempotence: C3's annotation is not undone).

Capture `{ rule: "C1", elseItems: items(node.else) }`.

`completesNormally` is the whole correctness argument, so read it before
using it: it is `false` only when it can prove abrupt completion on every
path, and it must return `true` for anything it does not understand. If it
ever returns `false` for a node that can fall through, this rung is unsound —
which is why `check` re-derives it on `before` (§6.1) rather than trusting the
match.

**C2 — empty-else hygiene.** `node.k === "if"`, `node.else.k === "seq"`,
`node.else.body.length === 0`, and `node.else` is not already the canonical
empty `seq` object identity used by the writer. This is a no-op in the printer
and exists only so that C1's output normalises: after C1 the `else` arm is
`{k:"seq",body:[]}`, and a later post-order visit must not re-enter C1 on it.
**If the implementer makes C1's writer emit the canonical empty `seq`
directly, drop C2** — it is a convenience, not a requirement. (Recommended:
drop it. It is listed so a reviewer knows it was considered.)

**C3 — `else if` intent.** `node.k === "if"`, `node.elseIf !== true`, and
`items(node.else)` is one of:

* `[ {k:"if", …} ]`; or
* `[ {k:"block", cfgBlock: bX}, {k:"if", cfgBlock: bX, …} ]` — the
  condition-computing block immediately followed by the branch on **that same
  block**. The `cfgBlock` equality is the whole check: two different blocks
  would mean the `else` arm does real work before branching, and printing
  `else if` would then have to swallow that work.

Capture `{ rule: "C3" }`. This is an **annotation-only** match: the tree is
otherwise untouched, so it gets no help from the driver's round-trip and §6.3
is its only guard.

C1 and C3 are mutually exclusive in practice (C1 removes the `else` C3 wants),
and C1 is tried first: a flattened chain beats an `else if` chain, and where
C1 refuses C3 is exactly the residue worth marking.

## 5. Writer

* **C1**: return `{k:"seq", body: [ {…node, then: node.then, else: EMPTY},
  ...m.data.elseItems ]}` where `EMPTY = {k:"seq", body: []}`. The `if` keeps
  its `cfgBlock` and its `then` arm byte-for-byte; the `else` arm's statements
  become the `if`'s following siblings, in order, in the same `seq`. Nothing
  is deleted, duplicated, or reordered.
* **C2**: return `{…node, else: EMPTY}`.
* **C3**: return `{…node, elseIf: true}`.

Emitter side (F11): `lowerTree`'s `case "if"` passes the annotation through to
a new optional `elseIf?: boolean` on `src/emit/ast.ts`'s `if` statement.
`src/emit/print.ts` prints `} else if (…) {` — sharing the `if` printer's
own test rendering — **only when** `s.elseIf === true` *and* `s.else` is
exactly one statement *and* that statement is an `if`. Anything else falls
back to today's `} else {`, exactly as `LoopForm.init`/`.step` fall back to
`while`. Because nothing sets the annotation with `--passes=none`, the
baseline output stays byte-identical (PL-05).

The reason the printer, not the rung, makes the final call: at stage A the
`else` arm is `[block b3, if b3]`, two statements; `expr-rebuild` (stage B)
later folds `r0 = 10` into the condition and leaves one `if`. The rung marks
"this `else` was a chain link"; the printer sees whether it ended up printable
as one.

## 6. Checker

Class: **CF-preserving** (ladder §4.3) for C1/C2; **annotation-only** for C3.

1. **C1** — re-derive, from `before`, that `completesNormally(before.then)` is
   `false`, and that `items(before.else)` deep-equals the statements that now
   follow the `if` in `after`, in the same order (identity comparison on the
   captured array is enough; do not re-walk). Reason on failure:
   `then-falls-through` / `else-items-reordered`.
2. **C1/C2** — `blocksMultiset(before)` equals `blocksMultiset(after)`. No
   `block`, `return`, `throw`, `if`, `try` or `switch` leaf was added, removed
   or duplicated; only the nesting changed.
3. **C1/C2** — every `break`/`continue` label reachable in `after` still
   resolves to an enclosing `labeled`/`loop` *within `after`* or is left
   unresolved-but-unchanged (the rung sees only its subtree; the driver's
   whole-function round-trip catches the rest). Concretely: the multiset of
   `(label, kind)` pairs from `usesOf` over `before` equals that over `after`.
4. **C3** — `sameShape(before, after)`, `before.elseIf !== true`, and the
   §4 C3 shape predicate re-derived from `before` (including the `cfgBlock`
   equality in the two-statement case). Do **not** trust `m.data`.
5. All rules — `after` contains no `if` node whose `then` and `else` are both
   the *same object*, and no `seq` nested directly inside a `seq` that the
   rung created (keep the tree canonical so a second run is a fixed point).

Then the driver splices `after` into the whole function and re-runs spec 04
§5's `reconstruct` + `checkIsomorphic`. For C1 that round-trip is the real
proof: the CFG it reconstructs from the flattened tree must be edge-for-edge
the CFG it reconstructs from the staircase. C3 gets nothing from it
(`sameShape` holds), so obligation 4 is all it has — write it carefully.

## 7. Ordering, framework, refusals, fixtures, metrics

**Ordering.** `stage: "A"`, `after: ["loop-cond", "for-header"]` (ladder §2:
"`loop-cond` before … `if-chain`" — a guard `if` inside an unformed loop is
the loop's test, and flattening its `else` before `loop-cond` has annotated it
would hide the tail-guard shape `loop-cond` keys on). `before: []`.
`label-clean` is last in stage A and gains `"if-chain"` in its `after:` list
(ladder §2, spec 06 §7 says this is the adding rung's job) — do that edit in
the same commit.

**Framework prerequisite F11** (this spec owns it; it is ~25 lines):

1. `ir.ts`: `elseIf?: boolean` on the `if` node, documented like `hideLabel`.
2. `src/structure/verify.ts`: no change needed — the field is not read there;
   add it to the "transparent annotations" comment so the next reader knows.
3. `src/emit/ast.ts`: `elseIf?: boolean` on the `if` statement.
4. `src/emit/function.ts` `case "if"`: pass it through.
5. `src/emit/print.ts`: the `} else if (…) {` branch described in §5, with the
   three-part guard and the fallback.
6. A print-level unit test for each of: annotation set + single `if` else →
   `else if`; annotation set + two-statement else → `} else {`; annotation
   unset → `} else {`.

**Refuse (per-site, each a distinct `reason` string):**

* `then-falls-through` — C1's core precondition fails.
* `no-else` — the `else` arm is already empty.
* `empty-then-needs-negation` — `then` is empty and `else` is not. The
  readable form is `if (!c) { E }`, which needs an `if.negate` field this rung
  does not have. Recorded so the count is visible in the metric (see the open
  question).
* `loop-test` — `ctx.structured`'s enclosing `loop` carries a `form` whose
  `cond === node.cfgBlock`. Flattening the loop's own guarded `if` would move
  the loop body out of the arm `LoopForm.at` names, and the emitter would
  silently fall back to `while (true)`. **Refuse whenever the `if` is any
  loop's annotated test**, at either `at` position.
* `switch-arm-spine` — the `if` is on the else-spine of a compare chain that
  `switch-raise` (spec 10) is going to claim: `ctx.applied` does not yet
  contain `"switch-raise"` **and** the chain-detection predicate of spec 10
  §4 S2a matches at this node. Ordering alone cannot settle this because
  `switch-raise` S2 is scheduled after S1 lands; until it does, `if-chain`
  flattening a compare chain is *correct* but wastes the chain. Ship this
  refusal disabled-by-default behind the presence of the `switch-raise`
  registration, and re-read the open question below.
* `generator-dispatcher` — the function's root contains a `switch` whose
  scrutinee is `{t:"generator-state"}` or `{t:"dispatch"}`. Refuse the whole
  function until batch 4's generator rungs have run (same rule as spec 06 §7).

**D14.** Dropping an `else` moves no evaluation, introduces no binding, and
changes no exception path: the statements that ran after the `if` still run
after it, in the same order, and the `then` arm still cannot reach them. The
rung never negates a condition (no `negate` field exists), so `conditionFor`'s
polarity — the one thing the emitter and a pass must never disagree about —
is untouched.

**Fixtures (red→green).** `targets: ["01-if-else-chain",
"09-switch-fallthrough", "10-switch-no-fallthrough"]`, all five HBC versions
plus `.min`/`.obf`. Unit tests on hand-built trees
(`tests/gate/passes/synth.ts`): ≥1 positive per rule; negatives for a `then`
that falls through, an empty `then` with a non-empty `else`, an `if` that is a
`LoopForm.cond`, and a C3 candidate whose two `else` statements name
*different* blocks; ≥1 site the `check` refuses (hand-build an `if` whose
captured `elseItems` do not match `after`, and assert `ok === false`).

**Corpus metric.** Measured baseline, `tools/passes-metrics.mjs`, over
`tests/fixtures/constructs/**` at v94 with the current pipeline:
**309 occurrences of `} else {`**, of which **167 (54 %)** are immediately
preceded by a line ending in `return …;` / `throw …;` / `break …;` /
`continue;` — a *lower bound* on C1's reach, since it misses `then` arms that
end abruptly on every path without a single-line terminator. Add
`measureIfChain()` counting `} else {` occurrences and per-function maximum
brace-nesting depth.

* Floor: **`} else {` occurrences fall by ≥ 40 %** at v94 across the construct
  corpus (309 → ≤ 185), and at every other version by ≥ 30 %.
* Floor: **median per-function maximum nesting depth falls by ≥ 1 level**.
* Guard: `01-if-else-chain`'s `check` must contain **zero** `} else {`.
* Guard: 492/492 fixture PASS unchanged, PL-09 (PASS with passes on *and*
  off), `--passes=none` byte-identical.

**Estimated size:** ~110 lines across `match/rewrite/check`, ~25 lines of F11
across `ir.ts`/`ast.ts`/`function.ts`/`print.ts`, ~200 lines of tests. The
smallest rung in batch 2 and the one to land first.

## 8. Open questions for the overseer

1. **`if (c) { } else { E }` needs `if.negate`.** The corpus has these (the
   first `if` of `01`'s `check` is one). Adding `negate?: boolean` to the `if`
   node and having the emitter print `!conditionFor(cfgBlock)` is ~15 lines
   and would let this rung normalise every empty-`then` branch. It is
   deliberately **not** in this spec because inverting a condition is the one
   place a pass can disagree with `conditionFor`'s polarity — the README's
   named hazard. Worth a small follow-up rung (`if-negate`) with its own
   round-trip evidence, or worth folding in here? Recommend: separate.
2. **`switch-arm-spine` ordering.** Spec 10 ships S1 (jump-table) first and S2
   (compare chain) possibly later. Until S2 exists, should `if-chain` flatten
   compare chains (better output now, `switch-raise` S2 then has to match a
   flattened chain instead of a staircase) or refuse them (worse output now,
   S2 gets the shape its spec describes)? This spec's default is **refuse
   only once `switch-raise` is registered**; if S2 slips past batch 2, flip it.
3. C3's value is unproven until `expr-rebuild` has landed and the printer
   change is in. If `expr-rebuild` turns out to fold the condition block in
   fewer cases than expected, C3 fires but never prints and the annotation is
   dead weight. Measure `elseIf` sites that actually print as `else if` and
   report it; if it is under ~50 %, drop C3 and F11 items 1–5.
