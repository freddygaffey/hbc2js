# 10 — `switch-raise` (stage A, catalogue rows **6**, **7**)

Reading list: `docs/AGENT-BRIEF.md`, `src/passes/README.md`, this file.

Catalogue row 7 (`SwitchImm`/`UIntSwitchImm` dense table) is **✅ verified** at
84/94/98/99 — "renamed `SwitchImm`→`UIntSwitchImm` at v99 but operand shape
(`Reg8,tableOffset,defaultTarget,min,max`) is identical", and `src/disasm`
already normalises both into one `SwitchTable`, so the rung never sees the
rename. Row 6 (`JStrictEqual(Long)` compare chain) is **✅ verified** at
84/94/99 and `docs/lowering/switch.md` §2a records the `09-switch-fallthrough`
chain as "v94 **and** v99 (identical)". Row 8 (`StringSwitchImm`) is
**deliberately out of scope** — see §8 and `PUSHBACK P-01`.

`versions`: unset. Both rows exist at every version in the corpus.

**Ship in two steps.** §4 S1 (jump-table) is self-contained and is what batch 2
must land. §4 S2 (compare chain) needs a framework change to `verify.ts` that
this spec specifies but does not assume; it may land in the same rung later.
An implementer who ships only S1 has completed this spec's acceptance bar.

## 1. Purpose

The structurer already produces a `{k:"switch"}` node for a jump table, so the
opcode is recovered. What is *not* recovered is **fall-through**: Hermes
compiles `case 1: case 2: … case 3: …` by pointing several table slots at one
target and by letting one case body fall into the next, and the structurer
represents both by wrapping the switch in a nest of `labeled` blocks and
ending every arm with `break Lk`. The shared bodies end up *outside* the
switch, as the tails of those labels.

Observed today — `52-switch-jumptable/v94.hbc`, `classify`, `--emit-tree`:

```
L0: {
  L1: {
    L2: {
      block b0
      switch b0 (jumptable) {
        case 0:  block b12  break L0
        case 1:              break L1
        case 2:              break L1
        case 3:  block b9   break L2
        case 4:              break L2
        case 5:  block b8   break L0
        …
        case 12: block b1   break L0
        default: block b13  break L0
      }
    }
    block b10
    break L0
  }
  block b11
  break L0
}
return b14
```

and printed:

```js
      L0: {
        L1: {
          L2: {
            switch (r0) {
              case 0:
                r0 = r2.push("zero");
                break L0;
                break;
              case 1:
                break L1;
                break;
              …
```

Wanted:

```js
      switch (r0) {
        case 3:
          r0 = r2.push("three");     // b9  — falls through
        case 4:
          r0 = r2.push("three-four");// b10 — the L1 tail, now inside the switch
          break;
        case 1:
        case 2:
          r0 = r2.push("one-two");   // b11 — the L0 tail
          break;
        case 0:
          r0 = r2.push("zero");
          break;
        …
        default:
          r0 = r2.push("other");
          break;
      }
      return r2.join("+");
```

Three labels, six `break Lk`, one dead `break;` per arm and ten levels of
nesting all disappear; the source's own `case` order does not survive, and
does not need to (the tests are distinct constants).

## 2. Baseline shape

`src/structure/ir.ts`:

```ts
| { k: "switch"; cfgBlock: BlockId; scrutinee: Scrutinee;
    cases: readonly SwitchArm[]; default: Stmt }
interface SwitchArm { value: number; isString: boolean; body: Stmt }
type Scrutinee = { t: "jumptable"; table: SwitchTable } | { t: "dispatch"; … }
               | { t: "generator-state" }
```

Facts the writer depends on, all read from `src/emit/function.ts`:

1. `lowerTree`'s `case "switch"` lowers `node.cfgBlock` itself
   (`out.push(...lowerBlock(node.cfgBlock))`) and then appends
   `{k:"break", label:null}` to **every** arm body and to the default —
   hence the dead `break L0; break;` pairs above. That unconditional append is
   what F12 makes conditional.
2. `default` is always emitted last, as `{test: null, …}` after `cases`.
3. There is **no unlabelled `break` node in the tree IR** (`break` requires a
   `LabelId`). "This arm exits the switch" is expressed by the arm body simply
   ending; the emitter's appended `break;` does the rest.
4. `verify.ts` P5 (`verify.ts:240`) requires that a block with a *switch*
   terminator have a `switch` node and a block with a *conditional-jump*
   terminator have an `if` node. S1 never changes which node kind covers which
   block; S2 does, which is why S2 needs F13.

