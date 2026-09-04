# 03 — `global-access` (stage B, catalogue row **R2**)

Reading list: `docs/AGENT-BRIEF.md`, `src/passes/README.md`, this file.
Depends on `01-framework-fixes.md`; runs after `expr-rebuild`.

## 1. Purpose

Every global read in Hermes bytecode is `GetGlobalObject` + `TryGetById`, which
`src/emit/lower.ts` lowers faithfully to a guard plus a member read. Three or
four printed lines per `print(…)` call is the single loudest noise in the
baseline. This rung turns the guarded read back into a bare identifier.

Before — `19-var-hoisting/v94.hbc`, `fn#1 "demo"`, after `expr-rebuild`:

```js
r1 = globalThis;
if (!("print" in r1)) {
  throw new ReferenceError("Property 'print' doesn't exist");
}
Reflect.apply(r1.print, undefined, ["x before declaration:", undefined]);
```

After:

```js
Reflect.apply(print, undefined, ["x before declaration:", undefined]);
```

## 2. Baseline shape

`lower.ts` emits, for `TryGetById dst, obj, "p"`:

```ts
{ k: "if",
  test: un("!", bin("in", lit(quote(p)), obj)),
  then: [{ k: "throw", arg: { k: "new", callee: id("ReferenceError"),
           args: [lit(quote(`Property '${p}' doesn't exist`))] } }],
  else: [] }
