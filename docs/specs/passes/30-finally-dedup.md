# Spec 30 — `finally-dedup` (stage A, catalogue lowering row 12 + 54)

Status: **SPEC ONLY, NOT IMPLEMENTED.** This spec ships the shape, the
protocol claim, the IR design, the refusal table, the acceptance tests and the
measured evidence LADDER section 5.1 asked for. It stops short of the IR
change and the rung by the escape clause the task brief wrote for it ("if the
IR change turns out to need more than the verifier + printer, stop after the
spec with the measured cost written down"): section 5 is that measurement, and
section 8 is the pushback (P-49) it forced, because two premises LADDER 5.1
states about this rung are contradicted by the bytecode.

Companion documents: `docs/lowering/try-finally-dedup.md` (observation-derived
account of the idiom, cases A/B/C), `docs/specs/passes/00-LADDER.md` section
5.1, `docs/specs/passes/22-try-shape-try-clean.md` (the neighbouring rung),
`docs/specs/04-structurer.md` (the tree IR this would amend).

## 1. The shape

`finally` has no bytecode of its own. `hermesc` duplicates the finalizer body
`F` into one copy per exit path plus one copy inside a synthesized
catch-and-rethrow handler that protects the `try` body and, when there is a
user `catch`, that `catch` clause too. Recovering `try { B } finally { F }`
means recognising those copies as copies and printing `F` once.

Ground truth, fixture `13-try-finally-no-catch` fn#2 `cleanup`
(`try { log.push('body') } finally { log.push('cleanup') } return log`),
read at v84/v94/v96/v98/v99 -- identical at all five:

```
regions: [{ handlerBlock: b3, catchRegister: r0, bodyBlocks: {b1} }]

b0: LoadParam r3, 1
b1: GetByIdShort r1,r3,1,14 | LoadConstString r0,1 | Call2 r0,r1,r3,r0        ; try body
b2: GetByIdShort r1,r3,1,14 | LoadConstString r0,8 | Call2 r0,r1,r3,r0 | Ret r3   ; F copy 1 + normal exit
b3: Catch r0 | GetByIdShort r2,r3,1,14 | LoadConstString r1,8 | Call2 r1,r2,r3,r1 | Throw r0  ; F copy 2 + rethrow
```

and the tree the structurer builds for it (`--emit-tree --passes=none`), also
identical at all five versions:

```
block b0
try r0 (head b4) {
  block b1
  return b2
} catch r0 {
  throw b3
}
```

Two facts follow, and they are the whole difficulty of this rung:

1. **A copy of `F` is an instruction range inside a block, not a block.**
   Copy 1 is `b2[0, 3)` -- the block whose *terminator* is the normal exit.
   Copy 2 is `b3[1, 4)` -- after the `Catch`, before the `Throw`. Neither is
   a subtree of the tree IR, and neither can be moved without splitting a
   block. (`b2` also carries the `Ret r3` that must stay *inside* the
   recovered `try`, since `try { ...; return log } finally { ... }` is what
   the source wrote.)
2. **The copies are not literally equal.** They are equal modulo a consistent
   renaming of the scratch registers: copy 1 uses `(r1, r0)` where copy 2
   uses `(r2, r1)`, both reading the shared `r3` (the parameter `log`), with
   every non-register operand (string ids `1`/`8`, cache index `14`) equal.
   "Isomorphic modulo scratch registers" is therefore a *bijection on the
   registers each copy writes*, extended by identity on the registers both
   copies only read.

## 2. The protocol claim

Let `R` be an exception region whose handler block `H` ends in
`Throw <catchRegister>` (or in a control transfer to a block that does), and
let `N1..Nk` be the blocks the protected range's exits fall into. If, for
every `i`, a prefix of `Ni` is isomorphic modulo scratch registers to
`H`'s instruction range strictly between its `Catch` and its final control
transfer, then those `k + 1` ranges are `k + 1` copies of one source-level
`finally` body `F`, and

> printing `try { B } finally { F } <exits>` instead is legal.

Why it is legal, in the two directions the reviewer will ask about:

* **Normal and returning exits.** JS specifies that `finally` runs on every
  completion of the `try` block -- normal, `return`, `break`, `continue`,
  `throw`. `hermesc`'s duplication is exactly that specification unrolled per
  completion, so one `finally` containing `F` executes `F` on precisely the
  same set of paths as the `k + 1` copies, in the same order relative to the
  exit's own effects (`F` before the transfer, in both forms: the value of a
  `return` inside `try` is computed *before* the copy of `F` that precedes
  the `Ret`, which is also what `finally` does).