## 3. IR shape the rung owns

Ladder §3.1: **may match/rewrite** the `switch` node (jump-table scrutinee
only), `labeled` wrappers around it, `seq`, and the `break` statements that
target the raised labels. **Must not touch** `loop` annotations, `try`,
`if` outside S2's own chain, `setState`, `unreachable`, or any `block` leaf.
Never a `switch` whose scrutinee is `{t:"dispatch"}` or
`{t:"generator-state"}` — those belong to the generator rungs (batch 4).

Adds one optional field to `ir.ts`, transparent to `verify.ts`:

```ts
interface SwitchArm { value: number; isString: boolean; body: Stmt;
                      readonly fallThrough?: boolean }
```

## 4. Matcher

### S1 — jump-table fall-through raise

Match on the **outermost `labeled`** of the nest, so the whole nest and every
`break` into it is inside the matched subtree. `node.k === "labeled"`. Peel:

```
peel(n):  L = [];  cur = n
  while cur.k === "labeled":
      its = items(cur.body)
      L.push({ label: cur.label, tail: its.slice(1) })
      cur = its[0]
  # cur must now be the switch core
```

Require, in order (each failure is a distinct refusal reason):

* **A1** every peeled level's `items(cur.body)` has `length ≥ 1` and its first
  element is the next `labeled` or the switch core — `nest-not-linear`.
* **A2** the core is `seq[ {k:"block", cfgBlock: bX}, {k:"switch", cfgBlock: bX, …} ]`
  or the bare `switch` — `no-switch-core`. (The `block bX`/`switch bX`
  `cfgBlock` equality is required: they are the same CFG block, split by
  `lowerTree` into "the instructions" and "the terminator".)
* **A3** `sw.scrutinee.t === "jumptable"` — `not-jumptable`.
* **A4** no arm carries `fallThrough` already — idempotence, `already-raised`.
* **A5** every `break L` in the whole matched subtree targets one of the
  peeled labels (`usesOf` per label, summed, equals the total `break` count
  found by a walk) and **no** `continue L` targets any of them —
  `label-escapes` / `continue-to-switch-label`.
* **A6** the arm `value`s are pairwise distinct — `duplicate-case-value`.
  (This is what makes reordering the arms unobservable: distinct constant
  tests, pure register scrutinee.)

**Classify each arm and the default** by the *last* statement of its body
(`items(arm.body).at(-1)`):

| Last statement | Group |
|---|---|
| `break L_i` for a peeled label | `i` |
| absent (empty body) or a statement that completes normally | `n` (innermost — falling out of the switch runs `tail(L_n)` next) |
| `return` / `throw` / `continue L` where `L` is **not** peeled | `free` |

Anything else (`break` to a non-peeled label, `unreachable`) → refuse,
`unclassifiable-arm`.

**Segments.** With levels `L_0` (outermost) … `L_n` (innermost), define
`T_i = tail(L_i)` from `peel`. Execution after "fall out of the switch" is
`T_n, T_{n-1}, …, T_0`, then the statement following the matched node.
`break L_i` skips to `T_{i-1}, …, T_0` (and `break L_0` skips to the
statement after the node). So the linear layout is:

```
group(n)   ++ T_n
group(n)…  # (group n = arms that fall out of the switch)
group(n-1) ++ T_{n-1}      # arms ending `break L_n`  →  continuation T_{n-1}
…
group(0)   ++ T_0          # arms ending `break L_1`  →  continuation T_0
group(-1)                  # arms ending `break L_0`, plus every `free` arm
```

i.e. an arm whose group is `i` (meaning it ends `break L_i`) is followed by
`T_{i-1}`; an arm in group `n` (falls out) is followed by `T_n`.

**Linearisation constraints** — each is a refusal, not a fixup:

* **B1** within one group, **at most one** arm may have a non-empty body, and
  it is emitted **first** in the group (the empty `case` labels follow it, then
  the segment). Two bodied arms in one group cannot both reach the segment
  without running each other's body — `two-bodied-arms-in-group`.
* **B2** every segment `T_i` must end in a way that does not fall into the
  next group: its last statement is `break L_j`, `return`, `throw`, or a
  `continue` to a label outside the nest. If `T_i` completes *normally* it
  cascades into `T_{i-1}` — allowed **only if** group `i-1` is empty, so the
  two segments concatenate — `cascading-tail-with-arms`.
