# 21 — `for-in` and `for-of` (stage A, catalogue rows **9** and **10**)

Two rungs, one spec: they are the two `iter` variants of the same
`LoopForm` extension (`docs/specs/passes/00-LADDER.md` §7.3), they claim the
same slice of the tree (§3.1 ownership row: "`loop.form`, the preceding
`block`, the `try`+handler that holds abrupt `IteratorClose`"), they share
one checker class (§4.3 **Annotation-only**), and they must not be able to
match each other's shapes.

Evidence: `docs/lowering/for-in.md` and `docs/lowering/for-of.md`, both
re-read at **v99** on 2026-09-05 (this spec's prerequisite; catalogue rows 9
and 10 moved to ✅ verified in the same commit). Fixtures:
`05-for-in-object`, `06-for-of-array`, `07-for-of-iterable`.

Batch 2 of the ladder. Acceptance tests: `tests/gate/passes/for-in.test.ts`,
`tests/gate/passes/for-of.test.ts` (shipped with this spec, `skip`ped until
the rungs land — see §8).

---

## 1. Purpose

The M4 baseline has no way to print either statement. A `for...in` loop
comes out as a labeled block wrapping a `while (true)` whose body opens with
a `GetNextPName` helper call and a hand-written undefined test; a `for...of`
comes out as the same, plus a `try`/`catch` that exists only to call
`IteratorClose` and rethrow — machinery the source never wrote and the
reader has to recognise before they can see the loop. Every React Native
bundle contains both idioms in quantity (array destructuring and spread lower
through the *same* iterator opcodes, rows 17/22 — those sites are
`destructure`/`spread-rest`'s and this rung must refuse them, §4.4).

Correctness is not at stake: both rungs are **annotation-only**. They add a
`form` to the `loop` node and change nothing else, so the worst outcome of a
wrong match is a wrong *print*, which is why §6's checker restates the
semantic claim rather than trusting the match.

---

## 2. Baseline shapes measured (v94 and v99)

Full dumps in the two lowering docs. What the *tree* looks like — this is
what the matcher sees, and it is not what the lowering docs' §4 sketches
suggest, because the Ramsey structurer sinks the loop's exit continuation
**inside** the loop:

### 2.1 `for-in` (fixture 05, byte-identical tree at v94 and v99)

```
labeled L0 {                     ; the shared exit target of BOTH guards
  block bS                       ; ... ; GetPNameList e, obj, idx, size ; JmpUndefined L0, e
  if bS { break L0 } else { }    ; "nothing enumerable at all" guard
  loop L1 {
    block bH                     ; GetNextPName k, e, obj, idx, size ; JmpUndefined L0, k
    if bH { break L0 } else { }  ; "exhausted" guard, SAME exit
    block bB                     ; the body
    continue L1
  }
}
```

`loop-cond` does **not** form this loop, at either version: `matchHead`
requires the head block to hold exactly one instruction (`insns.length !== 1`
→ refuse) and requires the exit branch to be `break <loop label>`, whereas
here it is `break L0`, the label of the enclosing block. So the `for-in`
rung matches an **unformed** loop and writes the `form` itself. (Checked
against the `passes=` header line of `--emit-tree` on 05 at v94 and v99:
only `if-chain` and `label-clean` fire.)

### 2.2 `for-of` (fixtures 06, 07 — same tree at v94 and v99)

The clean shape (no `break` in the source; fixture 06's second and third
loops, all three of fixture 07's):

```
loop L {
  block bH                       ; [Mov s', src ;] IteratorNext v, state, s' ; Mov t, state
                                 ; JStrictEqual EXIT, t, <undef reg>
  if bH { EXITCONT } else { }    ; EXITCONT = the whole continuation, sunk inside
  try rC (head bT) {
    block bB…                    ; the body
    continue L
  } catch rX {
    throw bC                     ; bC = Catch rX ; IteratorClose state, 1 ; Throw rX
  }
}
```

With a `break` in the source (fixture 06's first loop) the body additionally
holds a nested `try` and a `block` ending `IteratorClose state, 0` followed
by a `break` out to the exit label. The `IteratorBegin state, src` sits in
the last instructions of the `block` that immediately precedes the loop.

**v99 deltas that a matcher must absorb** (`docs/lowering/for-of.md` §7):

* `IteratorNext`'s **source** operand is a per-iteration `Mov` copy made in
  the header (`Mov r7, r6; IteratorNext r7, r4, r7`) and **aliases the
  destination register**. Do not require `next.src === begin.src`; do not
  require the three operands distinct. Resolve `next.src` back through
  header `Mov`s.
* the **normal** (`break`-path) `IteratorClose` is preceded by a `Mov` of
  the state register into a scratch (`Mov r0, r4; IteratorClose r0, 0`).
  The **abrupt** close in the handler is not copied at either version.
* v94 splits the protected range into **two** `.try` entries pointing at the
  one handler; v99 emits **one**. Accept one-or-more.

`for-in` has **no** v99 delta at all: same opcodes, same operand counts,
same two `JmpUndefined`s onto one exit.

---

## 3. IR the rungs own — and the framework work they need first

`LoopForm` (`src/structure/ir.ts`) gains the `iter` variant declared by
LADDER §7.3. Widened here to what the emitter actually needs; all of it is
re-derivable from the CFG, and every field exists so the emitter can check
that the shape is still *where declared* and fall back to `while` when it is
not, exactly as `init`/`step` do today:

```ts
export interface IterForm {
  readonly kind: "for-in" | "for-of";
  /** The block whose terminator is the exhaustion test (the `if`'s block). */
  readonly cond: BlockId;
  readonly at: "head";
  /** True when the taken edge of `cond` leaves the loop. */
  readonly negate: boolean;
  /** Block holding GetNextPName / IteratorNext. Equal to `cond` in every
   *  shape measured; kept separate so a future split header still works. */
  readonly iter: BlockId;
  /** Block whose tail holds GetPNameList / IteratorBegin (the loop's
   *  preceding `block` sibling, or the enclosing labeled block's first). */
  readonly setup: BlockId;
  /** Blocks ending in `IteratorClose` that the rung is dropping. Empty for
   *  `for-in`; 1..2 entries for `for-of` (normal close per `break`, plus
   *  the one abrupt close in the handler). */
  readonly close: readonly BlockId[];
  /** Register the per-iteration binding lands in (`k` / `v`). */
  readonly binding: number;
  /** Register holding the enumerated object / the iterable. */
  readonly source: number;
}
export type LoopForm = WhileForm | IterForm;   // WhileForm = today's shape
```

**Framework prerequisites** (none of them pass code; all of them are the
implementer's first commit, ahead of either rung):

1. `LoopForm` widened as above; `src/structure/verify.ts` keeps treating
   `form` as transparent.
2. `src/emit/ast.ts` gains
   `{ k: "for-in" | "for-of"; label; decl: "const" | "let" | "var" | null;
   left: Expr; right: Expr; body: Stmt[]; origin? }` and `src/emit/print.ts`
   prints it. There is no such node today (only `while`/`do-while`/`for`).
3. `src/emit/function.ts`'s `lowerFormedLoop` learns the `iter` kinds:
   * body = the loop body **minus** the header `block` and the header `if`,
     and minus the `try` *wrapper* whose handler is exactly `form.close`'s
     abrupt block (the try's *body* is kept, the handler is dropped);
   * the header `if`'s exit arm (`negate ? then : else`) is printed
     **after** the loop — the structurer sank it inside, and hoisting it at
     print time is what keeps the rewrite annotation-only;
   * `form.setup`'s trailing `GetPNameList`/`IteratorBegin` (and, for
     `for-in`, the guard `if` that follows it in the same statement list)
     are suppressed;
   * a `block` that is exactly a normal `IteratorClose` + its `break` prints
     as a bare `break`;
   * **fallback**: if any of `cond`/`iter`/`setup`/`close` is not where the
     annotation declares, print the loop as `while` and print every block —
     the same discipline `init`/`step` already use. Nothing is ever dropped
     on the strength of an annotation the emitter cannot re-find.
4. `registerLiveAfter(fn, block, index, reg)` added to `src/passes/tree.ts`
   (LADDER §4.1 lists it; it does not exist yet). One conservative
   implementation, shared with `for-header`: walk forward over the CFG from
   `(block, index)`; `true` unless every path either writes `reg` before
   reading it or ends. Unknown → `true` (conservative = refuse the site).
5. `lastInstruction`, `precedingSibling` (LADDER §4.1) — both rungs need them
   and both shipped loop rungs open-code them.

Neither rung may import `src/emit` or `src/cfg` (D12a); everything above is
reached through `ctx.structured` and `src/passes/tree.ts`.

---

## 4. Matcher — preconditions

Both matchers run on a `loop` node in post-order, and both begin:

* **P0.** `node.k === "loop"`; `node.form === undefined`. A loop `loop-cond`
  or `for-header` already formed is **refused** — measured shapes are never
  formed (§2), so this costs nothing and guarantees the two annotations can
  never fight. (This is also the PL-08 fixed point: a second run sees
  `form !== undefined` and returns `null`.)
* **P1.** `ctx.structured !== undefined`, and every block the matcher reads
  has real instructions (`instructionsOf` non-null) and is not in
  `fn.duplicatedBlocks`.
* **P2.** the loop's body has exactly one back edge to the loop label
  (`usesOf(node.body, node.label).continues === 1`) and it is the last
  statement of the body's normal path. A second `continue` means a source
  `continue` statement, which is fine for the *printed* form but is a shape
  the writer has not been measured against — refuse in v1 and record it
  (§7 refusal table).

### 4.1 `for-in` preconditions

3. **Header.** `items(node.body)[0]` is `block bH`, `[1]` is `if` on `bH`.
   `instructionsOf(bH)` is exactly two instructions:
   `GetNextPName k, e, obj, idx, size` then `JmpUndefined _, k` whose
   register operand is that same `k`.
4. **Setup.** The loop's preceding sibling (`precedingSibling`) is
   `block bS`, and `bS`'s last two instructions are
   `GetPNameList e', obj', idx', size'` then `JmpUndefined _, e'`, with
   `e' === e`, `obj' === obj`, `idx' === idx`, `size' === size` — the four
   registers must be *identical*, not merely compatible.
5. **One exit, reached twice.** The statement after `bS` in that list is an
   `if` on `bS` one of whose arms is `break L0`; the header `if`'s exit arm
   is `break L0` for the **same** label `L0`; and `L0` is the enclosing
   `labeled` node. This is `docs/lowering/for-in.md` §6's "both guards
   target the same block", expressed on the tree.
6. **The enumerator and the scratch pair are private.** `e`, `idx` and
   `size` are written by nothing but the `GetPNameList`/`GetNextPName` pair
   and read by nothing else, anywhere in the function. Scan every block of
   `fn` — these are not JS values and a program that touches them is not a
   `for...in`. (`writtenRegisters` + an operand scan.)
7. **The binding does not escape as enumerator state.** `k` may be read
   freely inside the body (it is the loop variable) but must not be live
   after the loop: `registerLiveAfter(fn, cond, <index of JmpUndefined>, k)`
   is `false`. If it is live, the source wrote `for (k in o)` over an outer
   variable and the writer's `const` would be wrong; refuse in v1 (§7).

### 4.2 `for-of` preconditions

3. **Header.** `items(node.body)[0]` is `block bH`, `[1]` is `if` on `bH`.
   `instructionsOf(bH)`, after **dropping leading `Mov`s** (v99, §2.2), is
   `IteratorNext v, state, src'` ; `Mov t, state` ; `JStrictEqual _, t, u`
   where `u` is a register holding `undefined` at loop entry
   (`valueAtLoopEntry(fn, setupBlock, u) === undefined`) and `t` is used by
   nothing else. `src'` resolves through the header `Mov`s to `src`.
   Either operand order of the `JStrictEqual` is accepted; `JStrictNotEqual`
   with the opposite polarity is accepted too.
4. **Setup.** The loop's preceding sibling is `block bS` holding
   `IteratorBegin state', src''` with `state' === state`, and
   `src''` the same register `src'` resolved to.
   *Corrected 2026-09-05, landing measurement:* it is the block's **last**
   instruction only at v84/v94. v96/v98/v99 schedule the body's own constant
   loads after it (`IteratorBegin r4,r6 ; LoadConstUInt8 r5,30`,
   `06-for-of-array`), so the rung takes the **last** `IteratorBegin state,
   src` in the block and requires only that nothing after it names either
   register — which is what "nothing between the `IteratorBegin` and the
   loop" was really asserting. The emitter drops that one instruction
   (a per-block skip set), not a trailing range.
5. **Abrupt close.** The body's `try` node (the outermost one whose body
   holds the back edge) has a handler that, ignoring nothing, is exactly
   `Catch rX` ; `IteratorClose state, 1` ; `Throw rX` — three instructions,
   same `state`, and `rX` read by nothing else. If the handler is anything
   else it is a **user** `try`/`catch` and the site is refused outright (the
   lowering doc's §6 rule; `try-shape` owns that region, not this rung).
   A `for-of` with **no** such handler is refused: it means the compiler did
   not emit iterator cleanup, i.e. this is not the measured idiom.
   *Added 2026-09-05, landing measurement:* a loop containing a source
   `break` gets, at **v84/v94/v96**, a second `try` around the break path
   (its own `IteratorClose`-then-`break` needs exception safety too), and the
   two regions then **share one handler**. Neither `try` names it as its own
   `handler` field: both carry `break <mergeLabel>` to a `labeled` wrapper
   whose *following sibling* is the real `Catch; IteratorClose state, 1;
   Throw` — the `AugmentedCfg` "a handler shared by several regions becomes a
   merge point" case. The rung descends one `labeled` level to find the `try`,
   resolves the handler through the wrapper, records the wrapper's label as
   `IterForm.mergeLabel`, and **refuses the whole site** if any nested `try`
   in the body resolves to a different cleanup block (that is a user `try`).
   The emitter drops the wrapper, both handlers and the sibling `throw`.
   v98/v99 emit the ordinary single-`try` shape for the same source.
6. **Normal closes.** Every other `IteratorClose state, 0` reachable in the
   body must sit in a `block` that is immediately followed by a `break` out
   of the loop (possibly through a labeled block), with only `Mov`s between
   the close and the block's other instructions (v99, §2.2).
   Any `IteratorClose` that is not one of these, or that names a register
   other than `state`, refuses the site.
   *Refined 2026-09-05, landing measurement:* v99 spells the close
   `Mov r0, state ; IteratorClose r0, 0 ; Jmp`, so (a) the close's operand is
   resolved through the block's own leading `Mov`s before it is compared with
   `state` — `closeStateOf`, shared with §6's checker so both stages ask the
   same register — and (b) the close need not be the block's literal last
   instruction, but the block is deleted whole, so it may hold **nothing but**
   `Mov`s, the close, and its own unconditional jump, and every scratch
   register those `Mov`s write must be dead after the block.
7. **State is private and dead after.** `state` is written only by
   `IteratorBegin`/`IteratorNext`, read only by
   `IteratorNext`/`IteratorClose` and the header's exhaustion `Mov`, and
   `registerLiveAfter(fn, cond, <index of the test>, state)` is `false`
   at every exit. This is the semantic predicate LADDER §4.3 names for this
   rung; §6 restates it.
8. **The binding is not live after the loop** — as `for-in` P7.

### 4.3 The two rungs must not see each other

`for-in`'s P3 requires `GetNextPName`; `for-of`'s P3 requires
`IteratorNext`. No block can hold both in the measured shapes, and each
matcher returns `null` on the other's opcode before reading anything else.
An acceptance test asserts that directly (a `for-of` fixture yields zero
`for-in` sites and vice versa) rather than leaving it to inspection.

### 4.4 Not this rung's sites (hard refusals, not gaps)

`IteratorBegin`/`IteratorNext` also lower **array destructuring** (row 22,
`destructure`) and **array spread** (row 17, `spread-rest`). Those sites have
no `loop` node at all — they are straight-line, or a labeled-block run — so
P0 already excludes them. The **nested** pair inside fixture 07's
`for (const [k, v] of m)` is a destructuring site *inside* a genuine for-of
body: the outer loop matches, the inner pair does not (no loop), and the
rung must not follow the inner `state` register when checking P7 of the
outer one. An acceptance test pins fixture 07 for exactly this.

---

## 5. Writer

Annotation only:

```ts
return { ...loop, form: { kind: "for-in", cond, at: "head", negate, iter,
                          setup, close: [], binding, source } };
```

and the `for-of` twin with `close` populated. No node is added, removed,
moved or rebuilt; `sameShape(before, after)` holds by construction.

**Printed form** (produced by the emitter from the annotation, §3.3):

```
for (const <name> in <obj>)  { … }
for (const <name> of <src>)  { … }
```

**`const` vs `let` vs `var`.** The declaration keyword is a claim about the
*binding*, and the bytecode does not carry one, so the rule is:

* **`const`** when the binding register `binding` is (a) written by nothing
  but the `GetNextPName`/`IteratorNext` itself anywhere in the function, and
  (b) not captured by any inner closure (`CreateClosure`/`CreateEnvironment`
  store of that register), and (c) not live after the loop (§4 P7/P8). Every
  measured fixture site satisfies all three, and this is what the source
  wrote.
* **`let`** when (a) fails only because the body assigns to the register
  (`for (let k in o) { k = f(k); … }` is legal) but (b) and (c) still hold.
* **`var`**, or a **bare assignment target** with no keyword
  (`for (k in o)`), when (c) fails — the binding outlives the loop, so it is
  not the loop's own. **v1 refuses this case entirely** (§4 P7): D14 says
  print what the bytecode does, and hoisting a `var` into the enclosing
  scope is a change this rung has not measured. Recorded in §7.
* Never a per-iteration `let` claim: Hermes shares one binding across
  iterations (D14), which `const` in `for...of` also does per JS semantics,
  so the two agree — but a closure capturing the binding would make the
  difference observable, which is why (b) is a `const` precondition and a
  capture forces `let`.

The name itself is not this rung's business: it stays `rN` until
`var-naming` runs (D23 — `var-naming` renames it like any other register).

---

## 6. Checker — **annotation-only** (LADDER §4.3)

`check(before, after, ctx)`:

1. `sameShape(before, after)` — the whole obligation on the tree. (Stronger
   than `loop-cond`'s block-multiset check, and available to us because
   nothing is hoisted in the tree.)
2. `after.k === "loop"` and `after.form !== undefined` with
   `form.kind === "for-in"` / `"for-of"`; `before.k === "loop"` and
   `before.form === undefined`.
3. **Recompute, never trust the writer.** Re-run this rung's own `match` on
   `before` with the same `ctx` (the `for-header`/`loop-cond`/`expr-rebuild`
   discipline). It must produce a site, and every field of `after.form` must
   equal the recomputed one — `cond`, `iter`, `setup`, `negate`, `binding`,
   `source`, and `close` element-for-element in order. A flipped `negate`,
   a swapped `binding`/`source`, or a dropped `close` entry dies here; the
   `checker-mutation-stagea` gate test exists to prove it.
4. **The semantic predicate** the annotation asserts, restated on `after`
   and computed independently of `match`:
   * *for-in*: the enumerator `e` and the scratch pair `idx`/`size` are read
     and written by nothing but the two `PName` opcodes; both `JmpUndefined`
     guards leave to the same label; `registerLiveAfter(binding)` is false.
   * *for-of*: `state` is read by nothing but `IteratorNext`/`IteratorClose`
     and the header's exhaustion compare; **`state` is not read after any
     `IteratorClose`** and not live after the loop
     (`registerLiveAfter(fn, closeBlock, closeIndex, state) === false` for
     every block in `form.close`, and at the loop's normal exit);
     `registerLiveAfter(binding)` is false.
   * both: `form.close` names only blocks whose last non-`Mov` instruction
     really is an `IteratorClose` on `state` — the emitter is about to drop
     them, so the checker proves they are droppable.

Nothing here re-derives anything from `match`'s captured `data`: `check`
gets `before`, `after` and `ctx`, and re-reads the CFG.

---

## 7. Ordering, refusals, fixtures, metrics

**Ordering.** Both: `after: ["loop-cond", "for-header"]`,
`before: ["if-chain", "label-clean"]`. Registered in `src/passes/registry.ts`
between `for-header` and `switch-raise`, i.e. inside stage A's
structure-recovery block, far ahead of D23's renaming boundary.

* *After `loop-cond` and `for-header`* — LADDER §2's "they annotate or nest
  inside a formed loop". In the measured shapes neither predecessor fires,
  but the ordering is what lets P0 be a flat "already formed → refuse"
  instead of a race.
* *Before `if-chain`* — `if-chain` flattens `else` spines, and both header
  guards here are `if … { break } else { }`, the degenerate spine shape.
  Today `if-chain` fires on fixture 05 before anything else; once these
  rungs land it must see an already-annotated loop and leave the header
  guard alone. **The implementer must add the corresponding refusal to
  `if-chain` (an `if` whose block is some loop's `form.cond`) in the same
  commit, with its own regression test.** This is the one cross-rung change
  in this spec and the most likely source of a landing surprise.
* *Before `label-clean`* — it is last in stage A by construction, and the
  `for-in` shape's enclosing `labeled L0` becomes dead once the emitter
  prints the loop, so `label-clean` should get the chance to remove it.

**Refusals left open** (each is "print `while`", never a wrong loop):

| Shape | Why refused in v1 | Ledger |
|---|---|---|
| a loop `loop-cond`/`for-header` already formed (P0) | the two annotations would fight; unmeasured | `docs/BUGS.md` `for-iter-preformed` |
| a source `continue` in the body (a second back edge, P2) | the writer has not been measured against it | `docs/BUGS.md` `for-iter-continue` |
| binding live after the loop (`for (k in o)` over an outer `k`) | needs a `var`/bare-target decision D14 has not been made for | `docs/BUGS.md` `for-iter-outer-binding` |
| a user `try`/`catch` around a `for-of` body (§4.2 P5) | the handler is not the synthesized one; `try-shape` owns it | `docs/BUGS.md` `for-of-user-try` |
| `for await (… of …)` | not measured at any version; no fixture | `docs/BUGS.md` `for-await-unmeasured` |
| destructuring/spread iterator sites (§4.4) | not loops; other rungs' rows | not a bug — asserted by test |

Every row above must exist in `docs/BUGS.md` when the rungs land
(CLAUDE.md's "no fixture leaves the gate without a BUGS.md row"; here it is
the refusal table that needs the rows).

**Fixtures.** `05-for-in-object` (two `for...in` loops, one over a
prototype-enumerable object), `06-for-of-array` (three loops: one with
`break`, one plain, one over a sparse array), `07-for-of-iterable` (Map with
entry destructuring, Set, hand-rolled `[Symbol.iterator]`). All five HBC
versions, already built. **No new fixture is required** and none is added:
the three cover every measured shape including the two hard cases (a `break`
with its normal `IteratorClose`, and a nested destructuring iterator inside a
for-of body). Refusal cases are hand-forged `synthCfg` trees in the
acceptance tests, not fixtures — they are shapes hermesc does not emit.

**Metrics.** Reported in the landing report: for `05`/`06`/`07` at all five
versions, (a) `for (… in …)` / `for (… of …)` statement counts in the
decompiled output — expected 2 / 3 / 3 per version, (b) residual
`IteratorClose`/`GetNextPName` mentions — expected 0, (c) `runTier` verdicts
— all must stay PASS, (d) the same three counts over the rn-template and
react-navigation bundles, before/after.

---

## 8. How the acceptance tests are gated

`tests/gate/passes/for-in.test.ts` and `tests/gate/passes/for-of.test.ts`
ship with this spec and are marked
`{ skip: "spec 21 acceptance — unimplemented" }`. There is no other
mechanism in this repo: `object-literal`'s acceptance tests landed in the
same commit as its implementation (`3b0ec3a`), so nothing pre-existing
covers "spec lands before code". Each file loads the rung through a
**runtime-computed** specifier (`await import(new URL(...).href)`) so that
`tsc --noEmit` does not fail on a module that does not exist yet.

**The implementer removes the `skip` option from every test in both files in
the landing commit.** Nothing else in them may change: they are the
acceptance criteria. If one of them is wrong, that is a `docs/PUSHBACK.md`
row, not an edit.
