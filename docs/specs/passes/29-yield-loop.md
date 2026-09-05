# 29 -- `yield-loop` (stage B): the generator whose suspend graph has a back edge

**Catalogue row:** `R15` (readability). The lowering provenance is index row 17
([generators.md](../../lowering/generators.md)), the same v<=96 opcode-driven
coroutine `yield-recovery` recognises; this rung recognises no new Hermes
idiom, only the *cyclic* form of that one, hence an `R` row.
**Fixtures:** `23-generator-basic` (`counter`), `26-infinite-generator-take`
(`naturals`).
**Ladder row:** `00-LADDER.md` section 1.1, immediately after `yield-recovery`.
**Versions:** 84, 94, 96 -- `yield-recovery`'s window, for the same reason
(spec 25 section 1.7: at v>=97 a generator is `__hbc_makeGeneratorLowered`,
which is `gen-lowered`'s idiom, catalogue row 18).
**Ownership:** spec 25 section 3.1/3.2 verbatim -- one *generator group* per
enclosing function body. A group `yield-recovery` already recovered carries
`generator: true` and is answered `no-generator-site` before anything else is
read, so the two rungs never compete for a site.

This spec exists because spec 25 section 1.4 refused the cyclic form (R-Y5
`cyclic-dispatch`) and section 6.2 proposed this follow-up; `docs/BUGS.md`
carries the row it closes.

---

## 1. The shape

### 1.1 What a back edge looks like in the emitted tree

`26-infinite-generator-take`'s `naturals` (source `while (true) { yield n++; }`),
v94, `--passes=none`, step closure only:

```js
  L0: {
    L1: {
      switch (__state) {
        case 0: break L1; break;
        case 1:
          r1 = __sent; r2 = __isReturn;
          if (__isThrow) { throw __sent; }
          if (!r2) { break L0; } else { __done = true; return [r1, __done]; }
          break;
        default: break L1; break;
      }
    }
    r3 = 1;
    r0 = __sent; r1 = __isReturn;
    if (__isThrow) { throw __sent; }
    if (r1) { __done = true; return [r0, __done]; } else { break L0; }
  }
  r1 = typeof r3 === "bigint" ? r3 : +r3;
  r3 = typeof r1 === "bigint" ? r1 + 1n : +r1 + 1;
  __state = 1;
  return [r1, __done];
```

The structurer lays the step closure out as a chain of nested labelled blocks.
`break Lj` means exactly "jump to the first statement AFTER `Lj: { ... }`", so
the *segments* of the suspend graph are the label **tails**, and the *edges*
are the labelled `break`s. Here the tail of `L0` ends in `__state = 1`, arm 1's
continuation is `break L0`, and `break L0` from inside the arm lands at the head
of `L0`'s tail -- the back edge, i.e. the source's `while (true)`.

`23-generator-basic`'s `counter` (`for (let i = 0; i < max; i++) yield i * i;`)
is the same with one more label: the back edge is `break L1` out of the arm and
`break L0` is the loop exit.

### 1.2 The three things only the cyclic form does

Threading an arm into a suspend site that sits in a label tail is legal exactly
when nothing but `labeled:` nesting differs (section 3). Three further
differences from spec 25 section 1.1's acyclic output are measured here and are
what `RecoverOptions.loops` admits:

1. **The forced-return test is inverted.** `if (!<retReg>) { <continues> }
   else { <forced return> }`, because the continuation is a `break` and Hermes
   emits the fallthrough arm first. Same two arms, named by the test.
2. **A pure entry lead ahead of the first `ResumeGenerator`.** `r3 = 1` above,
   `r3 = a1` in `counter`. It runs before the first resume can throw. It is a
   pure write to a register, so a `.throw()` arriving before the generator has
   started -- where a native `function*` runs no body at all -- cannot observe
   it, and it is left where it is.
3. **A pure phi copy between the throw check and the forced-return test**
   (`r3 = r5` in `naturals` at v84/v96; the loop's register copy). Same
   argument: pure register write, dead once the generator completes, so a
   native `.return(v)` skipping it is unobservable. It is carried over verbatim
   and lands immediately after the recovered `yield`, exactly where it was.

Each is admitted only under `loops: true`; `yield-recovery`'s acyclic behaviour
is bit-for-bit what it was (`tests/gate/passes/yield-recovery.test.ts` runs with
`skip: ["yield-loop"]`, PUSHBACK P-47).

---

## 2. The protocol claim

Unchanged from spec 25 section 1.2 and restated because the loop does not weaken
it: `__hbc_makeGenerator`'s `resume(sent, isReturn, isThrow)` is called by
`next(v)` as `(v,false,false)`, by `return(v)` as `(v,true,false)` and by
`throw(e)` as `(e,false,true)`, which is exactly what a native `function*` does
at a `yield`. The rewrite claims only that, plus the two purity arguments of
section 1.2 items 2 and 3.

R-Y4 (`forced-return-body`) still holds: a forced-return arm that is not the
empty completion is refused, so no `finally` copy is ever dropped.

---

## 3. `restructureSegments` (spec 25's F25-4), and the rung

`src/passes/restructure.ts`. Segments are the label tails; edges are the
labelled `break`s.

* A `break L` still inside `L: { ... }` is a **forward** edge and is already
  correct JavaScript; nothing is done to it.
* A `break L` that the threading has moved OUT of `L: { ... }` is a **back**
  edge to the head of `L`'s tail. It is realised by wrapping that tail in
  `L: while (true) { <tail>, break; }` and spelling the edge `continue L`.

Sound by construction: the only nodes introduced are a `while (true)` around a
suffix of a statement list and a trailing `break` (which reproduces falling off
the end of the tail); the only nodes rewritten are `break`s that had no binder
at all. Every other edge keeps the program point it already targeted, because
the labelled block and its tail both stay exactly where they were. The two
sibling statements `L: { ... }` and `L: while (true) { ... }` are legal
JavaScript: label scopes do not overlap, and `parses()` checks it.

The threading guard spec 25 used -- "the suspend site's path key must equal the
dispatcher's" -- becomes, under `loops: true`, "the two keys must be equal once
`labeled:` segments are removed". A difference in `try-block`/`try-handler`,
`loop:`, `case:` or `if-then`/`if-else` segments would move code into or out of
a handler's reach or rebind a bare `break`/`continue`, and is refused exactly as
before.

The rung (`src/passes/yield-recovery/loop.ts`) shares spec 25's site rule, writer and
generator-shape checker through `makeMatch`/`makeCheck`; only
`RecoverOptions.loops` differs, so the two rungs cannot drift apart.
Registration: `after: [expr-rebuild, global-access, call-shape, yield-recovery]`,
`before: [async-recovery, fn-naming, reg-split, var-naming]` (D23's
structure-recovery block: the rung reads register identity and moves whole
statement lists between functions).

---

## 4. Refusals

Every R-Y0..R-Y9 of spec 25 section 4 still applies. The cyclic form adds:

* **R-YL1 `loop-shape`** -- `restructureSegments` could not close a back edge.
* **R-YL2 `loop-shape`** -- a `break L` still has no binder after
  restructuring: the back edge spans more than its own label's tail (an
  irreducible or multi-tail loop). Never approximated.
* **R-YL3 `loop-shape`** -- a `continue L` escaped its own labelled block. Only
  a `break` back edge is a loop.
* **R-YL4 `region-mismatch` / `cyclic-dispatch`** -- the suspend site and the
  arm differ in more than `labeled:` nesting (section 3).
* **R-YL5 `shim-shape`** -- the entry lead or the phi interlude of section 1.2
  is not pure, or writes something other than a register.

Refusals that keep a real fixture out today, measured (section 6):
`26-infinite-generator-take`'s `fibonacci` is R-Y9 `sent-value-aliased` (the
destructuring `[a, b] = [b, a + b]` reads the forced-return register before
redefining it); `24-generator-return-throw` stays R-Y4; `25-generator-delegation`'s
`outer`/`delegatesToArray` stay R-Y6.

