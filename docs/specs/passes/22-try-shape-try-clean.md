# 22 — `try-shape` (stage A) + `try-clean` (stage B)

**Catalogue rows:** 11 (`try`/`catch`), 12 (`finally`).
**Fixtures:** `12-try-catch-finally-return`, `13-try-finally-no-catch`,
`14-nested-try-catch`, `15-catch-without-binding`,
`16-finally-with-break-continue`.
**Ladder rows:** `00-LADDER.md` §1.1 (`try-shape`, batch 4) and §1.2
(`try-clean`, batch 4, `after: [expr-rebuild]`, "stage-A `try-shape` first").
**Ownership:** §3.1 `try-shape` owns `try.catchRegister` + the handler
prologue; §3.2 `try-clean` owns `try`, and `assign`/`init` of `__pc`/`__exc`
— **never anything the handler still reads**.

One spec, two rungs, because they share one fact base: the emitter's
`__pc`/`__exc` scaffolding (`src/emit/function.ts` `planTries`,
`src/emit/names.ts` `PC_VAR`/`EXC_VALUE`). `try-shape` stops the scaffolding
being emitted where it is provably redundant; `try-clean` deletes the residue
the emitter still had to print. Neither rung ever removes a `try`, a `catch`
body, or a `throw`.

---

## 1. Purpose

React Native bundles are try-heavy (every module body, every promise chain).
The M4 baseline prints, inside and around every function that contains one
guarded region:

* `let __exc;` and `let __pc = -1;` in the frame;
* `__pc = <blockId>;` at the head of **every** basic block of that function —
  including blocks that are nowhere near a `try` (`needsPc` is per function,
  not per region: `src/emit/function.ts:286`);
* `if (!(__pc >= lo && __pc <= hi)) { throw _excN; }` as the first statement of
  a handler whose lexical `try` over-reaches its bytecode region;
* `__exc = _excN;` as the next statement of every handler.

Owner-visible symptom (2026-09-05): "the code is not very readable at this
stage". The `__pc`/`__exc` residue metric (`00-LADDER.md` §6) is owned by
`try-clean` and `finally-dedup`; this spec ships the first half.

`try-shape` is stage A and annotation-only: it decides, from the structured
function and the exception regions, that a guard is redundant or a catch
binding is unread, and records that on the `try` node. `try-clean` is stage B
and deleting-only: it removes `__pc` stores, `__exc` copies, the `__pc = -1`
frame and an unread catch parameter, each with an independently re-derived
liveness argument.

---

## 2. Baseline shapes (measured, v94 and v99)

Method: `node src/cli.ts tests/fixtures/constructs/<fixture>/v{94,99}.hbc`
(default pipeline, 2026-09-05, this worktree). Counts are lines of output
containing the token, whole file, all functions.

| Fixture | v94 `__pc` / `__exc` / `catch` | v99 `__pc` / `__exc` / `catch` |
|---|---|---|
| 12-try-catch-finally-return | 6 / 4 / 2 | 6 / 4 / 2 |
| 13-try-finally-no-catch | 13 / 9 / 3 | 6 / 9 / 3 |
| 14-nested-try-catch | 22 / 12 / 5 | 12 / 11 / 4 |
| 15-catch-without-binding | 12 / 5 / 2 | 5 / 4 / 2 |
| 16-finally-with-break-continue | 28 / 7 / 4 | 29 / 7 / 4 |

Four shapes, identical at both versions (only their *frequency* differs — v94
structures fixtures 13/14/16 with more blocks, hence more per-block stores):

**S1 — frame.** `let __exc;` whenever the function has any exception region
(`cfg.regions.length > 0`), `let __pc = -1;` whenever any region in the
function needs a guard (`tryPlan.needsPc`).

**S2 — per-block store.** `__pc = <blockId>;` at the head of every
non-synthetic block, *function-wide* once `needsPc` holds. Measured outside any
`try` (13 v94: `__pc = 0;` before the `hasOwnProperty` prologue of the global
function, `__pc = 4;` after the last `try`), and — v99, fixture 16 — inside a
`for` header's update slot as a comma element:
`for (r1 = 0; r1 < r10; __pc = 11, r1 = r11 + r8)`. The store is always a
numeric literal; the emitter never reads `__pc` except in S3.

