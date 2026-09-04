# 16 — `destructure` (stage B, catalogue row **22**)

Reading list: `docs/AGENT-BRIEF.md`, `src/passes/README.md`, this file. Nothing
else. Batch 3; runs after `expr-rebuild`, `global-access`, `call-shape`,
`default-params`; before `spread-rest` and `var-naming` (§7).

**This spec supersedes the ladder one-liner (docs/PUSHBACK.md P-3, P-9).**
Ladder §1.2 row 22 said "straight-line `IteratorBegin/Next` + `ensureObject` +
`GetById` fan-out"; P-3 said the idiom arrives as nested `if`/`else` with empty
consequents. Both are wrong about the shape the matcher actually sees. Measured
on the committed fixtures at v94 *and* v99 (`npx tsx src/cli.ts
tests/fixtures/constructs/37-destructuring-array/v94.hbc --no-pass var-naming
--no-pass fn-naming`, same at v99, same for 38/39): the idiom is **one labeled
block per bound array element and per defaulted object property**, each with a
tail `break` — the same labeled-block family P-8 found for `default-params`.
Plain (non-defaulted) object properties are bare `GetById` statements with no
block and no guard at all. §2 pastes the observed IR.

## 0. Before you write code: row 22 is single-version

`docs/LOWERING-CATALOGUE.md` row 22 is `✅ single-version` (v94 only), which
PL-06 refuses. The v99 shape is confirmed below — same idiom, cosmetic
register-copy differences (§2.6) — but the implementer must still re-read
`hermesc -dump-bytecode` for `37`/`38`/`39` at v94 and v99, add the v99
evidence to `docs/lowering/destructuring.md`, and flip the Confidence column
to `✅ verified` in the same commit as the pass.

## 1. Purpose

Turn the per-element iterator-protocol blocks and the per-property `GetById`
fan-out back into destructuring assignments.

Before (`37-destructuring-array` v94 `fn#1` `firstTwo`, after batch-1 passes +
`default-params`; v99 differs only as §2.6 describes):

```js
function _fn1(a1) {
  let r0, r1, r2, r3, r4, r5, r6;
  let __t;
  L0: {
    r6 = undefined;
    __t = __hbc_iterBegin(a1);
    r0 = __t[0];
    r4 = __t[1];
    __t = __hbc_iterNext(r0, r4);
    r1 = __t[0];
    r0 = __t[1];
    r3 = r0 === r6;
    r2 = undefined;
    if (r3) { break L0; }
    r2 = r1;
    break L0;
  }
  L1: {
    r1 = undefined;
    if (r3) { break L1; }
    __t = __hbc_iterNext(r0, r4);
    r5 = __t[0];
    r0 = __t[1];
    r4 = r0;
    r4 = r4 === r6;
    r1 = undefined;
    r3 = r4;
    if (r4) { break L1; }
    r1 = r5;
    r3 = r4;
    break L1;
  }
  L2: {
    if (r3) { break L2; }
    __hbc_iterClose(r0, false);
    break L2;
  }
  r0 = r2 + ":" + r1;
  return r0;
}
```

After (`var-naming` renames later):

```js
function _fn1(a1) {
  let r0, r1, r2;
  [r2, r1] = a1;
  r0 = r2 + ":" + r1;
  return r0;
}
```

The written form is a **destructuring assignment to registers**, never a
`let`/`const` declaration — the registers are already declared, and D14 forbids
inventing per-binding declarations the bytecode does not have. An
object-pattern assignment in statement position is parenthesised
(`({ a: r5 } = r3);`) or the emitter's statement printer must do it; a naked
`{` starts a block and `parses` will catch the mistake.

## 2. Baseline shapes (measured, v94 and v99)

All shapes below were read from decompiler output at both versions with
`--no-pass var-naming --no-pass fn-naming` on `37`, `38`, `39`. Registers are
examples, not fixed slots.

### 2.1 Array pattern: the element unit

Iteration state is three registers: `rIter` (the iterator, `undefined` once
done), `rNextFn` (the cached `next`), `rDone` (the done flag), plus `rU`
holding literal `undefined` (or inline `undefined` literals). The prologue —
`__t = __hbc_iterBegin(SRC); rIter = __t[0]; rNextFn = __t[1];` — is fused
into the first element's block. Each element `k` is one labeled block, in one
of two commit styles:

**(a) direct commit** (`firstTwo`, above): the element's target register is
assigned inside its own block — `rT = undefined; if (rDone) break Lk;
…iterNext…; rT = value; break Lk;`.

**(b) staged commit** (`37`'s top-level `[a, b = 99, , d, ...rest]`): a shared
staging register `rStage` carries the value out of block `k`, and block
`k + 1`'s **first statement** commits it — `Lk+1: { rTk = rStage;
rStage = undefined; if (rDone) break; … }`. The matcher must accept both; the
commit of element `k` living at the head of block `k + 1` is the single most
counter-intuitive fact about this idiom and the reason "one contiguous run per
destructuring" (P-9) is the wrong mental model.

The step inside a block is always:

```js
__t = __hbc_iterNext(rIter, rNextFn);
rV = __t[0];
rIter = __t[1];
rDone2 = rIter === rU;      // possibly via a copy: r4 = r0; r4 = r4 === r6;
rDone = rDone2;             // done flag re-threaded, register may rotate
if (rDone2) { break Lk; }
<commit or stage rV>
```

### 2.2 Defaults inside an array pattern

`b = 99` (37, top level) nests labels: after staging, an inner block breaks to
the *outer* label when the value is present —

```js
L1: { L2: { L3: {
  r5 = r15;                 // commit of element 0 (style (b))
  r15 = undefined;
  if (r2) { break L3; }     // done → default applies
  …iterNext, done recompute…
  if (r19) { break L2; }
  r15 = r18;                // got a value
  break L3;
}
  r18 = r15;
  if (r18 !== r9) { break L1; }   // value !== undefined → keep it
  break L2;
}
  r15 = 99;                 // the default
  break L1;
}
```

The default guard is the same `!== undefined` idiom `default-params` matches
(rows 22/24 share the guard, per ladder §2), but against the *staged element
value*, with labeled breaks instead of an if/else.

**Implementation note (BUGS.md 2026-09-02, closed for the direct-commit
case).** The matcher accepts a per-element default in the direct-commit style
(`sumPair([a = 0, b = 0] = [])`, `39-destructuring-params`, function-body
scope — not wrapped in a `__pc` region at v84/v94/v96): element 0 (fused with
the prologue) nests two labels (`Lo`/`Ld`, `Ld` doing double duty as the
step-and-both-checks block since there is no earlier element to early-skip
for); a later element nests three (`Lo`/`Ld`/`Ls`, `Ls` doing the early
prevDone-skip-or-step, `Ld`'s own tail the `!== U` check, `Lo`'s own tail the
default). See `src/passes/destructure/match.ts`'s
`parseDefaultedPrologueBlock`/`parseDefaultedElementBlock`. The example above
(`b = 99`, top-level, **staged**-commit) is unreachable in v1 regardless of
this fix — every top-level site is refused by precondition 6
(`pc-tracked-region`, §8 Q1) — so the staged-commit-plus-default combination
stays unimplemented and untested; the matcher refuses it (`broken-threading`,
since a staged head does not parse as the plain `rV = undefined;` reset the
direct-commit grammar expects) rather than mis-rewriting it. v98/v99 wrap
`sumPair`'s own pattern in a `try`/`catch` region (measured directly, not
predicted by this section) and are refused the same way, correctly.

### 2.3 Holes and the close block

An elision is a block that advances the iterator and never commits
(`L5` in 37: `rStage = undefined; if (rDone) break; …iterNext…;
rStage = rV;` with no following commit read). After the last element a close
block runs `IteratorClose` only if the iterator was not exhausted:

```js
L2: {
  if (rDone) { break L2; }
  __hbc_iterClose(rIter, false);
  break L2;
}
```

When the pattern ends in a rest element there is no close block (the rest loop
exhausts the iterator).

**Implementation note (BUGS.md 2026-09-02, hole-by-shape closed 2026-09-05).**
Measured on `65-destructure-hole-rest`'s `skipMiddle` (function-body scope,
plain-assignment form — a `const`/`let [..] =` *declaration* form hits an
unrelated v84 TDZ-init quirk that fuses `__hbc_empty` bookkeeping into the
array pattern's own prologue block): a hole is *structurally* indistinguishable
from a kept staged-commit element (both stage into a shared register and end
in an unconditional `break`); the matcher (`match.ts`'s `resolvePending`)
disambiguates only by *use* — a following block's `real = stage;` header
commits it (kept), the stage register is read again before being redefined
even with no such header (kept, direct-commit style — `firstTwo`'s `p`/`q`),
or the stage is provably dead from that point on (`isDeadFrom`, a defUse
reachability check) — a hole. This also required recognising that **the
close block itself may carry the pattern's last position's commit at its own
head** (`parseCloseBlock` extended to accept an optional leading
`real = stage;`), a shape no previously-measured fixture needed (`firstTwo`'s
last element always committed directly). v84/v94/v96 accept the hole this
way; v98/v99 lower the same hole through a genuinely different shape (an
early-guard flag-copy whose *target* is itself aliased again to feed the
`iterNext` call's `rNextFn` argument directly, and no stage write at all) that
this rung does not parse — refused (`broken-threading`), not mis-rewritten.
See `docs/lowering/destructuring.md`'s "Holes and rest at function-body
scope" section for the measured IR.

### 2.4 The rest element (this rung owns it — see §7)

`...rest` is an **inline index-append loop**, not a helper call:

```js
L6: {
  r3 = r15;                  // commit of the previous element
  r18 = new Array(0);        // the rest array
  r15 = 0;                   // append index
  if (r2) { break L6; }
  while (true) {
    __t = __hbc_iterNext(r1, r16);
    r20 = __t[0]; r1 = __t[1];
    …done recompute…; if (r19) { break L6; }
    r19 = r15;
    try {
      r18[r19] = r20;
      r15 = r19 + r17;       // r17 = 1
      continue;
    } catch (_exc0) { … __hbc_iterClose(r1, true); throw r0; }
  }
}
```

At top level this variant is wrapped in the module's `__pc` exception-region
machinery; §4's `pc-tracked-region` refusal applies (v1 scope, §8 Q1).
`__hbc_b_arraySpread` never appears in a destructuring — the helper-call
spreads belong to `spread-rest` (spec 17), and the two rungs' shapes are
disjoint (§7).

**Implementation note (BUGS.md 2026-09-02, measured 2026-09-05, confirms §8
Q1 rather than narrowing it).** `65-destructure-hole-rest`'s `headAndTail`
puts `[h, ...t] = xs` at **function-body** scope, not top level, and it is
*still* refused: `__pc` writes appear inside the rest loop's own printed
body at every version (13 at v84/v94/v96, 3 at v98/v99, never zero) —
confirmed by direct grep, not inferred from the top-level case. The `try`/
`catch` this section documents is inherent to the rest lowering's own abrupt
-completion handling (`IteratorClose(it, true)` on a throw from the append),
not an artifact of the module wrapper's exception machinery as the original
§8 Q1 wording implied. Array rest therefore has **no reachable v1 site at
all** — the sound extension is exactly what §8 Q1 already names (matching
the region including its handler against the canonical abrupt-close
expansion, after batch-4 `try-clean`), now with direct evidence instead of
an inference from the top-level case alone.

### 2.5 Object patterns

Measured on `38`/`39` at v94 and v99:

* **Plain property** — a bare member read, no block, no guard:
  `r5 = r3.a;` (renamed bindings look identical: `{ a: renamedA }` is just
  `r5 = r3.a`). A run of plain properties is a run of consecutive `GetById`s
  off one source register.
* **Defaulted property** — one labeled block; plain reads that precede it in
  pattern order may sit inside the same block, before the guard
  (`greet` at v94: `L1: { r1 = r2.name; r2 = r2.greeting;
  if (r2 !== r3) { break L1; } r2 = r0; break L1; }` where `r3` holds
  `undefined` and `r0` the default `"Hello"`; v99 `makeUser` identical shape
  with a call default: `r4 = globalThis.defaultFactory; r2 = r4();`).
* **Nested pattern with default** — chained blocks
  (`{ nested: { deep = D } = {} }` is one block guarding `.nested` with
  default `{}`, then one block guarding `.deep` with default `D`).
* **Rest property** — the 3-argument helper form: an excluded-keys object
  literal whose plucked keys map to `0`, then
  `rT = __hbc_b_copyDataProperties({}, rSrc, rExcluded);`
  (`38`: `r4 = {}; r4.x = 0; r6 = __hbc_b_copyDataProperties({}, r5, r4);`).
  The **3-argument** form is this rung's; the 2-argument form is
  `spread-rest`'s object-spread (§7).
* **Computed keys** — `{ ['computed' + 'Key']: v }` is constant-folded by
  Hermes into a plain `GetById`. The pattern is unrecoverable and nothing
  should try: a plain member read stays a plain member read (refusing is
  correct output here, not a gap).
* **`ensureObject`** (the ladder's one-liner mentioned it) does not survive to
  stage B as a helper call on these fixtures; the null/undefined TypeError is
  implicit in the member read. Do not match on it; if the implementer's dump
  re-read finds a version where it does surface, record it in
  `docs/lowering/destructuring.md` and add a rule then.

### 2.6 Version differences

| | v94 | v99 |
|---|---|---|
| element block structure | as above | identical |
| done recompute | `r3 = r0 === r6` direct | often via a copy: `r7 = r3; r2 = r7 === r1; r0 = r2` |
| `undefined` operand | dedicated register (`r6`) | dedicated register (`r1`), sometimes reused as the object-default guard operand too |
| default-params interaction | `greet`'s `= {}` param default already rewritten (`function _fn1(r2 = {})`) | `default-params` did **not** fire on `38`/`39` (prologue `L0: { r1 = arguments[0]; … }` remains) — see §8 Q2 |
| everything else | identical | identical |

Neither difference is a version test; the matcher accepts both everywhere.

## 3. AST the rung owns

**May match/rewrite:** a run of sibling statements in **one** statement list —
labeled blocks (array elements, defaulted properties), bare member-read
statements (plain properties), the excluded-keys literal + 3-arg
`__hbc_b_copyDataProperties` pair (object rest), and the trailing close block.
The rewrite replaces the run with one destructuring-assignment statement.

**Must not touch:** statements outside the captured run; any block containing
a `__pc` or `__exc` write (refuse `pc-tracked-region`); any `try` statement
except the rest loop's own catch when the whole rest unit is matched (§8 Q1
keeps even that out of v1); `__hbc_b_arraySpread` / 2-argument
`__hbc_b_copyDataProperties` / `__hbc_b_copyRestArgs` sites (spec 17's);
`for`-of loop forms (stage A owns iteration that feeds a loop body); a labeled
block whose label is targeted by any `break` outside the run.

### Framework prerequisite F16 (`src/emit/ast.ts` + `print.ts`)

The AST has no pattern nodes. Add:

```ts
export type PatternElement =
  | { readonly k: "pel"; readonly target: Pattern; readonly init?: Expr } // element/property value
  | { readonly k: "hole" }
  | { readonly k: "prest"; readonly target: Pattern };                    // ...rest
