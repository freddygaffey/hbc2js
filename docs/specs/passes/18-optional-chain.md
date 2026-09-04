# 18 — `optional-chain` (stage B, catalogue row **25**)

Reading list: `docs/AGENT-BRIEF.md`, `src/passes/README.md`, this file. Nothing
else. Batch 3; runs after `expr-rebuild`, `global-access`, `call-shape`;
before `var-naming`.

**This spec supersedes the ladder one-liner (docs/PUSHBACK.md P-3).** Ladder
§1.2 row 25 wrote the idiom as an expression rewrite
(`x == null ? undefined : x.y` → `x?.y`); P-3 correctly observed no `cond`
ever reaches stage B, but described the survivor as nested `if`/`else` with
empty consequents. With today's pipeline (post `if-chain`/`label-clean`) the
idiom is a **guarded run inside one labeled block with tail breaks** — the
same labeled-block family as `default-params` (P-8) and `destructure`
(spec 16). §2 pastes the observed IR. The rewrite is statement-run → one
assignment, at stage B's list granularity.

## 0. Before you write code: row 25 is single-version

`docs/LOWERING-CATALOGUE.md` row 25 is `✅ single-version` (v94 only), which
PL-06 refuses. §2 confirms the v99 shape from decompiler output (same idiom,
guard-spill differences per §2.4); the implementer must re-read
`hermesc -dump-bytecode` for `48-optional-chaining-nullish` at v94 and v99,
add the v99 evidence to `docs/lowering/optional-chaining.md`, and flip the
Confidence column to `✅ verified` in the same commit as the pass. Row 25's
key fact holds at both versions: the guard is **one loose `Eq` against
`null`**, never two strict checks.

## 1. Purpose

Turn null-guard blocks back into `?.` chains and `??` fallbacks.

Before (`48-optional-chaining-nullish` v94 global, after batch-1 passes;
`r4` holds `null`, `r9`/`r11` hold `print`-ish callees resolved earlier):

```js
L1: {
  r6 = r9(r6);
  if (!("print" in r1)) { throw new ReferenceError("Property 'print' doesn't exist"); }
  r9 = r1.print;
  r6 = undefined;
  if (r13 == r4) { break L1; }
  r14 = r13.profile;
  r6 = undefined;
  if (r14 == r4) { break L1; }
  r14 = r14.contacts;
  r6 = undefined;
  if (r14 == r4) { break L1; }
  r6 = r14.email;
  break L1;
}
L4: {
  if (r6 != r4) { break L4; }
  r6 = r11;
  break L4;
}
```

After (the leading statements of `L1` are untouched — the match is a *suffix
run* of the block):

```js
r6 = r9(r6);
if (!("print" in r1)) { throw new ReferenceError("Property 'print' doesn't exist"); }
r9 = r1.print;
r6 = r13?.profile?.contacts?.email;
r6 = r6 ?? r11;
```

(Once the guarded run is rewritten the labeled block has no `break` left and
the label dissolves — reuse whatever stage-B label-dropping `if-chain`/the
emitter already provides rather than inventing it here; if nothing exists at
stage B, leaving `L1: { … }` without breaks is acceptable v1 output and
`var-naming` is unaffected.)

## 2. Baseline shapes (measured, v94 and v99)

Read from decompiler output on `48` at both versions with
`--no-pass var-naming --no-pass fn-naming`.

### 2.1 The optional chain (C-rule)

One labeled block per full source chain. Inside it, a suffix run:

```js
rRes = undefined;
if (BASE == N) { break L; }        // N: null (see 2.3)
rT = BASE.prop;                    //  or BASE[rIdx]  or a call (2.2)
rRes = undefined;                  // reset repeated before every guard
if (rT == N) { break L; }
…
rRes = <final link>;               // the only committed value
break L;
```

Every guarded link leaves `undefined` in `rRes` when it short-circuits (the
`rRes = undefined` resets), and only the final link commits a real value.
`BASE` is a register (the chain source was computed earlier — including
`withSideEffect()?.property`, where the base is the call's result register:
`r6 = r6(); r11 = undefined; if (r6 == r4) { break L11; }
r11 = r6.property;`). Links observed: `GetById` (`.name`), computed
(`r14[r13]` with `r13 = 10`, and `r14[r8]` with `r8 = 0` — `arr?.[i]`), and
calls (2.2).