**S3 — range guard.** First statement of a handler whose lexical `try` body
contains a block outside `region.bodyBlocks`:
`if (!(__pc >= lo && __pc <= hi)) { throw _excN; }`, `[lo, hi]` =
`[min, max]` of the region's block ids. Measured: 15 v94 `[0, 0]`, 13 v94/v99
`[1, 1]`, 12 v94/v99 `[0, 1]`, 14 v94 `[1, 2]`, 16 v99 `[2, 3]` and `[14, 15]`.
Fixture 16 at **v94** is the irreducible case: the function is a `__state0`
dispatch nest (`src/structure/index.ts` §4.4), every `try` has `cfgBlock: -1`,
and the guard is not an optimisation — it is what selects the right handler.

**S4 — exception copy.** `__exc = _excN;` immediately after S3 (or first in
the handler when there is no guard), because `Catch r` lowers to `r = __exc`
(`src/emit/lower.ts:860`). After `expr-rebuild` the read appears either as a
surviving `rK = __exc;` (13 v94 `r0 = __exc;`) or folded into its consumer
(12 v94 `"from-catch:" + __exc.message`). Reads also occur **outside** any
handler: 16 v99 prints `r12 = __exc;` after the `try` statement, on the path
where the handler already ran — §4.2's "open read".

**Version coverage.** Rows 11 and 12 are ✅ verified at 94 and 99 only, and
this measurement adds nothing at 84/96/98: the `__pc`/`__exc` scaffolding is
emitter-side, not bytecode-side, so it is version-independent *by
construction*, but that is an argument, not a reading.
`docs/lowering/try-catch.md` §8 (added with this spec) records the measured
shapes and names 84/96/98 as unread for the scaffolding. Both rungs therefore
ship **without** a `Pass.versions` restriction (they key on emitter output and
on `ExceptionRegion`, both of which exist at every version) and with fixture
assertions at every version the fixture compiles at; the implementer must
report, not silently accept, any version where the shapes above do not appear.

---

## 3. IR / AST the rungs own

### 3.1 `try-shape` (stage A, `src/structure/ir.ts`)

Framework change **F22-1**: a `shape?: TryShape` field on the `try` node, in
the shape of `LoopForm` (an optional annotation the emitter prints from, and
which `sameShape` ignores):

```ts
export interface TryShape {
  /** No instruction in the handler reads `catchRegister`: the handler needs
   *  no `__exc = e` copy and no catch binding. */
  readonly bindsExc: boolean;
  /** `"redundant"`: the emitter's `__pc` range guard is provably always true
   *  when the handler runs, so it may be omitted. `"needed"` is the default
   *  and is never written by this rung (an absent `shape` means the same). */
  readonly guard: "needed" | "redundant";
}
```