* **The exceptional exit, and control transfers inside `F`.** The synthesized
  handler's trailing `Throw <catchRegister>` is *not part of `F`* -- it is the
  compiler's rethrow, implied by JS `finally` semantics and dropped. When `F`
  itself contains a `break`, `continue` or `return` (case C,
  `16-finally-with-break-continue`), the rethrow is simply one unreachable
  path among several: control leaves down the transfer's arm and the pending
  exception object is never read again. JS `finally` does exactly this -- an
  abrupt completion originating in the `finally` block replaces the pending
  one (ECMA-262 `TryStatement : try Block Finally`: "if `F` is an abrupt
  completion, return `F`"). So a control transfer inside the recovered `F`
  discards the pending exception in the printed source for the same reason,
  and by the same rule, that it does in the bytecode. **No IR node for
  suppression is needed**; it falls out of printing `F` faithfully with its
  own transfers.
* **Which copy `F` is taken from.** The handler-side copy, always. Only it
  shows what happens to a pending exception, so only it carries the case-C
  transfers; the normal-path copy of a `finally` with no override merely
  falls through. (`docs/lowering/try-finally-dedup.md` section 5.)

## 3. The IR change (amends spec 04)

Two designs were considered. **This spec adopts design B.**

### 3.1 Design A -- a `finalizer: Stmt` subtree (what LADDER 5.1 assumes)

`try` gains `finalizer?: Stmt`, holding the merged copy as a subtree; the
other `k` copies are deleted from the tree. Rejected on measurement:

* A copy is a *sub-block range* (section 1 fact 1), so there is no subtree to
  move. Producing one requires the pass to **split CFG blocks**, which changes
  `graph.blocks` -- and `checkIsomorphic` (`src/structure/verify.ts` P5/P6)
  reconstructs the CFG from the tree and compares it to `structured.graph`
  edge for edge, so a split has to be reflected in the graph too. A stage-A
  pass has never mutated `graph`.
* Deleting copy 2 removes block `b3` from the tree entirely. verify.ts P5/P6
  demand every reachable block appear in exactly one node unless it is in
  `fn.duplicatedBlocks`, which is the **structurer's** record of its own node
  splitting and is not writable by a pass (`src/structure/structure.ts:266`).
  Admitting pass-declared removals is a spec 04 semantic change, not a walker
  edit.
* Cost of the walker edits alone (measured, section 5): 11 sites over 6 files.

### 3.2 Design B -- `finalizer?: FinallyForm`, an annotation

`try` gains an optional annotation, in the same class as `LoopForm`,
`hideLabel`, `elseIf` and `TryShape` -- written by a pass, read by
`src/emit/function.ts`, **transparent to `verify.ts`**, because the body and
handler subtrees it sits on are untouched and no block moves:

```ts
/** Instruction range [from, to) of one copy of the finalizer body. */
export interface FinallyRange {
  readonly cfgBlock: BlockId;
  readonly from: number;
  readonly to: number;
}

/** See the `try` node's `finalizer` field. Written by src/passes/finally-dedup,
 *  read by src/emit/function.ts (spec 30). */
export interface FinallyForm {
  /** The copy the printer emits, always the handler-side one (section 2). */
  readonly source: FinallyRange;
  /** The copies the printer suppresses: one per normal/returning exit. */
  readonly copies: readonly FinallyRange[];
  /** The handler's trailing rethrow, dropped with the whole `catch` clause
   *  when `handlerIsRethrowOnly`. */
  readonly handlerIsRethrowOnly: boolean;
}
```

* **What the verifier must accept:** nothing new. `sameShape(before, after)`
  holds; `blocksMultiset` is unchanged; `checkIsomorphic` is not re-run
  differently. The rung is therefore **annotation-only (stage A)**, not
  CF-preserving -- see P-49 item 3, LADDER section 4.3's table says
  CF-preserving. Its checker's semantic predicate is the isomorphism of
  section 2, asserted directly on the instruction ranges.
* **What the printer emits.** In `src/emit/function.ts`'s `case "try"`:
  emit `block` for a range in `finalizer.copies` with that range spliced out;
  emit the handler clause not at all when `handlerIsRethrowOnly`; append
  `finally { <lowering of finalizer.source> }` to the emitted
  `{ k: "try", ... }` AST node, which gains
  `finalizer: readonly Stmt[] | null` (`src/emit/ast.ts`, printed by
  `src/emit/print.ts` case `"try"`). `planTries` contributes no `__pc` guard
  for a region with a `finalizer` whose `handlerIsRethrowOnly` is true: the
  clause the guard would sit in is not printed.
* **Cost:** `src/structure/ir.ts` (+2 types, +1 field), `src/emit/ast.ts`
  (+1 field), `src/emit/print.ts` (+3 lines), `src/emit/function.ts` (the
  real work, ~60 lines), `src/structure/print.ts` (+1 line so `--emit-tree`
  shows the annotation). No verifier change at all.

## 4. The rung

`src/passes/finally-dedup/{match,rewrite,check,index}.ts`, stage A,
`catalogue: [12]`, `before: ["loop-cond"]` (LADDER section 4.2: fixture 16's
duplicated finalizer sits inside a loop whose tail guard `loop-cond` would
otherwise claim first); `src/passes/try-shape` gains `after:
["finally-dedup"]` in the same commit, which is the constraint its own
`index.ts` comment says is deferred until this rung is registered.

* **match** (`targets: ["try"]`): for a `try` node, take the region
  `ctx.cfg.regions[node.region]`; require its `handlerBlock` to hold
  `Catch <catchRegister>` first and a control transfer last; take
  `Fh = H[1, len-1)`; require `Fh` non-empty; collect the exit blocks of
  `node.body` (the `return`/`throw`/`block`-with-fallthrough leaves whose
  block is *not* in `region.bodyBlocks` -- the over-reach `try-shape` already
  reasons about); for each, require a prefix isomorphic to `Fh` under one
  register bijection per copy. Data = the `FinallyForm`.
* **rewrite**: `{ ...node, finalizer: form }`. Nothing else changes.
* **check**: `sameShape(before, after)`, `blocksMultiset` equal, and re-derive
  the isomorphism from the CFG rather than trusting the match data (the
  stage-A checker-mutation tests require the checker to be able to reject a
  corrupted `Match`).

## 5. Measured cost of design A (why this spec stops here)

IR-tree walkers that would need a `finalizer` child, counted by hand over the
files that switch on the *structurer's* `Stmt` (the ~40 further `case "try"`
sites in `src/passes/**` walk `src/emit/ast.ts`'s unrelated `try` node and are
not affected):