### 2.2 Optional call (`?.()`)

`api?.fetch?.()` at v94 and v99:

```js
r6 = undefined;
if (r12 == r4) { break L8; }       // guard the base   → api?
r11 = r12.fetch;                   // load the method
r6 = undefined;
if (r11 == r4) { break L8; }       // guard the method → .fetch?
r6 = Reflect.apply(r11, r12, []);  // call with this = base
break L8;
```

The `Reflect.apply(rM, rBase, args)` survives `call-shape` (its R3b wants the
callee written as `rBase.m` *inside* the apply; here it is a register) — this
rung is the intended consumer. The rewrite for the run above is
`r6 = r12.fetch?.()` **only if the base guard is absent**; with both guards it
is `r6 = r12?.fetch?.()`. Each `== null` guard maps to exactly one `?.` link.

### 2.3 Nullish coalescing (N-rule)

Its own labeled block, *separate* from the chain block, guard polarity
inverted (`!=`):

```js
L4: {
  if (rX != N) { break L4; }
  rX = <fallback>;                 // may be several statements
  break L4;
}
```

→ `rX = rX ?? fallback`. Observed with register fallbacks (`r6 = r11`) and on
non-chain values (`r8 = 0; if (r8 != r4) break; r8 = r0;` →
`r8 = 0 ?? "fallback"` — fold the immediately preceding literal write when
present, else keep `rX = rX ?? f`).

### 2.4 Version differences

| | v94 | v99 |
|---|---|---|
| guard test | inline: `if (r13 == r4)` | spilled: `r3 = r9 == r2; …; if (r3) { break L; }` — the compare may be separated from the `if` by the `rRes = undefined` reset |
| `N` | one register, single write `null`, function-wide (`r4`) | same (`r2`), occasionally reused across chains |
| reset/compare order | reset before compare | compare, then reset, then `if` |
| base re-read | chain carries the base forward in one register | may re-read the base (`r9 = r6.profile` again in the next block — each chain re-evaluates from its own start; still one chain per block) |
| everything else | identical | identical |

Both shapes must be accepted; neither is a version test.

## 3. AST the rung owns

**May match/rewrite:** a suffix (or interior, for N-rule) run of sibling
statements inside one labeled block — the resets, guards, link loads and
final commit; the block's label only in that its `break`s are consumed.

**Must not touch:** statements before the run in the same block; guards whose
test is anything but the §2 shapes (in particular `!== undefined` guards —
those are `default-params`/`destructure` territory, strict, different
semantics); `break`s to any other label; `try`/`__pc`/`__exc` (refuse,
`pc-tracked-region`); `if` statements with an `else` branch (never observed
here); any run where `rRes` is read between reset and commit.

### Framework prerequisite F18 (`src/emit/ast.ts` + `print.ts`)

Two node forms:

```ts
| { readonly k: "optmember"; readonly obj: Expr; readonly prop: Expr;
    readonly computed: boolean }                      // obj?.prop / obj?.[e]
| { readonly k: "optcall"; readonly callee: Expr; readonly args: readonly Expr[];
    readonly thisIsBase: boolean }                    // callee?.(args)
```

plus a `bin` op `"??"`. Printer: `?.`/`?.[`/`?.(`; a chain containing any
optional link must **not** be re-parenthesised in a way that breaks the
short-circuit scope (JS: `(a?.b).c` throws where `a?.b.c` does not — the
printer must emit an unparenthesised chain for nested
`optmember`/`member`-of-`optmember`, and precedence for `??` must
parenthesise mixed `??`/`||`/`&&` — a bare mix is a SyntaxError, which
`parses` will catch, but emit the parens deliberately, not by luck).
`effectSequence` must record `optmember`/`optcall` as **conditional
suffixes**: the base's effects unconditionally, each subsequent link's member
read/call marked as guarded (D14 note in §6 explains why the checker never
compares a guarded effect against an unguarded one). `walk`/`mapExpr`
recurse into all children; `freeNames` as for `member`/`call`.

## 4. Matcher