* **B3** a `break L_j` **inside a segment** must target either `L_0` (becomes
  the switch's own exit) or the label whose segment is textually next
  (becomes plain fall-through, i.e. the statement is deleted). Anything else
  — `segment-nonlocal-break`.
* **B4** `default` is a `Stmt`, not a `SwitchArm`, so it has nowhere to carry
  `fallThrough` and the emitter always prints it last. Require `default`'s
  group to be `0` or `free` — `default-must-not-fall-through`. (`switch.md`
  §2 records that Hermes puts `default` "in bytecode order … always the
  bytecode-final fallthrough position", so this holds for the corpus; measure
  it on real bundles before relaxing.)

**Minimum viable subset.** An implementer short on time may additionally
require `n ≤ 3` and refuse every cascading tail (B2's "allowed" branch).
That still covers `09`, `10`, `52`, `53`, `56` at all five versions and is a
complete, shippable S1.

Capture `{ rule: "S1", levels, core, sw, groups, segments }`.

### S2 — compare-chain raise (rows 6; **needs F13, see §7**)

`09-switch-fallthrough`'s `classify` at v94 *and* v99 is the same nest of
`labeled`s, but with the jump table replaced by an else-spine of `if`s on one
register:

```
L0: { L1: {
  block b0
  if b0 {                       ; 1 === r1  — empty then = "fall out of the chain"
  } else { block b1
    if b1 {                     ; r0(=2) === r1
    } else { block b2
      if b2 { break L1 }        ; r0(=3) === r1
      else { block b3
        if b3 { } else { block b4
          if b4 { block b6; break L0 } else { block b5 } }
        block b7
        break L0 } } }
  block b8
  break L1
} block b9  break L0 }
```

S2's matcher walks the else-spine collecting, per level, `(constant, target)`
from `condInputs(lastInstruction(fn, bX))` where exactly one input is a
`JStrictEqual`/`JStrictEqualLong` against the *same* register at every level
and the other is a constant reachable by `constantAt`. It then feeds the
resulting `(value → body)` list into **S1's own segment/group machinery** —
the label nest and the fall-through encoding are identical, which is the point
of specifying them once.

**S2 is blocked on F13.** Replacing the `if` spine with a `switch` node makes
`verify.ts` P5 fail: block `b0` has a *conditional-jump* terminator but the
tree would carry a `switch` node for it. F13 is: a fourth `Scrutinee` variant
`{ t: "compare"; register: number; blocks: readonly BlockId[] }` naming every
spine block it subsumes, plus a `verify.ts` rule that a `compare` switch
satisfies P5 for **all** of `blocks` and reconstructs each arm's edge from the
corresponding spine block's conditional jump. That is a spec-04 change, not a
pass change, and it must be reviewed with the structurer's owner. Until it
lands, S2's `match` returns `null` unconditionally and the rung ships as S1.

## 5. Writer

**S1.** Build the new arm list:

1. For each group `i` in order `n, n-1, …, 0`: its arms, bodied one first
   (B1), then the empty ones. Set `fallThrough: true` on every arm of the
   group **except the last**, and on the last one too when its segment is
   non-empty (it falls into the segment, which lives in the *next* arm's body
   — see step 2).
2. Append segment `T_i` to the body of the **last** arm of the group it
   follows, dropping the `break L_j` statements B3 authorised. That arm then
   ends normally, so it does *not* carry `fallThrough`, and the emitter's
   appended `break;` becomes the arm's real exit.
   If the group is empty, prepend `T_i` to the next segment instead (B2's
   cascade case).
3. Group `-1` arms (ending `break L_0`, `return`, `throw`, `continue`) come
   last; delete a trailing `break L_0` (the emitter's appended `break;`
   replaces it) and carry `return`/`throw`/`continue` through unchanged.
4. `default` keeps its position (the emitter prints it last) with its trailing
   `break L_0` deleted.
5. Return `{k:"seq", body: [ core.block?, {…sw, cases: newCases, default: newDefault}, ...afterNode ]}`
   where `afterNode` is empty — the statements that followed the outermost
   `labeled` are the driver's business, not the rung's, because the rung's
   node **is** the outermost `labeled` and its replacement is spliced in
   place.

Every `labeled` wrapper is gone; every `break Lk` is gone; every `block` leaf
appears exactly once, in the same relative order along every path.

**Emitter (F12).** `lowerTree`'s `case "switch"` appends
`{k:"break", label:null}` to an arm body **unless** `arm.fallThrough === true`.
Nothing sets `fallThrough` with `--passes=none`, so the baseline output stays
byte-identical (PL-05). Do **not** also make the append conditional on
`completesNormally` in the same change — that would remove today's dead
`break L0; break;` second `break` from the baseline and break PL-05; propose
it separately.

## 6. Checker

Class: **CF-preserving** (ladder §4.3).

1. `blocksMultiset(before)` equals `blocksMultiset(after)` — every `block`,
   `return`, `throw`, `if`, `try` leaf survives exactly once. This is the
   single most important obligation: the raise moves whole subtrees and
   deletes only `labeled` wrappers and `break` statements, neither of which
   carries a block.
2. Re-derive, from `before` alone, the group of every arm and the content of
   every segment (do not trust `m.data`), and assert that for every arm the
   **path** `arm.body ++ segment(group(arm)) ++ … ++ (exit)` in `after`
   is the same statement sequence, in the same order, as the path
   `arm.body ++ T_{g} ++ … ++ (exit)` in `before`. Implement as: for each arm,
   walk `after` from that arm's `case` label following fall-through until an
   abrupt statement or the end of the switch, and compare the resulting
   `BlockId` sequence against the same walk over `before`'s nest. **This is
   the rung's real proof and it is cheap** — one walk per arm.
3. Every `break`/`continue` label appearing in `after` resolves within `after`
   or is unchanged from `before` (compare the `usesOf` multisets for every
   label *not* peeled; the peeled ones must have count 0 in `after`).
4. Arm `value`s in `after` are a permutation of those in `before`, pairwise
   distinct, with `isString` preserved per value.
5. `after` has exactly one `switch` node, with the same `cfgBlock` and the
   same `scrutinee` object as `before`'s.
6. No arm carries both `fallThrough: true` and a body that completes
   abruptly (that would be a silently unreachable fall-through).

Then the driver splices and re-runs `reconstruct` + `checkIsomorphic` over the
whole function. For S1 that round-trip is decisive: the reconstructed CFG must
have the same edges out of `bX`'s switch terminator and the same edges through
the moved tails.

## 7. Ordering, framework, refusals, fixtures, metrics

**Ordering.** `stage: "A"`, `after: ["loop-cond", "for-header"]` (ladder §2:
"a compare-chain switch inside an unformed loop looks like a dispatcher") and
`before: []`. Register **before** `if-chain` so that S2, when it exists, sees
the spine before `if-chain` flattens it; spec 09 §7's `switch-arm-spine`
refusal is the other half of that handshake. `label-clean` gains
`"switch-raise"` in its `after:` list in the same commit (spec 06 §7).

**Framework prerequisites.**

* **F12** (S1, required): `SwitchArm.fallThrough?: boolean` in `ir.ts`;
  `lowerTree`'s `case "switch"` skips the appended `break;` when it is set;
  a print-level unit test for set/unset. ~10 lines.
* **F13** (S2 only, deferred): the `{t:"compare"}` `Scrutinee` variant and its
  `verify.ts` P5 rule. Do not start S2 without it.

**Refuse (per-site):** every reason named in §4 —
`nest-not-linear`, `no-switch-core`, `not-jumptable`, `already-raised`,
`label-escapes`, `continue-to-switch-label`, `duplicate-case-value`,
`unclassifiable-arm`, `two-bodied-arms-in-group`, `cascading-tail-with-arms`,
`segment-nonlocal-break`, `default-must-not-fall-through` — plus:

* `generator-dispatcher` — the function's root contains a `switch` whose
  scrutinee is `{t:"dispatch"}` or `{t:"generator-state"}`; refuse the whole
  function until batch 4's generator rungs have run.
* `switch-in-try` — the switch node, any peeled `labeled`, or any segment is
  inside a `try` **body** whose handler can be entered from a segment. Moving
  a segment into the switch does not change which blocks are protected (the
  handler table is unchanged and `planTries` recomputes from the tree), but
  it does change the try's *lexical* extent, which can turn a guard-free try
  into a guarded one. Refuse rather than measure, and record the count.

**D14.** The raise moves no computation across a control-flow edge: every arm
still executes exactly the blocks it executed before, in the same order
(obligation 2 proves it path by path). Case tests are distinct constants
compared against a register, so reordering the arms is unobservable —
obligation 4 is what makes that claim, and it is the only claim the reorder
rests on.

**Fixtures (red→green).** `targets: ["52-switch-jumptable",
"53-switch-jumptable-large", "10-switch-no-fallthrough",
"09-switch-fallthrough"]` — the last one is red until S2 lands and should be
listed with a comment saying so, or omitted if the gate treats a
never-firing target as a failure (check `tests/gate/passes/framework.test.ts`
before choosing). `56-switch-string-jumptable` also produces a jump-table
`switch` node at v98/v99 (verified: `--emit-tree` shows
`switch b0 (jumptable)`) — add it as a target guarded by `versions`.
All five HBC versions plus `.min`/`.obf`. Unit tests on hand-built trees
(`tests/gate/passes/synth.ts`): ≥1 positive for a two-level nest and a
three-level nest; negatives for a duplicate case value, two bodied arms in one
group, a `continue` into a peeled label, a non-jumptable scrutinee, and a
default that falls through; ≥1 site the `check` refuses (hand-build an arm
whose `after` path differs from its `before` path and assert `ok === false`).

**Corpus metric.** Measured baseline over `tests/fixtures/constructs/**` at
v94 with the current pipeline: **18 `switch (` statements** and
**309 `} else {`**; every raised switch today is wrapped in 2–3 `labeled`
blocks and every arm ends `break L0; break;`.

Add `measureSwitchRaise()` counting, per emitted `switch` statement:
(a) `break L\d+;` statements inside it, (b) enclosing `L\d+: {` labels between
the switch and the nearest function body, (c) `break;` statements immediately
preceded by another `break`.

* Floor: **`break L\d+;` inside a `switch` falls to 0** at v94/v99 for
  `52`, `53`, `10` — a raised switch with a surviving labelled break is a
  failed raise, not a partial one.
* Floor: **total `L\d+: {` label declarations across the corpus fall by
  ≥ 15 %** at v94 (these nests are a large share of the remaining labels; the
  rest belong to `label-clean`).
* Floor: **`break;` immediately after `break L…;` falls to 0** in every
  raised switch (F12).
* Guard: 492/492 fixture PASS unchanged, PL-09, `--passes=none`
  byte-identical, gate ≤ 90 s.

**Estimated size:** ~260 lines across `match/rewrite/check` for S1 (the
linearisation is the bulk), ~10 lines of F12, ~300 lines of tests. The largest
rung in batch 2; review the segment walk (obligation 2) hardest.

## 8. Open questions for the overseer

1. **Row 8 (`StringSwitchImm`) — the docs contradict each other.**
   `docs/LOWERING-CATALOGUE.md`'s index row 8 reads "✅ measured, T9
   (fixture; 0 at v84/94/96, 1 at v98/99)" and the fixture
   `tests/fixtures/constructs/56-switch-string-jumptable` exists and
   decompiles to a `switch b0 (jumptable)` node at v99. But
   `docs/lowering/switch.md` §7 still says the operand layout is "read from an
   ad hoc probe file, not from `tests/fixtures/constructs/`, so it is marked
   ⛔ inferred and **a pass must not be written against it**". One of the two
   is stale. Filed as `PUSHBACK P-01`. This spec lists `catalogue: [6, 7]`
   and treats 56 as a bonus target, which is safe either way; if the row is
   genuinely verified, `switch.md` §7 should be corrected and 8 added.
2. **`default` fall-through.** B4 refuses a `default` that is not group-0
   because `SwitchArm` carries `fallThrough` and `default: Stmt` does not, and
   because `lowerTree` always prints `default` last. Real code does put
   `default` mid-list (`09`'s source does exactly that). Promoting `default`
   to a `SwitchArm | null` with `value: null` would fix both; it touches
   `ir.ts`, `verify.ts` and the emitter. Worth doing now, or after S2?
3. **S2 / F13 priority.** Row 6 is the *common* case in real bundles (a
   compare chain fires for any switch under the density threshold, and for
   every string switch below v98). S1 alone therefore recovers the minority.
   Is F13 (a `Scrutinee` variant + a `verify.ts` P5 rule, reviewed by the
   structurer's owner) in scope for batch 2, or does it become its own
   half-rung task?
4. **`switch-in-try` measurement.** The refusal above is conservative because
   `planTries` recomputes the `__pc` guard from the tree's lexical extent
   (`src/emit/function.ts:75`). If a raise never widens that extent — plausible,
   since segments move *inward* — the refusal can be dropped. Someone should
   measure it on the RN template bundle before batch 3.