---

## 5. Acceptance tests

`tests/gate/passes/yield-loop.test.ts`. Rung-owned properties only -- counts,
shapes and regexes over the two functions this rung owns, plus unit properties
of `restructureSegments`; never a whole-output comparison against a shared
fixture (CLAUDE.md testing rules).

1. `23-generator-basic`'s `counter` and `26-infinite-generator-take`'s
   `naturals` are `function*` with a loop containing a `yield`, at v84, v94 and
   v96, and only with the rung enabled.
2. No protocol residue (`__state`, `__done`, `__sent`, `__isReturn`,
   `__isThrow`, `__this`, `__args`) in either recovered function.
3. The rung is inert at v98/v99 (`gen-lowered`'s window) and inert on the
   acyclic fixtures `yield-recovery` already owns.
4. Refusals surface as `W_PASS_REFUSED`, never silently.
5. `restructureSegments` unit properties: identity when nothing escapes; one
   loop per back edge; R-YL2 and R-YL3 refusals.
6. The behavioural obligation is `tests/gate/decompile/equivalence.test.ts`
   (T2): the recovered generators' `next`/`return`/`throw` sequences are run
   against the Hermes VM trace, and fixture 26 exercises the `.return()` path
   through `for (const v of ...) { ... break; }`.

---

## 6. Measured (2026-09-05, branch `agent/yield-backedge`)

| fixture | v84 | v94 | v96 | v98/v99 |
|---|---|---|---|---|
| `23-generator-basic` | `sequence` + `counter` | same | same | rung inert (row 18) |
| `26-infinite-generator-take` | `naturals`; `fibonacci` R-Y9 | same | same | rung inert |
| `25-generator-delegation` | `inner` only (R-Y6) | same | same | rung inert |
| `24-generator-return-throw` | none (R-Y4) | same | same | rung inert |

`tests/fixtures/bundles/rn-template-0.72/index.android.hbc` (v94): 7 generator
sites, 1 recovered by `yield-recovery`, **0 further recovered by `yield-loop`**.
The 6 that stay are not back-edge refusals -- across the whole bundle
`yield-loop`'s counted reasons are `shim-shape` (458, almost all of them
ordinary non-generator function statements), `sent-value-aliased` (1) and
`cyclic-dispatch` (1, i.e. one genuine R-YL4). The back-edge capability
therefore closes the two construct fixtures and one real site's worth of
residue; the rest of that bundle's residue belongs to R-Y4/R-Y6/R-Y9, which
have their own `docs/BUGS.md` rows.

---

## 7. Open

1. **R-Y9 on a destructuring loop body** (`fibonacci`). The forced-return
   register is genuinely read before it is redefined, so the refusal is
   correct as stated; whether the read is *provably* dead is a separate
   analysis. `docs/BUGS.md` row.
2. **Golden hash.** The pinned rn-template hash in
   `tests/gate/passes/pipeline-speed.test.ts` does not move (0 further sites
   recovered on that bundle), but any golden that covers fixtures 23 or 26 at
   v84/v94/v96 does. Regeneration is the orchestrator's batch, never this
   rung's.
3. **Fixture 81** (`while` with two yields and a conditional break) was
   reserved and not built: both shapes the rung closes are already carried by
   shared fixtures 23 and 26 at three versions each, and the rung makes no
   exact-output assertion that would need a private fixture. Worth queuing to
   pin a two-suspend loop.