| file | sites |
| --- | --- |
| `src/structure/ir.ts` | 1 |
| `src/structure/verify.ts` | 1 walker + P5/P6 block accounting |
| `src/structure/print.ts` | 1 |
| `src/structure/passes.ts` | 1 |
| `src/structure/structure.ts` | 2 |
| `src/passes/tree.ts` | 1 (`childrenOf`/`blocksMultiset`) |
| `src/passes/restructure.ts` | 2 |
| `src/passes/driver.ts` | 1 |
| `src/emit/function.ts` | 3 (`childrenOf`, `planTries`, `lowerTree`) |

11 mechanical sites plus the two non-mechanical ones (block splitting must be
reflected in `graph`; pass-declared block removal is not expressible). That is
"more than the verifier + printer", which is the brief's stop condition.
Design B costs 5 files and no verifier change, but it is a different rung
classification from the one LADDER records, so it needs the ruling in P-49
before it is built.

## 6. Refusal table

| code | refuses | why |
| --- | --- | --- |
| R-FD1 | the handler-side range and a normal-path prefix are not isomorphic modulo a register bijection | two genuinely different handlers, or an obfuscated variant; never guess |
| R-FD2 | a copy carries a terminator the others lack and it is not the rethrow | the copies do not agree on what `F` is; the case-C transfers must come from the handler side only |
| R-FD3 | nested regions sharing a range (fixture 54 `applyWithGuard`) where the inner region's handler is itself a copy site | the two finalizers interleave; not closed by this spec |
| R-FD4 | `F` contains its own `try` (a nested region whose `bodyBlocks` intersect a copy range) | the inner region would be printed twice |
| R-FD5 | the `try` node is inside a dispatch nest (`cfgBlock < 0`, fixture 16 at every version, fixture 100) | the copies are switch arms of an irreducible dispatcher, not exits; no exit structure to key on |
| R-FD6 | the function is a generator/async dispatcher | coordinate with `docs/BUGS.md` R-Y4 `forced-return-body`; the generator side is out of scope here |
| R-FD7 | the region's handler is not `Catch`-first / transfer-last | not the synthesized shape |

## 7. Acceptance tests (rung-owned, no whole-output comparison)

`tests/gate/passes/finally-dedup.test.ts`, all decompiling shared construct
fixtures but asserting only rung-owned structure:

1. `13-try-finally-no-catch` at v84/v94/v96/v98/v99: exactly one `finally` in
   `cleanup`, exactly one occurrence of `push("cleanup")` in that function
   (copy count 2 -> 1), and zero `catch` clauses in it.
2. `13` `risky`: k = 1 (no normal-path copy survives -- the try body ends in
   `throw`), so R-FD1 refuses and the output is unchanged. Rung-owned
   negative.