```

followed by `dst = obj.p`, `obj` being whatever register `GetGlobalObject`
wrote (`set(dst, id("globalThis"))`). After `expr-rebuild` the member read is
usually already inlined into its consumer, so the guard and the read sit in the
same list but are not adjacent.

## 3. AST shape the rung owns

May match/rewrite: the guard `if` above, `ident globalThis`, `member` reads
whose object is a proven global reference, and the `rX = globalThis` store once
its last use is gone. **Must not touch** any other `throw`, any `member`
*write* to the global object, or the `DeclareGlobalVar` idiom (§7).

## 4. Matcher

Site = one statement list `L`.

**Proving a global reference.** `G` is a global reference when it is either
`{k:"ident", name:"globalThis"}`, or `{k:"ident", name:"rN"}` such that
`defUse(ctx.fnBody)` gives `rN` **exactly one** write in the whole function,
that write's value is `{k:"ident", name:"globalThis"}`, and
`identUses(ctx.fnBody, rN).nested === 0`. Anything else: refuse
(`unproven-global`).

**R2 — guarded global read.** `L[i]` is a guard `if` matching §2 *structurally*
(negated `in`, string-literal left operand `p`, a single `throw new
ReferenceError` in `then`, empty `else`), whose right operand is a global
reference `G`; and there is a first `j ≥ i + 1` in `L` whose statement contains
a `member` read `{k:"member", obj: G′, prop: lit(quote(p)), computed:false}`
with `G′` the *same* expression as `G` (`ident` name equality). Additional
conditions, all required:

1. `isSafeIdentifier(p)` — `p` is a valid, non-reserved identifier.
2. `p` is not bound anywhere that would shadow it: it is not in
   `freeNames(ctx.fnBody)` as a *declared* name — not a register name, not an
   env slot `_eD_S`, not `_fnN`, not a parameter, not `__hbc*`/`__pc`/`__exc`,
   and not declared by any `decl`/`init`/`func` in `ctx.fnBody` or in any
   enclosing function the rung can see. When in doubt, refuse (`shadowed`).
3. No statement in `L[i+1..j-1]` writes `G`, writes the property `p` on `G`, or
   contains another guard for `p`.
4. The member read at `j` occurs **exactly once** in that statement.
5. **Loop re-entry** (added 2026-09-04, docs/BUGS.md T14). Conditions 3 and
   the global-reference proof above are both *chronological*: they read "later
   in the list" as "later in time", which only holds while control passes
   through the site **once**. If `L` is (transitively) inside a loop body, a
   write that sits after the read in program text runs *before* it on every
   repeat visit. So: let `B` be the body of the **outermost** loop
   (`while`/`do-while`/`for`, labelled or not) that transitively contains `L`
   — outermost, because a clobber in an outer loop can precede the read on
   that outer loop's re-entry just as an inner one can. If `B` exists and any
   write to `G`'s register anywhere in `B` (before or after the read, at any
   nesting depth, excluding a nested `func`'s own frame) has a value other
   than `{k:"ident", name:"globalThis"}`, refuse (`loop-reentry-clobber`). A
   write valued `globalThis` re-establishes exactly the value being proven and
   is not a clobber. Where no loop encloses `L`, the whole-function proof is
   unchanged — which is what keeps §7's `targets` green, since Hermes's reuse
   of the `globalThis` register for scratch after the last guarded read can
   never run again before that read outside a loop.

   *Implementation note.* The enclosing loop is computed from `ctx.fnBody` by
   locating `L` **by identity** (`outermostLoopBodyContaining` in `match.ts`),
   not plumbed through `classifySite`'s signature: `stmtLists`
   (`src/passes/ast.ts`) hands the driver the very arrays that live inside
   `ctx.fnBody`, and `check` is given that same `before` array, so both sides
   re-derive the identical verdict with no signature change — the smaller of
   the two options. A list that is not found under any loop (including
   `ctx.fnBody` itself) is treated as non-loop.

Match data: `{ guardIndex: i, useIndex: j, name: p, global: G }`.

Only the *first* guard/read pair in the list is captured per call; the driver
re-runs the rung until it stops matching, so a list with twelve guards is
rewritten twelve times, each with its own `check` and its own abandonment.

## 5. Writer

Delete `L[i]`; in `L[j]` replace that one `member` node with `{k:"ident",
name:p}`. Nothing else moves. A now-dead `rN = globalThis` store is **not**
removed here (`expr-rebuild`'s R1b has already run); `01` F10 prunes the
declaration and `var-naming` (batch 2) clears the residue — one dead line, not
a correctness issue.

## 6. Checker

Class: **expression-only**, plus the ladder §4.3 extra: *the dropped guard's
property name equals the member read that follows it* — the `in` check and the
read are one effect, and that identity is the whole justification for deleting
the guard. `check` therefore asserts, recomputing from `before`:

1. `before[i]` is structurally the §2 guard, for name `p`, on `G`;
2. `before[j]` contains exactly one `G.p` read and `after[j-1]` contains
   exactly one `ident p` in the same position;
3. `expressionOnlyCheck(before, after)` **after normalising** the one effect
   pair the rung is licensed to change: the `member` read of `G.p` in `before`
   maps to a bare-identifier read in `after`, and the guard's `in` test plus its
   unreached `throw` disappear. Implement this as: `effectSequence(before)`
   with the guard's effects and that member read removed must deep-equal
   `effectSequence(after)` with the corresponding identifier read removed;
4. `G` is still a proven global reference (§4) in `before`;
5. `p` is not a declared name in `before` (re-run the §4.2 test);
6. §4 condition 5 holds for `before` as the site list — the site is not inside
   a loop whose outermost body clobbers `G`'s register
   (`loop-reentry-clobber`). Re-derived here independently of `match`, like
   every other item.

## 7. Ordering, refusals, semantics, metrics

**Ordering.** `after: ["expr-rebuild"]`, and **before `call-shape`**
(`before: ["call-shape"]`): `Reflect.apply(r0.print, undefined, …)` must become
`print(…)`, not `globalThis.print(…)`.

**`DeclareGlobalVar` is out of scope — a deliberate departure from the ladder.**
The ladder's R2 also asks for `hasOwnProperty(globalThis,"d") ‖ globalThis.d =
undefined` → `var d`. **Refuse it.** The emitter wraps the module in an IIFE, so
a `var d` there is function-scoped and creates no property on the global object,
while the bytecode provably does create one. The harness's `globals` trace
record sees exactly that difference, and D14 says print what the bytecode does.
Leave the pair alone; the readability cost is two lines in the global function
only. Record the reason `global-var-declaration-is-observable` if a
site is otherwise tempting.

**Refuse (per-site):** `unproven-global`, `loop-reentry-clobber` (§4
condition 5: the site is inside a loop whose outermost body writes `G`'s
register a non-`globalThis` value, so the write can precede the guarded read
on a repeat visit), `shadowed`, `unsafe-identifier`
(`p` = `"default"`, or containing a `-`), `no-read-after-guard` (leave the
guard), `clobbered-between`, `read-twice`, `guard-in-other-list` (guard and
read must share a statement list; a read that migrated into a nested `if` body
is refused, not chased).

**Semantic note (must appear in the commit message and `docs/BUGS.md` if a
fixture trips it).** A bare `print` reference throws
`ReferenceError: print is not defined` where the guard threw
`ReferenceError: Property 'print' doesn't exist`. The kind is identical, the
message is not; the harness compares messages. This only differs when the
global is genuinely absent, which no passing fixture exercises — but PL-09
requires PASS with passes on *and* off, so any fixture whose verdict changes is
a hard stop, not a tolerated delta.

**Fixtures (red→green).** `targets: ["19-var-hoisting", "01-if-else-chain",
"02-while-loop"]`, all five versions and `.min`/`.obf`. Unit tests: ≥1 positive,
negatives for a guard whose name differs from the read, a shadowed name, a
non-`globalThis` object, and a register with two `globalThis` stores; a guard+read in a loop
body whose register is clobbered inside that loop and one whose clobber sits
in an enclosing outer loop (both `loop-reentry-clobber`), with positives for a
loop body that never writes the register, a loop write valued `globalThis`
itself, and the straight-line scratch-reuse idiom; ≥1 site `check` refuses.

**Corpus metric.** Share of emitted functions containing zero
`" in ` global guards: baseline 0 %, target **100 %** on
`tests/fixtures/constructs/**` at all five versions, and ≥ 95 % on the RN
template bundle. `globalThis.` occurrences fall by ≥ 60 %.

**Estimated size:** ~140 lines across `match/rewrite/check`, ~180 lines of
tests.