Site = one statement list `L` (the labeled block's body is such a list).

**C — optional chain.** Anchor: **not** a fixed opening shape — a run is a
sequence of alternating **link** (a statement `rT = <link expr>` where the
link expr is `member`/computed `member` on the current chain register, or
`Reflect.apply(rPrev, rBaseOfPrev, args)`) and **guard** (`rRes = undefined`
then `if (X == N) { break L; }`, or the spilled `rC = X == N; [rRes =
undefined;] if (rC) { break L; }` — v99, `X` the link register just
produced, or the run's own base for the very first guard), ending at a
**commit** `rRes = <final link expr>` followed by `break L`. Each link is
matched **independently of whether a guard immediately precedes it**
(implemented as `matchChainGuard`, `src/passes/optional-chain/match.ts`):
`rRes`/`L` are themselves discovered from whichever statement is the run's
*first* real guard, not assumed to open the run, so a run may begin with one
or more unguarded link reads before its first guard — v99's compiler elides
a link's own guard whenever it has separately proven that link's base
non-nullish (an object-literal base, or an earlier sibling chain over the
same register already having guarded it — `docs/lowering/optional-chaining.md`
§7, `docs/BUGS.md` row dated 2026-09-02). An all-unguarded run (no `?.` in
it at all) can never spuriously match: until a real guard is found, `rRes`
is unknown, so no link read can ever satisfy the commit condition, and the
run simply exhausts its link statements and refuses. Preconditions, all
recomputed in `check`:

1. `N` is literal `null`, or a register whose *reaching write* at this
   specific guard's read is literal `null` (`not-null-guard`) — a
   reaching-definitions check over the AST the pass already has
   (`isNullSentinelAt`, `src/passes/optional-chain/match.ts`, 2026-09-05,
   `docs/BUGS.md` follow-up): walk `list[0..idx-1]` (the statements before
   this read in the same statement list) plus every enclosing list's
   statements before the one containing `list` (outward to `fnBody`), at
   any nesting depth, in flow order; the *last* write to the register found
   this way must be literal `null`. No write found at all (the list is
   unreachable from `fnBody` by identity, or nothing precedes the read in
   the scanned prefix) falls back to the old whole-function rule (`N`'s
   only write anywhere in the function is literal `null`) — ambiguous,
   refuse exactly as before, never a new acceptance. A read inside a loop
   additionally requires the whole enclosing loop body carry no non-null
   write to the register at any position (repeat-visit soundness, mirroring
   `global-access`'s §4 condition 5). This replaces the old, strictly
   whole-function "only write in the function is literal `null`" rule,
   which a same-function *later*, unrelated reuse of the sentinel register
   used to defeat even though it can never reach an earlier read — see
   `docs/lowering/optional-chaining.md` §7 for the measured fixture
   evidence.
2. Every guard `break`s to the *same* label `L`, and `L` is the innermost
   enclosing labeled block of the run; no other statement in `L`'s body
   `break`s to `L` except the run's own tail `break` (`label-shared` — this
   is what guarantees short-circuit lands exactly after the block, where
   `rRes` is consumed as `undefined`).
3. Every reset writes literal `undefined` to the same `rRes`, and `rRes` has
   no read between the first reset and the commit (`result-read-early`).
4. Link registers (`rT`, spilled compares `rC`) are dead after the run
   (`defUse`; `state-escapes`).
5. Each link's base operand is exactly the preceding guarded register
   (`chain-broken`) — for `Reflect.apply` links, the callee is the guarded
   register and the `this` argument is that callee's own base register
   (`optcall-this-mismatch`; if the callee was guarded but loaded from `E`,
   `this` must be `E`'s register — that is `?.()`'s receiver rule).
6. The guard count ≥ 1 and every guard is loose-`==`; a mixed run (some
   strict) refuses (`mixed-guards`).
7. Nothing between run members but the run's own statements — the run is
   contiguous (`interleaved-effect`).

→ `{ rRes, base: B0, links: [{kind: member|computed|call, expr, guarded:
bool}…] }`. Each link's own `guarded` flag records whether *its own* guard
was present in `before` — the writer (§5) uses it directly: a `guarded:
false` link (the run's opening link, when the base guard was elided) prints
as a plain `member`/`call` (`a.b`), never `a?.b`; every `guarded: true` link
prints as `optmember`/`optcall` (`?.`/`?.()`). This is exactly the "first
link may be unguarded in source (`a.b?.c`)" case the matcher always keyed on
a guard's presence for, generalised to actually accept it: an unguarded
opening link was previously indistinguishable from "no base guard, refuse
the whole run" (`matchBaseGuard` required one); it no longer is.

**N — nullish.** Anchor: `if (rX != N) { break L; }` where `N` as
precondition 1, followed by a fallback body ending `break L` (or falling out
of the block), assigning `rX` exactly once as its last write. Preconditions:
1–2, plus the fallback collapses to one `Expr` exactly as spec 15 §5
(`unlowerable-fallback` otherwise), and its free registers are readable at
the block exit (`fallback-reads-body-state`). When the statement immediately
before the anchor (in the same list) is `rX = <pure expr>` with no other
reader of that write, fold it (`0 ?? d` case); otherwise the left operand is
`ident rX`.

→ `rX = <left> ?? <fallback>`.

**Idempotence (PL-08).** Structural: neither rule's anchor exists in its own
output (no `== null` guard statements remain; `optmember`/`??` nodes are not
statements). Assert with a run-twice unit test.

## 5. Writer

**C** — build the chain expression inside-out: start from `ident B0`; for each
link, wrap in `optmember` (guarded) or plain `member` (unguarded), or
`optcall` with the recorded args (reference-equal nodes). Replace the whole
run with the single statement `rRes = <chain>;` at the run's position. Delete
the resets, guards, link statements and the tail `break` — but keep the tail
`break` if any statement after the run in `L`'s body exists **and** the run
was not the block suffix (never observed; refuse `not-suffix` rather than
handle it).

**N** — replace the anchor + fallback (+ folded left write) with
`rX = left ?? fallback;`.

Prune newly-dead `let` declarations (spec 16 §5's note).

## 6. Checker

Class: **expression-only** (ladder §4.3), **recompute-and-diff**, with a D14
obligation stated below because short-circuiting makes naive effect
comparison unsound in *both* directions.

1. **Canonical expansion.** `expand(afterStmt) → Stmt[]`: from the written
   chain, regenerate the guard-block form — reset, `== null` guard with
   `break L`, link load per link, commit — and require
   `effectSequence(expand(after))` deep-equals `effectSequence(matched run in
   before)`. The pure resets/spilled compares vanish on both sides;
   the member reads and calls (the *observable* things — getters, the
   optional call itself) must line up one-to-one, each under the same guard
   depth. `expand` for N regenerates the `!=` block.
2. **Guardedness is part of the diff (D14).** `effectSequence` must tag each
   effect with its guard depth (how many `== null` guards dominate it inside
   the compared runs). A checker that flattens guards would accept a rewrite
   that moved a getter read out from behind a guard — the exact bug class
   mutation testing exists to catch. Deep-equality is over
   `(effect, guardDepth)` pairs.
3. Recompute every §4 precondition against `before` — in particular
   loose-vs-strict on every guard (a `!==` guard reaching this checker means
   the matcher confused this rung with `destructure`'s defaults; hard
   refuse), the single-write `null`/`undefined` registers, and label
   exclusivity (4.2).
4. Reference-equality of all link property/index/argument expressions between
   `before` and `after`.
5. Run-shape accounting (one statement out, flanks reference-equal).
6. The driver's `parses(fnBody)` — catches `??` mixed with `||`/`&&` without
   parens and any chain-parenthesisation mistake (§3's printer note).

**D14 / semantics.** Why each equivalence is exact — under the Hermes VM,
which is ground truth:

* **`?.` short-circuits on `null` and `undefined` only**, and loose
  `x == null` is true for exactly `null` and `undefined` in Hermes — there is
  no Annex-B `document.all` (IsHTMLDDA) object in Hermes/RN, so the one
  ECMA-262 gap between `== null` and `=== null || === undefined` cannot
  arise. That equivalence is exactly why Hermes lowers `?.` to one loose
  `Eq`, and why the reverse rewrite is exact. State this in
  `docs/lowering/optional-chaining.md` — it is the row's whole soundness
  argument.
* **Short-circuit scope.** In `a?.b.c.d`, a nullish `a` skips *all* later
  links; the block form encodes that by every guard breaking to the same
  label with `rRes` left `undefined`. Precondition 2 (one shared label,
  exclusively owned) is the structural image of the scope; the printed chain
  reproduces it because the printer never parenthesises intermediate links
  (§3).
* **Evaluation order.** Base once, then each link's read/call in order, each
  guarded by the accumulated nullish checks — the effect-sequence-with-
  guard-depth diff (check 2) is precisely this schedule, so a passing check
  *is* the order proof. Getters, Proxy traps and the optional call's argument
  evaluation (arguments are not evaluated when short-circuited — they sit
  after the guard in the block, and inside `optcall` in the chain) all ride
  on it.
* **`?.()` receiver.** `a?.b?.()` calls with `this = a` — precondition 5's
  `optcall-this-mismatch` is that rule; `Reflect.apply(rM, rBase, args)` with
  the wrong base refuses rather than rewrites.
* **`??`** evaluates the fallback only when the left is nullish; the block
  form runs the fallback statements only past the `!=` guard. The fold of a
  preceding pure write (`0 ?? d`) moves a *pure* expression across nothing.
* **The result value.** Short-circuited chains yield `undefined` (not the
  `null` that tripped them) — the block's `rRes = undefined` resets, exactly.

## 7. Ordering, refusals, fixtures, metrics

**Ordering.** `stage: "B"`, `after: ["expr-rebuild", "global-access",
"call-shape"]`, `before: ["var-naming"]` (ladder §2: optional calls are
shapes *of* a call, matched on `Reflect.apply` survivors after `call-shape`
took its own). No edge to `destructure`/`spread-rest` in either direction:
the guard discriminator (loose `== null` here, strict `!== undefined` there,
helper calls there) keeps all three shape-disjoint; each carries a negative
unit test built from the others' anchors.

**Refuse (per-site, distinct reason strings):** `not-null-guard`,
`label-shared`, `result-read-early`, `state-escapes`, `chain-broken`,
`optcall-this-mismatch`, `mixed-guards`, `interleaved-effect`, `not-suffix`,
`unlowerable-fallback`, `fallback-reads-body-state`, `pc-tracked-region`.

**Fixtures (red→green).** `targets: ["48-optional-chaining-nullish"]`, all
five HBC versions plus `.min`/`.obf`. Unit tests on hand-built lists:
positives for a 1-link and 3-link member chain, a computed link, a call link
with base guard, the v99 spilled-compare guard, `??` with register fallback,
`??` with folded literal left; negatives for a strict `!==` guard (must not
match — that is `destructure`'s default), a guard breaking to a foreign
label, a chain whose `rRes` is read mid-run, a `Reflect.apply` whose `this`
is not the callee's base; ≥1 site the `check` refuses (e.g. a mutated
guard-depth sequence).

**Corpus metric** (`tools/passes-metrics.ts`): count of `== <null-reg>` /
`!= <null-reg>` guard statements (the §2 shapes) remaining in printed
output. Baseline: 13 chain guards + 5 nullish guards in `48` at v94.
**Floor: ≥ 90 %** removed across `tests/fixtures/constructs/**` at all five
versions × base/`.min`/`.obf`, and **≥ 60 %** on the RN template bundle
(hand-written `x == null` in app code legitimately stays — see §8 Q1). Zero
fixture verdict moves; PL-09 holds; `--passes=none` byte-identical; residual
reasons histogrammed in `docs/STATUS.md`.

**Estimated size:** ~280 lines across `match/rewrite/check`, ~80 lines F18
(nodes + printer precedence + `effectSequence` guard depth), ~260 lines of
tests.

## 8. Open questions

1. **Hand-written `if (x == null) …` in source.** A human's null-check with
   the same block shape would be rewritten into `?.` — is that wrong? The
   rewrite is *observationally exact* (same tests, same reads, same result
   register), so it can never be a correctness bug; it is a readability
   trade the fixtures cannot distinguish by construction. Accept it, and let
   the equivalence gate be the arbiter — this is the same stance
   `template-literal` §6 takes on `-O0` information loss, in reverse.
2. **`getMethod` guard.** The ladder one-liner mentioned a `getMethod`
   lowering for `?.()`; it does not appear in `48` at v94/v99 (plain
   `GetById` + `Reflect.apply` instead — §2.2). If the dump re-read at other
   versions surfaces a `GetMethod`-style builtin, add it as a link variant
   with its own evidence; do not pre-build it.
3. **`delete a?.b` / optional chains in write position** are SyntaxErrors or
   distinct lowerings not covered by any fixture; the anchor shapes cannot
   produce them. Nothing to do until a fixture exists.
4. **Label dissolution.** §1 leaves the emptied labeled block's label in
   place when no stage-B label-dropper exists. If review finds that ugly
   enough to matter, the fix belongs in a shared stage-B utility (or
   `label-clean` gains a stage-B sibling), not in this rung.
