# 07 — `var-naming` (stage B, catalogue row **R5**)

Reading list: `docs/AGENT-BRIEF.md`, `src/passes/README.md`, this file. Depends
on `01-framework-fixes.md` (`ctx.module`, `ctx.fnBody`, `src/passes/ast.ts`).
Runs **last in stage B before `jsx-recover`**, after every rung that folds or
deletes registers (`expr-rebuild`, `call-shape`, `global-access`, `fn-naming`).

Scope note: catalogue row R5 pairs `var-naming` with `closure-naming` and
describes the job as replacing `rN`/`_eN_M` "with a recovered source name". Two
corrections this spec is built on. (1) **There is no source name to recover.**
A Hermes local lives in an anonymous register; the bytecode carries names only
for *functions* (fn-naming's input) and, at `-g`, for lexical *environment
slots* (closure-naming's input). A bare register `rN` has none. So this rung is
**not recovery — it is heuristic better-naming**: it invents a readable name
from how the register is *used*, and keeps `rN` whenever it cannot justify one.
(2) The `_eN_M` env-slot half is `closure-naming`'s domain (ladder §5.4, a
module-level analysis); **this spec owns register variables only.** Env slots
are left untouched.

## 1. Purpose

After `expr-rebuild` inlines every single-def/single-use temporary, the
registers that *survive* into the printed output are the ones that genuinely
cross a statement boundary — loop counters, accumulators, an array being built
up, the receiver of a chain of calls. They still print as `r0`, `r15`. Give the
justifiable ones a readable name; leave the rest as `rN`. Pure alpha-renaming
within one function frame: no statement moves, no expression changes shape, no
value is computed differently.

Before — `04-for-loop-basic/v94.hbc`, inside `_fn0` (all earlier rungs applied):

```js
r15 = new Array(0);
L0: for (r11 = 0, r0 = r9; r11 < r0; r11 = …+1, r0 = …-1) {
  r15.push(r11 + r14 + r0);
}
r0 = r15.join(" | ");
```

After:

```js
arr = new Array(0);
L0: for (i = 0, r0 = r9; i < r0; i = …+1, r0 = …-1) {
  arr.push(i + r14 + r0);
}
r0 = arr.join(" | ");
```

`r15` (single-def array) → `arr`; `r11` (this loop's induction var) → `i`. `r0`
stays `r0`: it is re-assigned all over the frame for unrelated values — the
reuse hazard of §6, detected and refused.

## 2. Baseline shape

The emitter declares a function's live registers in one leading statement
`{k:"decl", kind:"let", names:["r0","r1",…]}` (`src/emit/function.ts`) and
writes each as `{k:"init"|"assign"}` with target `{k:"ident", name:"rN"}` and
reads as `{k:"ident", name:"rN"}`. `src/passes/index.ts`'s F10 finaliser has
already dropped any leading `let rN` that ended up dead, and its F26 finaliser
(docs/BUGS.md 2026-09-01 "register prologue") runs right after F10: a
surviving name whose first occurrence anywhere in the function is a plain
top-level `name = value;` becomes an inline `let name = value;` at that same
statement, in place of staying hoisted uninitialised in the leading decl. So
by the time this rung's matcher ever sees a function, a live register may
already be sitting in either shape — `decl.names` still lists every register
this rung may rewrite, whether or not F26 later moves *another* register's
declaration inline; this rung itself never runs before F26 (it is the last
rung of stage B, F26 is a post-pipeline finaliser) so it always sees the
pre-F26 shape described above. Parameters are a *separate* class the emitter
already names `a1…aN` (`function.ts:168`); they are not `rN`. Nested functions
restart register numbering from `r0` in their own frame (AGENT-BRIEF: Hermes
restarts `r0` per function).

## 3. AST shape the rung owns

May match/rewrite (ladder §3.2, "`ident` names … only — pure alpha-renaming"):
the `name` of an `{k:"ident"}` that is a register (`isRegisterName`), whether it
appears as a read, an `assign` target, an `init` name, or an entry of the
leading `decl.names`. **Must not touch** anything else: no statement order, no
expression shape, no comment, no non-register name, and — critically (§5) — **no
occurrence inside a nested `func` body**, which is a different register frame.
Env slots (`_eN_M`), params (`aN`), function names (`_fnN`, or the real names
fn-naming already applied) are all out of scope.

## 4. Matcher

**The site is the function-body root list only**: `match` returns `null` unless
`list === ctx.fnBody` and `ctx.module !== undefined`. A register is
function-scoped — it can appear in any nested block of the body — so a
per-sublist site could not see every def/use; the whole frame must be analysed
at once. As with `fn-naming`, `match` classifies every register candidate in one
`classifyAll` pass — **one frame-local walk** (`collectFacts`) gathers every
register's def values, induction-loop defs and array-receiver/test uses at
once, then one `freeNames`/`declaredNames` pair seeds the `taken` set — and
returns **every** register that earns a name (data `{ renames: [{ from:"rN",
to:name }, …] }`, in first-def order). **Batched, not one per match** (spec 05
§4's convention, adopted for docs/PUSHBACK.md P-1, 2026-08-31): the verdicts
depend on each other only through `taken`, which is threaded through the
candidates in first-def order exactly as a one-rename-per-iteration driver
loop would have done, so the batched output is the same as the per-iteration
output at O(B) instead of O(K²·B). Idempotence is structural (PL-08): a
renamed register is no longer `isRegisterName`, so it is never a candidate
again; the driver's re-run of `match` after the batch finds only refused
registers (or, rarely, a call result whose callee was itself just renamed —
`r5 = r3(…)` with `r3 → foo` now yields `foo2` — which converges on the next
iteration).

### 4.1 Nameable registers (the reuse gate — read §6 first)

A register is a candidate only if it clears the **reuse gate**: either

* **single-def** — `defUse(ctx.fnBody).get(rN).defs.length === 1` (frame-local;
  `defUse` does not descend into nested funcs, §5); or
* **multi-def but single-role** — every def matches exactly one of the two
  recognised whole-frame roles below (§4.2 #1 loop-induction, or #5
  accumulator). A register whose defs mix roles, or hold plainly unrelated
  values, is **refused** (`reuse-conflict`) and keeps `rN`.

### 4.2 Naming heuristics, in priority order

For a gated candidate, take the **first** rule that fires; its `base` name feeds
§4.3's collision resolver. `def` = the register's sole defining `value` (for
single-def) or its role.

1. **Loop induction var** → base from the pool `i, j, k, l, m, n`. Fires when
   the register is a loop variable of a `for` node: it is the `assign` target in
   the `for.init` (or a `seq` term of it) **and** in `for.update`, and is read
   in `for.test`. Multi-def is expected and allowed here (init + update). The
   pool is drawn in first-def order (§4.3), so an outer loop's counter takes
   `i`, the inner's `j`.
2. **globalThis alias** → **refuse** (`globalthis-alias`), keep `rN`. `def` is
   `{k:"ident", name:"globalThis"}` (or an ident carrying `global:true`).
   Brief's "drop it": a rename-only pass cannot delete the binding, and a
   readable alias for `globalThis` misleads; `global-access` normally erases
   these already, so this is a belt-and-braces refusal, not a naming rule.
3. **Array / list** → base `arr` (or `list`). `def` is `new Array(…)` /
   `{k:"array"}`, **or** the register is the receiver `obj` of a `.push`/`.pop`/
   `.join`/`.length`/`.indexOf` member in the frame and never assigned a
   non-array value.
4. **Call result** → base from the callee. `def` is `{k:"call"|"new"}` whose
   callee is an `ident foo` → `foo` for `call`; a `new C(…)` → the lower-camel
   of `C` (`Error` → `err`, `Foo` → `foo`); a `member … .m` → `m`. If the
   base equals the callee's own name (would shadow the function), fall to the
   `-Result`/numeric suffix in §4.3.
5. **String accumulator** → base `s` (or `str`). Every def is
   `{k:"assign"|"init", value: {k:"bin", op:"+", …}}` that reads the register
   itself, **or** the single def is a string literal that is later the left arm
   of a `+`-chain assigned back to it.
6. **Boolean guard** → base `ok` (or `cond`). `def` is a `{k:"bin"}` with a
   comparison op, a `{k:"logical"}`, a `{k:"unary", op:"!"}`, or a `typeof …===`
   chain, **and** the register is read as the `test` of an `if`/`while`/`cond`.
7. **Otherwise** → **refuse** (`no-heuristic`), keep `rN`. Do not force a name.

**§9 Q4 compound upgrade (docs/specs/passes/19-reg-split.md, 2026-09-02).**
Reg-split's per-store webs turn many multi-role registers into single-def,
single-role ones (§4.1's reuse gate no longer refuses them), which makes the
following additional single-def heuristics safe. Priority, all below the
seven above and in this order (each checked only after every stronger shape
above it refuses to fire):

8. **Container subscript** → base `list`. The register is read/written as the
   `obj` of a *computed* member (`r6[r0]`) anywhere in the frame and rule 3
   did not already fire (no explicit `Array`/named-method evidence) — weaker
   than rule 3 because a dict-shaped object subscripted by a non-numeric key
   is just as likely, hence the more neutral word.
9. **Object / closure literal** → base `obj` for `{k:"object"}`, `fn` for
   `{k:"func"}` (an anonymous closure assigned to a register) — as
   unambiguous as rule 3's array literal, no program text to misread.
10. **Property-read alias** → base = the property name. `def` is a `member`
    that is *not* itself a `call`'s callee (rule 4 already owns that shape):
    `a1.items` or the computed-but-literal `a1["items"]` both take `items`.
11. **Boolean-literal flag** → base `flag`. `def` is a bare `{k:"lit",
    text:"true"|"false"}` **and** the register is read as a test (rule 6's
    test-position gate, reused).
12. **Ordering-comparison bound** → base `limit`. `def` is a bare numeric
    literal **and** the register is read as one operand of a `<`/`<=`/`>`/`>=`
    comparison anywhere in the frame (a loop test's bound, a guard's
    threshold) — honest about the register's *role*, never about what it
    counts.
13. **Alias-of-named-thing** → base = the aliased name. `def` is a bare
    `{k:"ident"}` naming something real: not a register (`isRegisterName`)
    and not a bare parameter (`a\d+` — aliasing a param with no other
    evidence stays `no-heuristic`, honouring the params carve-out below
    rather than forcing a resolvable-but-meaningless name).
14. Rule 3's `ARRAY_METHODS` set additionally widened (still §4.1-honest —
    every added name is `Array.prototype`-only, absent from `String.prototype`
    and `Object.prototype`): `shift`, `unshift`, `splice`, `forEach`, `map`,
    `filter`, `reduce`, `reduceRight`, `sort`, `reverse`, `flat`, `flatMap`,
    `find`, `findIndex`, `fill`, `some`, `every`.
15. Rule 5's multi-def accumulator gate widened to accept a numeric-literal
    seed (`x = 0; x = x + n`) alongside the string-literal one — previously
    `reuse-conflict` because the all-defs-`isStringLit`-or-`isBinPlusSelf`
    test rejected a numeric seed outright. Base is `s` if any def is a
    string literal (unchanged), else `sum`.

Measured impact: `tests/gate/passes/var-naming-metrics.test.ts`'s header
(v94+v99 base 3.4% → 13.1%, full matrix 3.1% → 10.0%, RN template bundle
4.1% → 20.2%) — short of this task's 15% construct-corpus target on the gate
subset, past it on the RN bundle.

**Params (`aN`).** Out of scope by default: the emitter already gives every
parameter a positional name `aN`, which is more honest than a guessed one, and
renaming `a1 → arg0` is a regression. A usage-evidence param rename (e.g. a
param used only as a `.push` receiver) is deferred to a follow-up; this spec
keeps `aN`. (This is the ladder's "params keep `aN` unless evidence names
them", read conservatively.)

### 4.3 Collision resolution and de-duplication

Compute the frame's **taken** set once: `freeNames(ctx.fnBody) ∪
declaredNames(ctx.fnBody)` (the `declaredNames` helper `fn-naming`/
`global-access` already define — func names incl. the real ones fn-naming
applied, `decl`/`init` names, params, `catch` bindings, nested func names/
params), plus every register base already assigned earlier in this same driver
run (they are in `declaredNames` once renamed, so re-reading `ctx.fnBody`, which
the driver re-derives per site, suffices — no cross-site state, PL-07).

Given `base`:

* induction pool — pick the first of `i,j,k,l,m,n` not in `taken`; if all six
  are taken, refuse (`pool-exhausted`), keep `rN`.
* every other base — if `base ∉ taken`, use it; else try `base + "2"`, `+ "3"`,
  … (fn-naming deliberately does *not* suffix, but there the suffix reads worse
  than `_fnN`; here `arr2` reads better than `r7`). Cap at `base + "9"`; refuse
  (`dedup-exhausted`) beyond that.

A resolved name must additionally satisfy, exactly as fn-naming §4 conditions:
`isSafeIdentifier(name)` (never a reserved word), and `name` matches no emitter
name class `/^(_fn\d+|_e\d+_\d+|r\d+|__.*|_exc\d+|L\d+|__state\d+|a\d+)$/` (note
`a\d+` added so a heuristic can never manufacture a param-shaped name). These
never fire for the fixed bases above but guard the call-result/accumulator bases
derived from program text.

## 5. Writer — frame-local rename

Rebuild the root list renaming every register occurrence of `from` to `to`:
the entry in the leading `decl.names`, and every `ident`/`assign`-target/`init`-
name in the body. **Do not reuse `fn-naming`'s `renameIdent`**: it is built on
`mapStmts`/`mapExpr`, which recurse into nested `func` bodies — correct for a
module-scoped `_fnN`, **wrong for a register**, whose `rN` in a nested closure
is that closure's own distinct frame slot (AGENT-BRIEF; `identUses`/`defUse`
encode exactly this — `nested` is always 0 for a register name). The rung needs
a `renameRegisterInFrame(list, from, to)` that walks like `identUses` does but
returns **without recursing** at any `{k:"func"}` node (statement or
expression), renaming only the current frame. Nothing else changes; no statement
is added, removed, or reordered.

## 6. The reuse hazard (this rung's central correctness risk)

Hermes aggressively reuses one register for semantically unrelated values within
a function (`04-for-loop-basic`'s `r0` holds a loop bound, a join result, a
call result, and the constant `0` at different points). Giving such a register
one name asserts a coherence that is not there and actively misleads the reader.
The gate in §4.1 is the defence: **only single-def registers, or multi-def
registers all of whose defs share one recognised role (loop-induction /
accumulator), are ever named.** Everything else keeps `rN`. This is a deliberate
precision-over-recall choice and the reason the corpus target (§7) is ~50-70%,
not higher — a refused register is a readable, honest `rN`, never a wrong name.

## 7. Checker

Class: **alpha-renaming** (ladder §4.3), the same four obligations `fn-naming`
§6 asserts, recovered by diffing `before`/`after` (the single `(from,to)` pair
is the register whose occurrences changed name), with two register-specific
additions:

1. `freeNames(after)` equals `freeNames(before)` with `from`→`to`, and `to ∉
   freeNames(before)` (no capture);
2. `to` is not already declared/free in `before`, in any enclosing scope, or in
   any nested `func` — re-run the §4.3 `taken`-set test;
3. `printProgram(before) === printProgram(renameRegisterInFrame(after, to,
   from))` — undoing the rename is byte-identical;
4. counts match: `identUses(before,from).reads+writes ===
   identUses(after,to).reads+writes`, and `identUses(after,from)` is zero on
   **all three** fields (`reads`/`writes`/`nested`) — a surviving `nested>0`
   here would mean the rename wrongly reached into a nested frame, the one bug
   §5 exists to prevent;
5. **frame-locality**: `defUse(before).get(from)` and `defUse(after).get(to)`
   have identical `defs`/`reads` index arrays (same positions, same
   multiplicity) — the rename touched exactly this frame's occurrences of the
   register and no others. Implementation note (2026-08-31): `defUse` itself
   records only `isRegisterName` names, so it can never answer the `to` side
   (an early draft asked it anyway and refused every rename); the rung's
   pass-local `frameOccurrences(list, names)` (`frame.ts`) is the same walk,
   same statement indexing, for any name, and is what both sides are asked of.

`checkBindings` (EM-01) over the whole program is the backstop: an undeclared
identifier is a hard error, never degraded output.

## 8. Ordering, refusals, metrics

**Ordering.** `after: ["expr-rebuild", "call-shape", "fn-naming"]` (and
`global-access`, injected). Names are computed on the *cleaned* tree: registers
that `expr-rebuild` would fold must be gone first (naming one wastes a name and
the fold is blocked), `call-shape` must have turned `Reflect.apply(f,…)` into
`f(…)` so heuristic #4 sees a real callee, and `fn-naming` must have run so its
recovered names are in the `taken` set (never collide with a real function
name). `before: ["jsx-recover"]` is left to `jsx-recover`'s own `after` when it
lands (same convention as fn-naming's omitted forward `before`s).

**IR ownership.** `ident` register names only (ladder §3.2). No statement order,
no expression shape, no comment, no env slot, no param.

**Refuse (per-register):** `reuse-conflict`, `globalthis-alias`, `no-heuristic`,
`pool-exhausted`, `dedup-exhausted`, `reserved-word`/`emitter-name-class` (from
§4.3). Every refusal leaves a correct, unique `rN`.

**Corpus metric.** Share of surviving register-variables (distinct `rN` still
declared after `expr-rebuild`) that receive a name, over
`tests/fixtures/constructs/**` at all five versions × base/`.min`/`.obf`.
Baseline **0 %**; target **50-70 %** — single-def registers dominate the
survivors, loop counters and built-up arrays are the reliable multi-def wins,
and heavily-reused scratch registers (correctly) stay `rN`. Report the surviving
`rN`-token count and the abandonment-reason histogram on the RN template bundle
in `docs/STATUS.md`.

**Measured (2026-08-31, `tools/passes-metrics.mjs` `measureVarNaming` /
`measureVarNamingBundle`): 3.1 %** over the full matrix (39,635 surviving
register variables → 38,368), 3.4 % on the gate's v94+v99 base subset (floor
3 % in `tests/gate/passes/var-naming-metrics.test.ts`), **4.1 %** on the RN
template bundle (`rN` tokens 204,381 → 199,307). The estimate above was wrong
about what a single-def survivor *is*: in the real output it is overwhelmingly
a literal (`r9 = 10`) or a parameter/env alias (`r9 = a1`), which §4.2 #7
refuses by design, and nearly every multi-def survivor is scratch reuse the
§4.1 gate refuses. The rules fire exactly where the spec licenses them; more
recall is a spec change (new heuristics), not a lower bar. The
abandonment-reason histogram is not yet reported (follow-up: expose the
per-register `RefuseReason` through the driver's diagnostics).

**Acceptance gate.** `npm test` green with the gate staying **0-DIVERGENT** with
passes on *and* off (PL-09), and `--passes=none` byte-identical to the M4
baseline (PL-05).

**Fixtures (red→green).** `targets: ["04-for-loop-basic",
"22-nested-closures-counters", "43-template-literals", "02-while-loop"]`, all
five versions plus `.min`/`.obf`:

* `04-for-loop-basic` — nested-loop induction vars (`i`/`j`) and a `new Array`
  accumulator (`arr`), alongside a heavily-reused `r0` that must stay `rN`
  (the reuse-gate negative);
* `22-nested-closures-counters` — the frame-locality case: a register used in
  the outer function must not be renamed inside a nested closure that reuses
  the same number (§5);
* `43-template-literals` — single-def array literal (`arr`) and single-def
  call results (heuristic #4);
* `02-while-loop` — a loop counter that is not in a `for` header (accumulator/
  guard classification), plus a boolean guard register.

Unit tests (`tests/gate/passes/synth.ts`): ≥1 positive per heuristic
(#1,#3,#4,#5,#6); negatives for a reused multi-role register (`reuse-conflict`),
a `globalThis` alias, a register with no heuristic, and a nested-frame register
that must not be renamed from the outer frame; ≥1 site `check` refuses (a rename
whose undo is not byte-identical).

## 9. Version differences

None specific to this rung. It reads the emitter's own register/param/decl
shapes, which are identical across layouts (the register allocator differs per
version, so *which* registers survive and get named differs, but the matcher and
the alpha-rename contract do not). No opcode is inspected.

---

## Acceptance checklist

- [ ] `src/passes/var-naming/{index,match,rewrite,check}.ts`; one registry line,
      registered last among stage-B rungs (before `jsx-recover` when it lands);
      `catalogue: ["R5"]`.
- [ ] `match` returns `null` unless `list === ctx.fnBody && ctx.module`; returns
      the first gated+named register; `null` on its own output (idempotent).
- [ ] Reuse gate (§4.1) enforced: only single-def or single-role-multi-def
      registers named; `reuse-conflict` refusal covered by a unit test.
- [ ] Heuristics §4.2 in priority order; `globalThis` alias and no-heuristic
      registers refused, not force-named.
- [ ] De-dup/collision (§4.3): induction pool `i..n`; other bases suffixed
      `2..9`; `taken` = free ∪ declared (incl. fn-naming's names); never a
      reserved word or emitter name class (incl. `aN`).
- [ ] Writer is **frame-local** (`renameRegisterInFrame`, stops at nested
      `func`); does not reuse fn-naming's recursive `renameIdent`.
- [ ] `check` = alpha-rename soundness: obligations 1-4 + frame-locality (5),
      `identUses(after,from)` zero on all three fields.
- [ ] `after: ["expr-rebuild","call-shape","fn-naming"]`; `--passes=none`
      byte-identical; gate 0-DIVERGENT with passes on and off.
- [ ] Red→green on the four target fixtures × 5 versions × base/`.min`/`.obf`;
      unit tests per §8.
- [ ] Corpus metric 50-70% register-vars named; `docs/STATUS.md`, `docs/AGENT-
      LOG.md`, catalogue R5 Pass column updated in the same commit.

## Review responses

* **P-6 (2026-08-31 → resolved 2026-09-02).** The §1 example and §8's
  "induction vars (i/j)" claim contradict §4.1's reuse gate on
  `04-for-loop-basic` itself (`r11`/`r1` are multi-role there). Resolution:
  **the gate stands; the example was optimistic.** The recall gap
  (3.1 % named) is register *reuse*, and it is now `reg-split`'s job
  (`docs/specs/passes/19-reg-split.md`, runs `before: [var-naming]`): after
  splitting, each disjoint live range is its own single-def/single-role
  variable and clears §4.1 unchanged. The §1 example is accurate again in a
  post-reg-split pipeline. One implementation knock-on lands with reg-split
  (its F15): the §4.3 emitter-name-class regex's `r\d+` becomes
  `r\d+(_\d+)?` so a heuristic base can never collide with a split name.

## Estimated complexity

**Medium** — heavier than `fn-naming` (which had one evidence source and one
role). ~200-230 lines across `match`/`rewrite`/`check` (the matcher carries six
heuristics + the reuse gate + collision resolver; the writer is a ~40-line
frame-local walk; the checker adds two obligations to fn-naming's four),
~220-260 lines of tests. The two genuine risks are both design-pinned above: the
**frame-locality** of the rewrite (§5, do not recurse into nested funcs) and the
**reuse gate** (§6, single-def / single-role only). No new framework helper is
required — `defUse`, `identUses`, `freeNames`, `declaredNames`, `isRegisterName`,
`isSafeIdentifier` already exist; `renameRegisterInFrame` is pass-local.