export type Pattern =
  | { readonly k: "pid"; readonly name: string }                          // a register today
  | { readonly k: "parr"; readonly elements: readonly PatternElement[] }
  | { readonly k: "pobj"; readonly props: readonly { key: string; value: PatternElement }[] };
```

plus one expression form `{ k: "destructure", pattern: Pattern, source: Expr }`
printed as `<pattern> = <source>` (assignment precedence; object patterns
parenthesised in statement position). `walk`/`mapExpr` recurse into `init`
sub-expressions; `freeNames` counts `pid` names as **written** (they are
assignment targets, not bindings); `effectSequence` records a `destructure`
node as its **canonical expansion** (§6) — getting this wrong is the one way
the rung can fire and then be abandoned by its own checker; `scope-check`
treats `pid` names like any other assigned identifier. `var-naming` must
rename `pid` names with the same machinery as plain `ident`s (one shared
walk, not a second implementation).

## 4. Matcher

Site = one statement list `L`. Scan for the first array unit or object unit
not yet rewritten (idempotence is structural: the rewrite's output contains no
`__hbc_iterBegin`/`__hbc_iterNext` and no 3-arg `copyDataProperties`, so
`match` returns `null` on it — PL-08).

**A — array pattern.** Anchor: a labeled block whose body contains
`__t = __hbc_iterBegin(SRC)` followed by the first element step (§2.1).
From the anchor, greedily consume consecutive sibling labeled blocks that
parse as element units (either commit style, defaults per §2.2, holes per
§2.3, at most one trailing rest unit per §2.4), then an optional close block.
Record for each element: target register (or none for a hole), default
expression (or none), and the identities of `rIter`/`rNextFn`/`rDone`/`rU`
threading through. Preconditions, all recomputed in `check`:

1. **State threading.** Every block reads the *same* `rIter`/`rNextFn` pair
   the prologue produced (modulo single-write register copies), and every
   done-flag write is `rX === U` of the fresh `rIter`; the flag register may
   rotate but its value must be the previous block's flag on the
   `break`-early path. Anything else → stop the scan at the previous block (a
   prefix is *not* a valid smaller match here, unlike `default-params`: a
   partial array pattern changes how many times the iterator is advanced —
   refuse the whole unit, `broken-threading`).
2. **`U` is undefined.** Inline literal, or a register whose only write in
   the function is literal `undefined` (`identUses` write count, `nested ===
   0`); otherwise refuse (`not-undefined-guard`).
3. **Targets are registers.** Each commit target matches `/^r\d+$/` and has
   `nested === 0` in the run; member-expression targets (`[o.a] = x`) have
   not been observed — refuse (`non-register-target`) and record, per §8 Q3.
4. **Defaults are collapsible.** Each default body collapses to one `Expr`
   exactly as spec 15 §5 does (single assignment, or an all-`expr` run →
   `seq`); its free registers may only be earlier targets of this same
   pattern, the pattern's own state registers, or enclosing-scope names;
   otherwise refuse (`default-reads-body-state`).
5. **No escaping labels.** No `break`/`continue` in the run targets a label
   outside the run; no label in the run is targeted from outside
   (`label-escape`).
6. **No `__pc`/`__exc`/`try`** anywhere in the run (`pc-tracked-region`) —
   this excludes the rest-loop variant and every top-level site inside the
   module wrapper's exception regions in v1 (§8 Q1); the four function-body
   sites (`firstTwo`, `sumPair`, `makeUser`, `greet`) all match.
7. **Dead machinery.** After the run, `rDone`, `rStage`, the `__t` reads and
   `rNextFn` are not read before being rewritten (`defUse`); `rIter` is not
   read after the close block. Otherwise refuse (`state-escapes`).
8. **Close discipline.** A close block is present iff the pattern has no rest
   element; its guard flag is the final `rDone` (`close-shape`).

**O — object pattern.** Anchor: a labeled block matching the defaulted-
property shape (§2.5) — `rT = rSrc.key; if (rT !== U) { break L; }
…default…; break L;` — or a 3-arg `copyDataProperties` statement. Extend
backwards and forwards over consecutive sibling statements that are plain
`rX = rSrc.key` reads off the same `rSrc`, more defaulted-property blocks on
`rSrc`, and at most one rest unit (`rEx = {}` + `rEx.k = 0` stores + the
3-arg call). Preconditions: 2–5 above, plus:

9. `rSrc` is not written inside the run except as its own last plain read's
   target (`greet` v94 reuses `r2` as both source and target of `.greeting` —
   legal only on the **final** read; anywhere else, `source-clobbered`).
10. For the rest unit: the excluded-keys literal's keys are exactly the
    pattern's plucked keys, every value is `0`, the object is built
    immediately before the call and never read again (`rest-exclusion-shape`);
    the call's first argument is a fresh `{}`; its result register is the
    rest target.
11. A pattern with **zero** defaulted properties and **zero** rest is refused
    (`plain-reads-only`): a run of bare member reads is indistinguishable
    from ordinary property access, and inventing a pattern there is styling,
    not recovery. (This is why `computedVal` and simple `{x}` reads stay as
    member reads — correct, per §2.5.)

## 5. Writer

Build one `destructure` statement from the recorded elements/properties, in
pattern order: array → `{k:"parr"}` with `pel`/`hole`/`prest` elements; object
→ `{k:"pobj"}` with `key` strings and `pel` values (nested patterns recurse).
`source` is the observed `SRC`/`rSrc` expression node, reused by reference.
Delete every statement of the matched run; splice the one new statement at the
run's start. Then drop from the function's `let` declarations any register
that no longer has a use (the P-8 `pruneRegisterDecls` note in `docs/BUGS.md`
applies here too — a register may now be live only inside a default).

Defaults are spliced as `pel.init`, reusing the exact collapsed `Expr` nodes —
never rebuilt. Object rest emits `...rTarget` as the final property.

## 6. Checker

Class: **expression-only** (ladder §4.3), via **recompute-and-diff**: the
checker rebuilds what the matched run *must have looked like* from the
rewrite's output and diffs effect sequences — it never trusts a byte of match
data (the mutation-testing lesson behind spec 15 §6).

1. **Canonical expansion.** Implement `expand(destructureStmt) → Stmt[]`, the
   writer's inverse: for an array pattern emit the JS-spec evaluation order —
   `iterBegin(source)`; per element: iterNext-if-not-done, done recompute,
   default guard when `init` present, commit; hole: advance only; rest:
   append loop; close-if-not-done when no rest. For an object pattern: one
   member read per property in order, default guard per `init`, excluded-keys
   + 3-arg `copyDataProperties` for rest. Then require
   `effectSequence(expand(after-stmt))` **deep-equals**
   `effectSequence(matched run in before)`. Effects (helper calls, member
   reads — getters are effects — member writes in the rest loop, default-body
   calls) survive; the version-cosmetic register copies, `undefined` resets
   and flag re-threads are pure and vanish on both sides, which is exactly
   why the diff is sound where a syntactic diff would be version-brittle.
2. Recompute every §4 precondition (1–11) against `before`.
3. `after` is `before` with the run replaced by exactly one statement;
   nothing outside the run moved (`before.length - runLength + 1 ===
   after.length`, and the flanks are reference-equal).
4. Each commit register appears in `after`'s pattern exactly once, in the
   position §4 recorded; each default `init` is reference-equal to the
   collapsed expression in `before`.
5. No matched-run label is referenced anywhere in `after` (`freeNames` has no
   label tracking, so walk for `break`/`continue` targets explicitly).
6. The driver's `parses(fnBody)` — the backstop for F16's printer, and the
   test that catches an unparenthesised object pattern.

**D14 / semantics.** The mapping is exact where the matcher accepts, and each
clause is an acceptance condition, not a hope:

* **Iterator protocol.** JS array destructuring: `GetIterator` once, one
  `IteratorStep` per element (skipped once done), holes advance, rest loops
  to exhaustion, `IteratorClose` iff not done. That is block-for-block the
  §2.1–2.4 machinery; the `expand` in check 1 *is* this list.
* **Defaults** fire iff the stepped value is `undefined` (or the step was
  done) — the `!== undefined` guard on the staged value, exactly.
* **Abrupt completion.** JS closes the iterator if a default/target
  evaluation throws. Hermes emits a try region (with `__pc`) exactly at
  sites where a default can throw, and elides it where it cannot
  (`sumPair`'s `= 0`); precondition 6 refuses every site *with* a region, so
  the rewrite is only ever applied where Hermes itself proved no abrupt path
  exists. The v1 cost is coverage (top-level sites), not soundness.
* **Object property reads are ordered effects** (getters, Proxies): plain
  reads keep their order and count in the pattern; precondition 11 means a
  rewrite only happens where a default or rest proves destructuring
  actually happened.
* **Object rest** copies own-enumerable keys minus the plucked ones —
  `CopyDataProperties` with excluded keys, the observed 3-arg helper,
  matching JS `...rest` semantics including later-key-wins and
  null-prototype result absence (the helper starts from `{}` — same as JS).
* **No declarations.** The rewrite assigns to existing registers; TDZ,
  `const`-ness and per-iteration binding questions never arise (D14).

## 7. Ordering, refusals, fixtures, metrics — and the `spread-rest` boundary

**Ordering.** `stage: "B"`, `after: ["expr-rebuild", "global-access",
"call-shape", "default-params"]`, `before: ["spread-rest", "var-naming"]`.
`default-params` first is ladder §2's rule (the `= {}` parameter default must
already be in the parameter list where it fired — §8 Q2 covers where it
didn't). `var-naming` last so pattern targets are named once.

**The `...` boundary (resolves the P-9 overlap question).** The two rungs'
shapes are disjoint, and this spec fixes the ownership:

| `...` site | Lowering | Owner |
|---|---|---|
| array-pattern rest `[..., ...r]` | inline iterNext/index-append loop (§2.4) | **destructure** |
| object-pattern rest `{..., ...r}` | **3-arg** `__hbc_b_copyDataProperties` | **destructure** |
| array/call spread `[...x]`, `f(...x)` | `__hbc_b_arraySpread` (+ `__hbc_b_apply`) | **spread-rest** |
| object spread `{...o}` | **2-arg** `__hbc_b_copyDataProperties` | **spread-rest** |
| rest parameter `(...r)` | `__hbc_b_copyRestArgs(arguments, k)` | **spread-rest** |

The 3-vs-2 argument count on `copyDataProperties` is the load-bearing
discriminator; both matchers must assert it and each must carry a negative
unit test built from the *other* rung's shape. `spread-rest` declares
`after: ["destructure"]` (spec 17 §7) so the pipeline order is a stated fact
rather than a coincidence of registry order — not because either matcher
depends on the other having run.

**Refuse (per-site, distinct reason strings):** `broken-threading`,
`not-undefined-guard`, `non-register-target`, `default-reads-body-state`,
`label-escape`, `pc-tracked-region`, `state-escapes`, `close-shape`,
`source-clobbered`, `rest-exclusion-shape`, `plain-reads-only`.

**Fixtures (red→green).** `targets: ["37-destructuring-array",
"38-destructuring-object", "39-destructuring-params"]`, all five HBC versions
plus `.min`/`.obf`. Unit tests on hand-built lists
(`tests/gate/passes/synth.ts`): positives for direct-commit and staged-commit
array units, an array default, a hole, an object default block with leading
plain reads, a nested object default, object rest; negatives for a 2-arg
`copyDataProperties` (spread-rest's), an `__hbc_b_arraySpread` run, a run
containing a `__pc` write, a broken done-flag thread, a plain-reads-only
object run; ≥1 site the `check` refuses.

**Corpus metric** (`tools/passes-metrics.ts`): count of `__hbc_iterBegin`
calls *outside a `for`-of loop form* plus 3-arg `copyDataProperties` calls
remaining in printed output. **Floor: every function-body destructuring in
37/38/39 rewritten at all five versions × base/`.min`/`.obf`** (the
`firstTwo`/`sumPair`/`makeUser`/`greet` class), and **≥ 50 %** of all
destructure sites across `tests/fixtures/constructs/**` (top-level
`pc-tracked-region` refusals cap this until batch-4 `try-clean`; the refusal
histogram in `docs/STATUS.md` must show `pc-tracked-region` as the dominant
reason, anything else investigated). Zero fixture verdict moves; PL-09 holds;
`--passes=none` byte-identical.

**Estimated size:** ~350 lines across `match/rewrite/check`, ~120 lines F16
(`ast.ts`/`print.ts`/`scope-check.ts`), ~300 lines of tests.

## 8. Open questions

1. **The `try`-wrapped variants.** The rest-element loop and every top-level
   site sit inside `__pc` exception regions; v1 refuses them
   (`pc-tracked-region`). The sound extension is to match the region
   *including* its `__hbc_iterClose(it, true)` handler and check it against
   the canonical abrupt-close expansion — spec it as a follow-up rung
   revision after batch-4 `try-clean` lands, not as scope creep here.
2. **`default-params` at v99.** On `38`/`39` at v99, `default-params` did not
   fire (the `= {}` prologue block remains; `--emit-tree` shows no
   `default-params` in `passes=`), so this rung sees the parameter's
   destructure source still named by the prologue's register. The O-rule
   still matches (it keys on `rSrc`, not on where `rSrc` came from), but the
   printed result is uglier. Diagnose the v99 refusal (file the reason under
   its own `docs/BUGS.md` row if it is a default-params bug) before calling
   `39`'s output done.
3. **Member-expression targets** (`[o.a] = x`, `({ a: o.b } = y)`) — never
   observed in the fixtures; the `non-register-target` refusal records them.
   If the RN template bundle shows them, extend `pid` with a member form
   then, with the getter/setter ordering re-checked in `expand`.
4. **Swap-assignment readability.** `[first, second] = [second, first]` at
   top level is refused in v1 (it sits in a `__pc` region). When Q1 lands,
   the swap needs no special casing — it is a plain two-element pattern.