Framework change **F22-2** (emitter, `src/emit/function.ts`):
`planTries` skips a region whose `try` node carries `shape.guard ===
"redundant"` (it contributes no `guard` entry and does not set `needsPc`); the
`case "try"` lowering emits the `__exc = param` copy and the catch binding only
when the node does not carry `bindsExc: false` **or** a guard was emitted for
that region (the guard's `throw _excN` needs the binding). `catch { }` needs
`param: string | null` on the AST `try` node (`src/emit/ast.ts:282`) and one
branch in `src/emit/print.ts:406`.

Framework change **F22-3** (`src/passes/tree.ts`): `canThrow(insn)` — `false`
only for a small whitelist read from the MIT Hermes `BytecodeList.def`
(`Mov`/`MovLong`, `LoadConst*`, `LoadParam`, `LoadThisNS`, `Jmp`/`JmpTrue`/
`JmpFalse`/`JmpUndefined` and their `Long` forms, `Ret`, `Catch`,
`Unreachable`), `true` for everything else, including every arithmetic and
comparison opcode (`valueOf` can throw) and every property access.

`try-shape` reads `try.region`, `try.cfgBlock`, `try.body`, `try.handler`,
`try.catchRegister` and `ctx.structured.graph`. It rewrites **nothing** but the
`shape` field: body and handler come out `===`-identical.

### 3.2 `try-clean` (stage B, `src/emit/ast.ts`)

Owns, in the *current function body only* (`ctx.fnBody`):

* `{ k: "expr", expr: { k: "assign", target: ident "__pc", value: number } }`
  statements, and the same assign as an element of a comma `seq` in a `for`
  header slot;
* `{ k: "expr", expr: { k: "assign", target: ident "__exc", value: ident p } }`
  as the handler-leading copy;
* `{ k: "init", kind: "let", name: "__pc", value: -1 }` and
  `{ k: "decl", kind: "let", names: ["__exc"] }`;
* the `param` field of a `try` node (set to `null` ⇒ `catch { }`).

It never touches the `try`'s `block`, its `handler` statements, the guard `if`
(that is `try-shape`'s business, upstream), or any `rN`.

---

## 4. Matcher — preconditions

### 4.1 `try-shape`

Site = one `try` node (post-order, innermost first). `match` returns `null`
unless all of:

* **P0** `node.shape === undefined` — checked *before* anything else, so an
  already-annotated tree is a fixed point without consulting `ctx` (PL-08).
* **P1** `ctx.structured !== undefined` and
  `ctx.structured.graph.cfg.regions[node.region]` exists with a non-empty
  `bodyBlocks`.
* **P2** `node.cfgBlock >= 0`. A `cfgBlock: -1` `try` is §4.4's dispatch nest
  (fixture 16 at v94): its lexical extent is the whole function and the guard
  *is* the handler selector. **Refuse.**

Then, independently, the two annotations:

**`guard: "redundant"`** iff, with `body = blocks of node.body` (the same walk
`planTries` does, skipping synthetic try-heads where
`graph.blocks[b].block === null`) and `[lo, hi] = [min, max] of
region.bodyBlocks`:

> for every `b` in `body \ region.bodyBlocks`: `lo <= b <= hi`, **or** no
> instruction of `b` satisfies `canThrow`.

Soundness: the guard can only be consulted when the handler runs, i.e. when
some block *lexically inside the `try`* threw. Every non-synthetic block emits
`__pc = <its id>` as its first statement (S2), and a synthetic block has no
bytes and cannot throw, so at the moment of a throw `__pc` holds the id of the
throwing block. A block in `region.bodyBlocks` is in `[lo, hi]` by
construction; an over-reaching block is either in `[lo, hi]` too, or cannot
throw and so is never the value read. In both cases the guard evaluates true
and the `throw _excN` is dead. (If `body \ region.bodyBlocks` is empty the
emitter prints no guard anyway; annotating is harmless and the rung still does
so, which is what makes the annotation a stable, checkable statement about the
node rather than about the emitter's mood.)

**`bindsExc: false`** iff no instruction in the handler subtree
(`blocksOf(node.handler)`, all of them, plus any block those blocks contain via
nested nodes) **reads** register `node.catchRegister`. The leading
`Catch <catchRegister>` is a write and does not count; a later *write* of the
same register does not rescue a read before it — a single read anywhere in the
handler refuses the annotation. Nested functions cannot see a register, so no
closure clause is needed.

Refusals (each a distinct, counted `abandoned` reason): `already-annotated`,
`no-structured-context`, `dispatch-nest`, `region-missing`,
`over-reach-can-throw`, `handler-reads-catch-register`, and `nothing-to-say`
(neither annotation applies).

### 4.2 `try-clean`

Site = the whole current function body: `match(list, ctx)` returns `null`
unless `list === ctx.fnBody` (F1). One site per function; the rewrite is the
whole list. This is what makes the liveness reasoning below whole-function and
the rung a one-shot fixed point.

Whole-function preconditions (any failure ⇒ `match` returns `null`, nothing is
deleted):

* **C1** `identUses(list, "__pc").nested === 0` and
  `identUses(list, "__exc").nested === 0` — no nested function captures either
  name. (The emitter never emits such a capture; an obfuscated or
  hand-modified input might.)
* **C2** every **read** of `__pc` in the function occurs inside a *guard*: an
  `if` whose test is `!(__pc >= <num> && __pc <= <num>)`, whose `then` is a
  single `throw <ident>`, whose `else` is empty, and which is the **first**
  statement of some `try` node's `handler`. Any other read of `__pc` — refuse.
* **C3** for every `try` node in the function, the first statement of its
  `handler` after the optional guard is `__exc = <that try's param>`. Any
  handler that does not start that way — refuse. (This is what lets §4.2's
  domination argument treat each handler's own copy as covering the reads
  inside it. After a successful rewrite this precondition fails, which is
  precisely why the second run deletes nothing: PL-08 by construction.)
* **C4** for every *guarded* `try` `T` (one whose handler contains a guard),
  the first statement of `T.block` is either a `__pc = <num>` store or a
  nested `try` whose `block` recursively satisfies C4. If not, the rung deletes
  **no** `__pc` store in this function (the `__exc` deletions below still
  apply): without an entry-dominating store, a stale `__pc` from before the
  `try` could be the value the guard reads.

**Liveness — `__pc` stores.** Let `G` = the guarded `try` nodes (C2 located
every read; each read belongs to exactly one handler). Then:

> A `__pc` store is **live** iff it is lexically inside `T.block` for some
> `T` in `G` (at any depth, including inside a nested `try`'s handler that sits
> in that block). Every other `__pc` store is **dead** and is deleted.

Why sound. A guard of `T` reads whatever store executed last before the throw.
By C4 the first statement executed inside `T.block` is a `__pc` store that this
rule keeps (it is inside `T.block`), so no store from before the `try` can
still be the value read. Stores inside `T.block` are all kept. A store that is
in no guarded `try`'s block therefore cannot be observed: the only reads are
guards, and each guard's read is dominated by a kept store. Corollary: if
`G` is empty every store is dead, which is the case `try-shape` engineers.
Conversely, **a handler that dispatches on `__pc` keeps every store that can
reach it** — the whole of `T.block`, unconditionally, no exceptions, no
per-store cleverness. That coarseness is deliberate: it is the part of the
argument a reviewer can check by eye.

**Liveness — `__exc` copies.** Attribute every **read** of `__exc` to the
innermost enclosing handler that owns a copy (C3 guarantees each handler has
one, and the copy precedes every statement of that handler). A read with no
such enclosing handler is an **open read** (fixture 16 v99's `r12 = __exc;`
after the `try`). Then:

> If the function contains any open read, **no** `__exc` copy is deleted.
> Otherwise, the copy of handler `H` is deleted iff no read of `__exc` is
> attributed to `H`.

Why sound: with no open read, every read executes inside the handler whose copy
covers it, and that copy is kept by the rule; a deleted copy has no read
attributed to it, so nothing observes the value it wrote.

**Frames.** `let __pc = -1;` is deleted iff no `__pc` reference of any kind
survives in the function; `let __exc;` iff no `__exc` reference survives.

**Catch parameter.** A `try`'s `param` is set to `null` iff, after the
deletions above, the handler subtree contains no `ident` read of that name.
(The guard's `throw _excN` is such a read, so a guarded handler always keeps
its binding — the two rungs stay independent.)

**`for`-header stores.** A `__pc` store that is one element of a comma `seq`
in a `for` init/update slot is deleted like any other, provided the `seq` has
at least two elements. If it is the only element, the store is kept
(refusal reason `sole-seq-element`) — emptying a `for` slot is a shape change
this rung does not own.

Refusal reasons: `not-function-body`, `nested-capture`, `non-guard-pc-read`,
`handler-prologue-shape`, `no-entry-store` (C4, pc part only),
`sole-seq-element`, `nothing-dead`.

---

## 5. Writer

`try-shape.rewrite` returns `{ ...node, shape }` with `body` and `handler`
untouched (`===`). Nothing else in the tree changes. The emitter then prints
one of: no guard (`guard: "redundant"`), `catch { }` with no `__exc` copy
(`bindsExc: false` **and** no guard for that region), or the baseline.

`try-clean.rewrite` returns the function body with exactly the declared
deletions applied, in one traversal, and records the deletions in its `Match`
data as a list of `{ path, kind }` (`kind` in `pc-store`, `exc-copy`,
`pc-frame`, `exc-frame`, `catch-param`) so the checker can re-insert them
(§6). Statement order, statement identity and every other field are preserved:
the rewrite is a filter, never a rebuild of an unrelated node.

---

## 6. Checker

### 6.1 `try-shape` — annotation-only (00-LADDER §4.3)

1. `sameShape(before, after)`: same node kinds, same `cfgBlock`s, same block
   multiset, same labels — only `shape` differs.
2. Re-derive the annotation **from `before` and `ctx`**, by calling
   `match(before, ctx)` again and comparing every field of `shape` (the
   `loop-cond`/`for-header` discipline: never trust the writer's own
   annotation; a flipped `bindsExc` or a `guard: "redundant"` the matcher would
   not have produced is rejected here).
3. Independently of `match`, re-walk the over-reach set and assert the §4.1
   predicate directly (`canThrow` over each over-reaching block's
   instructions), and re-scan the handler blocks for a read of
   `catchRegister`. Both must agree with `shape`.

Note — deviation from `00-LADDER.md` §4.3, which lists `try-shape` under
*CF-preserving*: as specified here the rung is strictly **annotation-only**,
which is the stronger obligation (`sameShape` implies the CF-preserving
block-multiset equality with an empty declared-duplicate set). The ladder row
anticipated a rung that rewrote the handler prologue; the prologue is emitter
output, so that work is F22-2 instead. Update §4.3's row when this lands.

### 6.2 `try-clean` — expression-only, *deleting* variant

A deleting rung has no byte-identical undo. Four independent obligations, in
`check.ts`, computed by their own walker over `before`/`after` — none of them
may reuse the matcher's liveness result:

1. **Undo by re-insertion.** Re-insert the declared deletions (the `Match`
   data of §5) into `after`; the result must be structurally deep-equal to
   `before`. This is the deleting analogue of the alpha-renaming rungs'
   byte-identical undo, and it is what makes "the rung only deleted" a
   *proved* statement rather than a claim: any other edit, anywhere in the
   function, fails here.
2. **Declared-deletion effect equality.** `effectSequence(before)` with the
   declared deleted effects removed, in order, must deep-equal
   `effectSequence(after)` (`00-LADDER.md` §4.3's expression-only check,
   relaxed exactly as the CF-preserving class is relaxed by declared
   duplicates — a `__pc`/`__exc` store is an assign to a non-`rN` name and so
   *is* an effect; without this clause no deletion could pass). Plus
   `parses(after)`.
3. **Independent liveness.** For each deleted `__pc` store: recompute the
   guarded-`try` set from `before` and assert the store's position is inside
   none of their `block`s, and assert C4 holds for every guarded `try`. For
   each deleted `__exc` copy: recompute the read attribution from `before` and
   assert zero open reads and zero reads attributed to that copy's handler.
   For each deleted frame: assert `identUses(after, name).reads === 0` and
   `.writes === 0`. For a dropped `catch` param: assert the name has no read in
   that handler's subtree in `after`.
4. **No new free name, no orphan read.** `freeNames(after)` is a subset of
   `freeNames(before)`, and `after` contains no read of `__pc`/`__exc` whose
   only writes were deleted (a direct re-check of 3 from the other end,
   cheap, and the one that catches an off-by-one in the path arithmetic).

Rejection is a `CheckResult { ok: false, reason }`; the driver abandons the
site and the baseline output stands.

---

## 7. Ordering, refusals, fixtures, metrics

**Registration.** `try-shape` goes in `REGISTRY` in stage A immediately before
`label-clean`, declaring `before: ["label-clean"]`. `00-LADDER.md` §1.1 also
asks for `after: ["finally-dedup"]` — **that must not be written yet**:
`enabledPasses` throws `E_PASS_ORDER` for a dependency on a pass that is not in
the registry (`src/passes/registry.ts`), and `finally-dedup` is an unbuilt hard
rung. Ship `before: ["label-clean"]` with a comment naming the constraint, and
add `after: ["finally-dedup"]` in the commit that lands `finally-dedup`.
`try-clean` goes in stage B inside the structure-recovery block (D23),
immediately after `object-literal` and before `jsx-recover`, declaring
`after: ["expr-rebuild"]` (PL-11 injects it anyway) and
`before: ["fn-naming", "reg-split", "var-naming"]`.

**Interaction.** `try-shape` does the volume: annotating every guard in a
function as redundant clears `needsPc`, and the emitter then prints *no*
`__pc` store at all. `try-clean` cleans what is left when one guard survives
(fixtures 12, 13, 14, 16), plus every `__exc` copy and both frames. Neither
depends on the other for correctness: `try-clean` re-derives liveness from the
AST it is given and is correct with `try-shape` skipped, which is what the
`--no-pass try-shape` acceptance tests assert.

**Refuses, in one list.** Dispatch-nest tries (`cfgBlock: -1`, fixture 16 at
v94); a handler that reads `__pc` keeps every store in its `try` block;
a handler that reads the catch register keeps its binding and its copy;
an open `__exc` read anywhere keeps every copy; a `__pc` read that is not a
guard, or a handler prologue in an unexpected shape, refuses the whole
function; a guarded `try` without an entry-dominating store refuses all `__pc`
deletion in that function; a lone comma-`seq` store stays.

**Fixtures.** 12 (catch + finally + return, guard `[0, 1]`, live inner copy),
13 (finally, no catch, guard `[1, 1]`, surviving `rN = __exc` read),
14 (nested, guards at two depths, a store in an inner handler that is inside an
outer guarded block — the case the coarse rule must keep), 15 (no binding: the
one fixture where everything goes — guard removable, copy dead, `catch { }`),
16 (break/continue in `finally`: the v94 dispatch-nest refusal and the v99
`for`-header comma store). No new construct fixture is needed; the acceptance
tests use hand-built ASTs for the unit-level rules and rung-owned property
assertions (counts and regexes on 12-16, never a whole-output comparison —
CLAUDE.md testing rules, `docs/CONSOLIDATION.md` §B item 7).

**Metrics.** `00-LADDER.md` §6's `__pc` / `__exc` residue row. Report, per
fixture x version x variant: `__pc` stores before/after, guards before/after,
`__exc` copies before/after, functions with zero `__pc` references
(the headline number), and each rung's abandoned-reason histogram. The
acceptance bar for the batch is: strictly fewer `__pc` stores at every version
of 12-16, zero `__pc` and zero `__exc` in fixture 15's `tryParse` at every
version, no fixture losing its PASS verdict, and `--passes=none` byte-identical
(PL-05).

**Open questions for the implementer.**

1. *`expr-rebuild` ordering (PL-11).* `__pc`/`__exc` stores are ordered
   effects, so `expr-rebuild` will not fold an impure value across them —
   running `try-clean` first would let it fold more, but PL-11 pins
   `expr-rebuild` first in stage B. Measure the difference (how many extra
   folds a second `expr-rebuild` run after `try-clean` would win) and report
   it; do not change PL-11 in this batch.
2. *`bindsExc` vs the guard.* When a guard survives, the binding must survive
   (its `throw _excN`). If measurement shows this blocking most `catch { }`
   recoveries, the follow-up is `try-shape` proving the guard redundant more
   often, not `try-clean` rewriting the guard.
3. *84/96/98.* §2 is read at 94 and 99. Confirm the four shapes at the other
   three versions while running the fixture tests, and update
   `docs/lowering/try-catch.md` §8 with what you see.