3. `12-try-catch-finally-return` `f2` at all five versions: one `finally`
   holding the `return`; `f1`/`f3` unchanged (see section 9).
4. `16-finally-with-break-continue`: refusal `R-FD5` reported once per site
   via `ctx.refuse`, output byte-identical to `skip: ["finally-dedup"]`.
5. `54-try-catch-finally-shared-range` `applyWithGuard`: refusal `R-FD3`.
6. `100-irreducible-try-retry`, `24-generator-return-throw`: unchanged
   (R-FD5 / R-FD6).
7. Annotation-only invariant: for every fixture above,
   `printTree(before) === printTree(after)` modulo the `finalizer=` marker,
   and `blocksMultiset` equal.
8. Checker-mutation: a `FinallyForm` whose `source` range is widened by one
   instruction is rejected by `check`.

## 8. Evidence (LADDER section 5.1's table, measured 2026-09-05)

Detector: for each exception region whose handler block is `Catch`-first and
ends in a `throw`-kind instruction, take the instruction range between them
and count the blocks of the same function that contain that opcode sequence.
Copy count = 1 + that count. (Upper bound: the detector matches on opcode
names, so a long function can produce a spurious hit; the k >= 6 column below
is not trustworthy for that reason, and a register-bijection check is what
the real matcher must use.)

| input | fns | regions | sites with k > 1 | copy counts (k: sites) | structurer `duplicatedBlocks` |
| --- | --- | --- | --- | --- | --- |
| `rn-template-0.72` `index.android.hbc` | 4199 | 214 | 16 | 2:14, 3:2 | 79 |
| `rn-template-0.72` `index.android.noopt.hbc` | 4314 | 215 | 33 | 2:21, 3:10, 4:2 | 70 |
| `react-navigation-example-0.85.3` | 15551 | 974 | 502 | 2:115, 3:39, 4:23, 5:15, and a long tail to 23 that the detector's opcode-name matching inflates | 245 |

Per-fixture, per-version (`dupFinallySites`, identical at v84/v94/v96 unless
noted):

| fixture | v84 | v94 | v96 | v98 | v99 |
| --- | --- | --- | --- | --- | --- |
| `12-try-catch-finally-return` | 0 | 0 | 0 | 0 | 0 |
| `13-try-finally-no-catch` | 2 (k=2, k=3) | 2 | 2 | 2 | 2 |
| `14-nested-try-catch` | 0 | 0 | 0 | 0 | 0 |
| `16-finally-with-break-continue` | 0 | 0 | 0 | 0 | 0 |
| `54-try-catch-finally-shared-range` | 5 (k=3 x2, k=4 x3) | 5 | 5 | 4 (k=3 x4) | 4 |
| `100-irreducible-try-retry` | 0 | 0 | 0 | 0 | 0 |
| `24-generator-return-throw` | 3 (k=4 x2, k=5) | 3 | 3 | 0 | 0 |

Which copy holds which terminator, fixture 13 `cleanup` (all five versions):
copy 1 = `b2[0,3)`, terminator `Ret r3`; copy 2 = `b3[1,4)`, terminator
`Throw r0` (the rethrow, dropped). Fixture 12 `f2` (case B, all five
versions): copy 1 = the tail of `b2`, terminator `Ret r1`; copy 2 = the tail
of `b3`, terminator `Ret r1` -- **both** copies return, neither rethrows,
because `finally { return 'finally-wins' }` overrides the pending completion.

## 9. Fixtures 12's `f1` and `f3` do not contain this idiom

`docs/lowering/try-finally-dedup.md` reads `f3` at `-O0` and shows two `print`
calls. The committed fixture is built at default `-O`, where the optimizer
proves the `try` body cannot throw, **drops the handler-table entry**, and
leaves the handler's instructions as unreachable dead code (that document's
section 8). Measured: `12-try-catch-finally-return` fn#1 `f1` and fn#3 `f3`
structure to a bare `return b0` with no `try` node at all, at every one of the
five versions, and the fixture's `dupFinallySites` is 0. So the brief's done
condition "fixtures 12 and 13 print a single `finally`" is only reachable for
`12`'s `f2` and `13`'s `cleanup`; `f1`/`f3` have nothing to merge and `13`'s
`risky` has k = 1. Recovering those would be a *different* rung (single-copy
finalizer recovery from a dead handler block), and is not proposed here.

## 10. Goldens that will move when the rung lands

`12-try-catch-finally-return` (`f2` only), `13-try-finally-no-catch`
(`cleanup` only) at all five versions. `16` and `54` are refusals and must not
move; if they do, the rung is wrong. No bundle golden moves on `rn-template`
(16 candidate sites, all inside module bodies whose goldens are per-function).
