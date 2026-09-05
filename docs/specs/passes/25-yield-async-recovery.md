# 25 — `yield-recovery` + `async-recovery` (both stage B)

**Catalogue rows:** 17 ([generators.md](../../lowering/generators.md), v<=96
opcode-driven coroutine) and 19 ([async-await.md](../../lowering/async-await.md),
generator + builtin spawn driver).
**Fixtures:** `23-generator-basic`, `24-generator-return-throw`,
`25-generator-delegation`, `26-infinite-generator-take` (row 17);
`27-async-await-basic`, `28-async-await-error` (row 19).
**Ladder rows:** `00-LADDER.md` §1.1 `yield-recovery` and `async-recovery`
(batch 4).
**Versions:** `yield-recovery` **84, 94, 96** (the `StartGenerator` era; the
idiom does not exist at >=97). `async-recovery` **84, 94, 96, 98, 99** — the
spawn-driver wrapper has one shape at all five versions (§1.6), but at >=97 the
generator it wraps is still `__hbc_makeGeneratorLowered`, so the rung takes
refusal **R-A4** there until `gen-lowered` (catalogue 18, hard, §5.2) lands.
Registering it now is therefore safe and is the point of the split.
**Stage:** **B** for both, not stage A as `00-LADDER.md` §1.1/§2/§3.1 say.
This is the spec's largest finding; the evidence is §1.0 and the pushback is
**P-24**.
**Ownership:** §3 — one *generator group* per enclosing function body: the
`__hbc_makeGenerator(factory, this, arguments)` call statement, the `factory`
`func` declaration it names, the `sameFrame` step closure that factory returns,
and (for `async-recovery`) the `__hbc_b_spawnAsync(factory, thisArg, args)`
wrapper around it. Neither rung owns any other statement, any `try` region it
did not find whole inside the step closure, or anything at all in a function
with no generator group.

`gen-lowered` (row 18, v>=97) is **not** in this spec. §1.7 states the boundary
and what `async-recovery` must do until it exists.

---

## 1. Idiom evidence (measured 2026-09-05, this worktree, base `1e1fe39`)

Method: `node src/cli.ts decompile [--force-v98-table] tests/fixtures/constructs/<F>/v<NN>.hbc`
and `node src/cli.ts disasm ...`, run for fixtures 23-28 at **all five**
committed versions (84, 94, 96, 98, 99 — every fixture has all five). Every
block quoted is real current output, not an illustration.

### 1.0 Both rungs are stage B, not stage A (PUSHBACK P-24)

`00-LADDER.md` §1.1 lists `yield-recovery` and `gen-lowered` in the stage-A
table, §2 says "generator rungs first in stage A", and §3.1 gives them the
stage-A ownership row `switch` with `generator-state`/`dispatch` scrutinee,
`setState`, `return`. Three measured facts say the rung cannot live there:

1. **The anchor of the idiom does not exist in stage A.** The `switch` and
   `setState` nodes do exist in the tree IR (`src/structure/ir.ts`: `Scrutinee`
   has a `{ t: "generator-state" }` variant and `setState` is a node). But the
   things that identify the site and that the rewrite must *delete* —
   `__hbc_makeGenerator(...)`, the `(__sent, __isReturn, __isThrow)` step
   closure, the `[value, __done]` tuple protocol, `let __state = 0` — are all
   produced by `src/emit/lower.ts` (`case "CreateGeneratorClosure"` /
   `"CreateAsyncClosure"`, `case "SaveGenerator"`, `case "ResumeGenerator"`)
   and by `src/emit/function.ts`. A stage-A matcher sees a dispatcher `switch`
   and cannot tell it from any other; it cannot see, remove or replace the
   shim.
2. **The rewrite is cross-function and stage A has no cross-function view.**
   At v<=96 one source `function*` becomes **three** emitted functions: the
   outer stub (`function sequence() { r0 = __hbc_makeGenerator(_fn2, this,
   arguments); return r0; }`), the factory `_fn2`, and the step closure. For
   `async` it is **four** (§1.6). The recovery collapses them into one
   `async function*`/`function*`. `PassContext` gives stage A one
   `StructuredFunction` per bytecode function and no parent (`src/passes/types.ts`:
   `structured`/`parentOf` are per-tree); stage B gets `fnBody` and sees nested
   functions as ordinary `k:"func"` statements of the parent's list, which is
   exactly the shape the group has.
3. **The emitter already models the step closure as a stage-B AST node with a
   dedicated flag.** `src/emit/ast.ts`'s `func.sameFrame?: true` exists solely
   for "the generator/async resume-dispatcher closure `emit/function.ts`
   returns from an `isOpcodeGeneratorBody` function", and its comment states
   that this closure is *not* a second Hermes frame but "the same frame's state
   machine re-entered on every resume". That is a machine-checkable marker of
   the exact node the matcher needs, available only in stage B.

Consequences, all recorded in P-24: §1.1's row moves to the stage-B table;
§3.1's ownership row is deleted and replaced by a stage-B ownership entry;
§2's "generator rungs first in stage A" rationale is void — see §2 for what
replaces it and why nothing else breaks; §4.3's `check` taxonomy lists
`yield/gen` under CF-preserving (stage A), which neither rung can use, so §3.4
specifies a *generator-shape* checker, exactly as spec 24 §3.4 did for
`class-recover` (P-23).

### 1.1 The v<=96 shape (`23-generator-basic`, v94, default pipeline)

```js
    function sequence() {
      // fn#1 "sequence"
      let r0;
      function _fn2() {
        // fn#2 "?anon_0_sequence"
        var __this = this;
        var __args = arguments;
        let r0, r1, r2, r3, r4, r5;
        let __state = 0;
        let __done = false;
        return function (__sent, __isReturn, __isThrow) {
  L0: {
    switch (__state) {
      case 0:
        break L0;
        break;
      case 1:
        r1 = __sent;
        r2 = __isReturn;
        if (__isThrow) {
          throw __sent;
        }
        if (r2) {
          __done = true;
          return [r1, __done];
        } else {
          r2 = "b";
          __state = 2;
          return [r2, __done];
        }
        break;
      ...
      default:
        break L0;
        break;
    }
  }
  r0 = __sent;
  r1 = __isReturn;
  if (__isThrow) {
    throw __sent;
  }
  if (r1) {
    __done = true;
    return [r0, __done];
  } else {
    r1 = "a";
    __state = 1;
    return [r1, __done];
  }
};
      }
      r0 = __hbc_makeGenerator(_fn2, this, arguments);
      return r0;
    }
```

The **entry segment** is the code *after* the `switch` (reached by
`case 0: break L0`), and the resume segments are the `case k` arms — the
printed form of spec 03 §4.5's synthetic `B_dispatch` block.

The output is idiom-identical at v84, v94 and v96. Diffing
`23-generator-basic` v94 against v96 (headers stripped) gives two lines, both
the ordinary "v96 materialises a comparison into a register" difference
(`if (!(r2 < r3))` vs `r1 = r2 < r3; if (!r1)`); `27-async-await-basic` v84 vs
v94 differs only by v84's `__hbc_empty` TDZ guards. No generator-specific
difference exists across 84/94/96, so **one matcher covers all three**.

### 1.2 The protocol, stated exactly (this is what the rewrite claims)

Per generator group, from the fixtures above and `docs/lowering/generators.md`
§2 (which this spec re-read at the bytecode level and agrees with):

* **Suspend** is exactly `__state = k; return [<value>, __done];` with
  `__done` still `false`. It is emitted from `SaveGenerator` + `Ret`.
* **Resume** is exactly the arm prologue
  `<sentReg> = __sent; <retReg> = __isReturn; if (__isThrow) { throw __sent; }
  if (<retReg>) { <forced-return tail> } else { <continues here> }`, emitted
  from `ResumeGenerator` + `JmpTrue`.
* **Completion** is `__done = true; return [<value>, __done];`
  (`CompleteGenerator` + `Ret`).
* **`__state = k` and `case k:` are 1:1.** Each `SaveGenerator` instruction has
  exactly one resume point, so each state value is written at exactly one
  suspend site and read by exactly one arm. The matcher must *verify* this
  (R-Y3) rather than assume it, because a `.min`/`.obf` build or a future
  compiler could share a state.
* The three helper arguments are the generator resume protocol verbatim:
  `__hbc_makeGenerator`'s `resume(sent, isReturn, isThrow)` is called from
  `next(v)` as `(v,false,false)`, `return(v)` as `(v,true,false)`, `throw(e)`
  as `(e,false,true)`. A native `function*` implements the same three
  behaviours at a `yield` expression natively. **That equivalence is the whole
  soundness argument of `yield-recovery`**, and §3.4's checker states it.

Measured per-fixture at v94 (`switch (__state)` dispatchers / suspend sites):
23 → 2/5, 24 → 2/6, 25 → 3/17, 26 → 2/2, 27 → 1/3, 28 → 2/2.

### 1.3 Forced-return arms are not always empty — the `finally` hazard

In 23, 26, 27 and 28 every forced-return arm is exactly
`__done = true; return [<sentReg>, __done];`, which a native `.return(v)`
reproduces. In **`24-generator-return-throw`'s `g1`** it is not:

```js
          if (r2) {
            __pc = 10;
            r2 = globalThis;
            ...
            r2 = "g1 finally ran (return() triggered it)";
            r2 = Reflect.apply(r4, r3, [r2]);
            __done = true;
            return [r1, __done];
          } else {
```

That is the source's `finally` body, duplicated by Hermes into every
suspend point's forced-return tail: the literal `g1 finally ran (return()
triggered it)` appears **5** times in the v84/v94/v96 output and exactly once
at v98/v99, where the lowered form keeps a single copy. A native
`function*` runs the `finally` on `.return()` **via the `try`/`finally`
statement** — but `finally-dedup` (row 12, hard, §5.1) has not run and there
is no `finalizer` node yet; the emitted form is a `try`/`catch`-rethrow with
`__pc` range guards, which does **not** run on a return completion. Deleting a
non-empty forced-return arm would therefore silently drop the `finally`.

**Rule:** `yield-recovery` refuses a group in which any forced-return arm is
not the empty form (**R-Y4**). Fixture 24's `g1` refuses today and becomes
recoverable only after `finally-dedup`. This is stated rather than worked
around: it is a semantic gap, not a readability one.

### 1.4 Cyclic dispatchers — a loop must be rebuilt, and that is a hard rung

`26-infinite-generator-take` at v94, whole step closure:

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
    ... if (r1) { __done = true; return [r0, __done]; } else { break L0; }
  }
  r1 = typeof r3 === "bigint" ? r3 : +r3;
  r3 = typeof r1 === "bigint" ? r1 + 1n : +r1 + 1;
  __state = 1;
  return [r1, __done];
```

Threading it: entry → tail (suspend 1) → arm 1 → tail again. The recovered
control flow has a **back edge**, i.e. the source's `while (true) { yield i++; }`.
The same is true of `23-generator-basic`'s `counter` (`for` loop with a yield)
and of every arm of `25-generator-delegation`. Rebuilding that loop from
labelled-break segments is a structuring algorithm, not a matcher — the exact
criterion `00-LADDER.md` §5 uses for a **hard** rung, and the same capability
`gen-lowered` needs for its `__pc` state machine.

**Rule:** this spec ships the **acyclic** form only. The rung computes the
*suspend graph* (nodes = entry segment + one per arm; edges = "suspend site k
is reachable from this segment") and refuses when it is not a DAG
(**R-Y5** `cyclic-dispatch`). Recoverable today: `23`'s `sequence`, `24`'s
`g2` (subject to R-Y4), `27`, `28`. Refused today: `23`'s `counter`, `25`, `26`.
§6.2 proposes the follow-up (`yield-loop`, sharing a `restructureSegments`
framework service with `gen-lowered`) and asks Fred to rule on the scope.

A rejected alternative is recorded so the follow-up does not re-derive it:
keeping the dispatcher and emitting
`function* g(){ let s=0,sent; while(true) switch(s){ ... sent = yield v; s=k; continue; ...} }`
is a pure tree rewrite and is *correct*, but (a) it is barely more readable
than the shim, (b) `continue` out of a `try` re-enters the try, which changes
which `__pc` guard is live for fixtures 24/28 whose dispatcher sits **inside**
the try, and (c) it would leave the `__hbc_makeGenerator*` residue metric
(`00-LADDER.md` §6) satisfied by output nobody wants. Not specced.

### 1.5 `yield*` delegation (`25-generator-delegation`) — refusal, with the reason

The emitter lowers delegation through a **module-level mutable flag**:

```js
  var __hbc_delegated = false;
  ...
  function __hbc_b_generatorSetDelegated() { __hbc_delegated = true; return undefined; }
```

which `__hbc_makeGenerator`'s `resume` reads *after* the step returns
(`if (__hbc_delegated) return r[0];` — the inner iterator's own result object
is passed through unwrapped). Fixture 25 at v94 has 13 `__hbc_b_generatorSetDelegated()`
calls across 3 dispatchers and 17 suspend sites. Recovering `yield*` means
proving that a whole iterator-driving loop plus its flag writes is one
delegation — and every one of them is cyclic (§1.4) as well. **R-Y6**
`delegated-yield`: refuse any group containing a `__hbc_b_generatorSetDelegated`
call. Fixture 25 is refused in full, at every version.

### 1.6 The async wrapper — one shape at all five versions

`27-async-await-basic` v94 (`sequence`, the visible `async function`):

```js
      r4 = undefined;
      r0 = undefined;
      r0_2 = __hbc_arguments(arguments);
      r3 = r0_2;
      r2 = __hbc_b_spawnAsync;
      r1 = _fn3;
      r0_3 = this === null || this === undefined ? globalThis : Object(this);
      r0_4 = r2(r1, r0_3, r3);
      return r0_4;
```

and v99, same fixture, same function:

```js
      r4 = __hbc_arguments(arguments);
      r3 = __hbc_b_spawnAsync;
      r2 = _fn4;
      r1 = this === null || this === undefined ? globalThis : Object(this);
      r1_2 = r3(r2, r1, r4);
      return r1_2;
```

`_fn3`/`_fn4` is the generator factory: at v<=96 its body is
`r0 = __hbc_makeGenerator(_fn4, this, arguments); return r0;` (so async is
**four** functions: stub, factory, inner factory, step closure); at v>=97 it is
`return __hbc_makeGeneratorLowered(_fn5);`.

**The 94-vs-98/99 driver difference asked about in the brief does not exist in
today's output.** `docs/lowering/async-await.md` §3/§6 record `#57 spawnAsync`
at v98 and `#58 makeAsyncIterator` at v99 (T13). Re-measured here on the
committed fixtures with the current tables:

```
v99:  0009  GetBuiltinClosure    r3, b58 "spawnAsync"
v98:  0009  GetBuiltinClosure    r3, b57 "spawnAsync"
```

and the decompiled output names `__hbc_b_spawnAsync` at 84, 94, 96, 98 **and**
99. The lowering doc's reading predates the `patchHbc99Mar2026Builtins` shift
recorded in `src/tables/generated/PROVENANCE.md` (builtin 55 `setFunctionName`
moves `spawnAsync`/`makeAsyncIterator` to 56-60); the table is right and the
doc is stale. PUSHBACK **P-25**. The matcher must still resolve **by helper
name**, and must accept `__hbc_b_makeAsyncIterator` as well, because
`src/runtime/helpers.ts:477` defines it as an alias of `__hbc_b_spawnAsync`
and a different compiler build can still emit it.

`28-async-await-error` shows the `await`-in-`try` path: the dispatcher sits
*inside* the emitted `try`, each arm and its suspend site are inside the **same**
`try`, and the `catch` is the source's `catch (e)`. Inlining an arm at its
suspend site therefore never crosses a region boundary — but the matcher must
check it (**R-Y7**) rather than rely on it.

### 1.7 v>=97 is `gen-lowered`'s, not this spec's

At v98/v99 a generator decompiles to `__hbc_makeGeneratorLowered(<body>)` where
`<body>` is a plain function reading `arguments[0]`/`arguments[1]` as the
action/value pair, with the status and resume-index env slots
(`_e1_2`, `_e1_1` in `23-generator-basic` v99) and the
`__hbc_b_throwTypeError("Generator functions may not be called on executing
generators")` trap, inside a `__pc` machine and nested `try`s. There is no
`__state`, no `[value, __done]` tuple and no `sameFrame` closure, so
`yield-recovery`'s matcher cannot fire and its `versions` predicate excludes
>=97 outright (**R-Y0** never even runs there). `async-recovery` *does* still
match the spawn wrapper at 98/99 (§1.6) and must refuse with **R-A4**
`inner-not-recovered` until `gen-lowered` has turned the inner body into a
`function*`. That refusal is the whole reason `async-recovery` can be
registered before `gen-lowered` exists.

### 1.8 Corpus reach, and the golden hash

The committed `tests/fixtures/bundles/rn-template-0.72/index.android.hbc` is
**v94** and **does contain the v<=96 generator idiom**: 7 `__hbc_makeGenerator(...)`
call sites, 7 `let __state = 0` factories, 6 `switch (__state)` dispatchers and
6 suspend sites (so one generator has no `yield` at all). It contains **no**
`__hbc_makeGeneratorLowered` and **no** `__hbc_b_spawnAsync`.

Therefore, unlike spec 24's rung: **`yield-recovery` will move the pinned
rn-template output hash** in `tests/gate/passes/pipeline-speed.test.ts`
(currently `fa54d8f2...`) as soon as it rewrites any of those 7 sites, and
`async-recovery` will not move it at all. §6.1 is the Needs-Fred item; the
implementer must not touch that file.

---

## 2. Pass placement

```
yield-recovery: { stage: "B", catalogue: [17],
                  after:  ["expr-rebuild", "global-access", "call-shape"],
                  before: ["fn-naming", "reg-split", "var-naming"],
                  versions: (v) => v <= 96 }

async-recovery: { stage: "B", catalogue: [19],
                  after:  ["expr-rebuild", "global-access", "call-shape", "yield-recovery"],
                  before: ["fn-naming", "reg-split", "var-naming"],
                  versions: () => true }
```

* **`after: ["yield-recovery"]`** is the ladder row's own dependency
  (`after: [yield-recovery, gen-lowered]`), minus `gen-lowered`, which cannot
  be named until it exists — `enabledPasses` throws `E_PASS_ORDER` for an
  unknown dependency, the same constraint spec 22 §7 recorded for `try-shape`'s
  `after: ["finally-dedup"]`. The landing commit for `gen-lowered` adds it.
* **Structure-recovery block, before renaming (D23).** Both rungs read register
  identity (the `<sentReg>`/`<retReg>` of each arm prologue, the `__state`
  values, the factory/step closure names) and both *move* whole statement
  lists between functions. `reg-split`'s per-store renaming across that move is
  exactly the corruption D23 exists to prevent (`docs/BUGS.md` P-11b).
* **`after: ["call-shape"]`** so the driver call arrives as `r2(r1, r0_3, r3)`
  and the yielded values as ordinary calls rather than `Reflect.apply` shapes.
  `after: ["expr-rebuild"]` is the PL-11 injection every stage-B rung gets;
  it is what turns `__state = k; return [r2, __done];` into a two-statement
  shape the matcher can read without a def-use walk.
* **What replaces §2's "generator rungs first in stage A" rationale.** That
  line existed so later stage-A matchers would not see the dispatcher as
  ordinary control flow. Re-checked against the shipped rungs: `loop-cond` and
  `for-header` key on `loop` nodes and the dispatcher is not one; `for-in`/
  `for-of` key on `GetPNameList`/`IteratorBegin`; `switch-raise` (S1) claims
  only `{ t: "jumptable" }` scrutinees, and the dispatcher's scrutinee is
  `{ t: "generator-state" }`, a different variant. **`switch-raise` S2**
  (compare-chain, blocked on F13) is the one real hazard, and it is a hazard
  for `gen-lowered`, not for this spec: the v>=97 dispatch chain *is* an
  ordinary `JStrictEqual` chain (`generators.md` §4 says so). S2's spec must
  exclude a chain gated behind the two reserved env slots; that is recorded
  here and in P-24 so it is not lost when §2's line is rewritten.

### Framework changes

* **F25-1** (`src/emit/ast.ts` + `src/emit/print.ts`): there is **no generator,
  `async` or `yield`/`await` node in the AST today — `k:"func"` carries only
  `name`/`params`/`body`/`sameFrame`, and `grep 'k: "' src/emit/ast.ts` has no
  `yield` or `await`. Add
  ```ts
  // on the existing func node:
  readonly generator?: true;
  readonly async?: true;
  // new Expr variants:
  | { readonly k: "yield"; readonly arg: Expr | null; readonly delegate: boolean }
  | { readonly k: "await"; readonly arg: Expr }
  ```
  Printer obligations: `function* name(...)`, `async function name(...)`,
  `async function*` for the combination; `yield`/`await` bind looser than
  every operator, so an argument that is not a primary expression is
  parenthesised and a `yield` in an argument position is parenthesised;
  `yield` with a `null` arg prints `yield`. `isPure` must return `false` for
  both nodes; `effectSequence` (`src/passes/ast.ts` §4.2) must emit an effect
  for each, because a `yield`/`await` is an observable suspension and may
  never be reordered past anything.
* **F25-2** (`src/emit/lower.ts` + a new `Origin` variant): provenance for the
  generator opcodes, so neither matcher is a shape heuristic over
  `switch (__state)`. Per group record
  `{ kind: "generator" | "async", stubFnIdx, factoryFnIdx, bodyFnIdx,
     suspends: [{ state, offset }], resumes: [{ state, offset }] }` from
  `CreateGeneratorClosure`/`CreateAsyncClosure`/`SaveGenerator`/`ResumeGenerator`
  and mark the emitted statements with it. Without it, the 1:1 invariant of
  §1.2 and the "which arm belongs to which suspend" map are re-derived from
  printed integers, which the `.obf` variants can defeat.
* **F25-3** (`src/passes/types.ts`): stage B needs to see the *enclosing*
  function of the current body to rewrite a group whose stub is one level up.
  `fnBody` is the current body only. Add
  `PassContext.enclosingFn?: { readonly body: readonly AstStmt[]; readonly index: number }`
  or, equivalently, run the two rungs at the parent list where the whole group
  is already visible — the latter is preferred and needs no framework change,
  because §3.1's site *is* the parent list. F25-3 is therefore recorded as
  **not required**, and the spec's site definition is written to avoid it.
* **F25-4** (not in this batch): `restructureSegments(segments, edges)` — turn a
  set of statement-list segments plus a reducible edge relation into
  loops/`if`s. Needed by `yield-recovery`'s cyclic form (§1.4, R-Y5) and by
  `gen-lowered` (§5.2's "re-threading straight-line code across arms"). Should
  be specced once, for both.
* **F25-5** (`src/emit/function.ts`): the shim closure is emitted with
  `var __this = this; var __args = arguments;` in the factory, and the group's
  stub passes `this`/`arguments` into `__hbc_makeGenerator`. When the rung
  collapses the group, those bindings must be dropped and any `__this`/`__args`
  read inside the body rewritten to `this`/`arguments` — legal only because the
  recovered `function*` is the *same* function the stub was. If any read
  survives, the rung refuses (**R-Y8**); the alternative (leaving `__this` bound
  in a `function*`) would be wrong for `arguments`.

---

## 3. Ownership, writer, checker

### 3.1 Site

`match(list, ctx)` returns `null` unless `list === ctx.fnBody` (F1). One site
per **generator group** in that body. For `yield-recovery` the group is, in
statement order:

1. a `k:"func"` statement `F` (the factory) whose body is exactly
   `let __state = 0; let __done = false; return <step>;` where `<step>` is a
   `k:"func"` expression with `sameFrame === true` and parameters
   `(__sent, __isReturn, __isThrow)`, marked by F25-2 as a generator body;
2. the statement in the *enclosing* stub whose value is
   `__hbc_makeGenerator(F, this, arguments)`, and the `return` of that value.

Because (1) is a declaration *inside* the stub's body and (2) is a statement of
the same body, the site is one statement list — the stub's — and no framework
change is needed (F25-3).

For `async-recovery` the group additionally contains the spawn wrapper: a body
whose statements are (modulo pure register moves) `args = __hbc_arguments(arguments);`,
a read of `__hbc_b_spawnAsync`/`__hbc_b_makeAsyncIterator`, a read of the
factory `F`, the `this === null || this === undefined ? globalThis : Object(this)`
coercion, the driver call `d(F, t, args)` and its `return`.

`Match.data` carries: the group kind, the suspend/resume map from F25-2, the
per-arm `<sentReg>`/`<retReg>` pair, the entry segment, the topological order
of the suspend graph, and the exact statement indices to delete.

### 3.2 Owns

The statements enumerated in §3.1 and nothing else. In particular neither rung
owns: any `try` node it did not find wholly inside the step closure; any
statement of the step closure that is not an arm prologue, a suspend site or a
completion; any other function in the body; any `__hbc_*` helper *definition*
(the helper text is emitted on demand by `src/runtime/helpers.ts` and simply
stops being referenced).

### 3.3 Writer

`yield-recovery` replaces the group with a single `k:"func"` statement at the
stub's position, carrying `generator: true`, the stub's name and parameters,
and a body built by threading the segments in the suspend graph's topological
order:

* the entry segment first, with its arm prologue and forced-return branch
  removed;
* each suspend site `__state = k; return [v, __done];` replaced by the arm's
  continuation, prefixed with `<sentReg> = yield v;` (or, when `<sentReg>` is
  dead, the expression statement `yield v;`);
* each completion `__done = true; return [v, __done];` replaced by `return v;`
  (`return;` when `v` is `undefined`);
* the `switch (__state)` dispatcher, `__state`, `__done`, `__this`, `__args`
  and the `if (__isThrow) throw __sent;` / `if (<retReg>) {…}` prologues
  deleted.

Every surviving sub-expression is carried over `===`-identical, never rebuilt,
so the checker can compare by identity.

`async-recovery` replaces its group with the recovered `function*`'s body under
`async: true, generator: undefined`, rewriting every `k:"yield"` the previous
rung produced *in that body only* into `k:"await"`. It never invents a `yield`
and never touches a `yield` it did not just receive from `yield-recovery`
(tracked through `Match.data`, not by walking for `yield` nodes).

### 3.4 Checker — generator-shape (new; see §6.3)

Neither rung can use `00-LADDER.md` §4.3's CF-preserving obligation (stage A
only, and both rungs *change* control flow by design) nor the expression-only
one (both delete call effects: `__hbc_makeGenerator`, the driver call). The
obligation is:

1. **Undo.** Rebuild the deleted group from `after` alone — the recovered
   function carries every segment, every yielded value and the suspend order —
   and require the result to deep-equal `before`. Any edit outside the declared
   group fails here.
2. **Segment conservation.** The multiset of statements of `after`'s body must
   equal the multiset of `before`'s entry segment plus every arm's
   continuation, minus exactly the declared deletions (dispatcher, prologues,
   forced-return arms, `__state`/`__done` bookkeeping) — and nothing else. No
   statement may be duplicated: the 1:1 invariant of §1.2 is what makes this
   an equality rather than an inequality, and violating it is R-Y3.
3. **Suspension order.** The sequence of `yield`/`await` argument expressions
   in `after`, read in program order along every path, must equal the sequence
   of suspend-site values in `before` along the corresponding path. This is the
   check that catches a mis-threaded arm.
4. **Region membership.** For every arm inlined at a suspend site, the set of
   enclosing `try` nodes of the suspend site in `before` equals that of the arm
   in `before` (R-Y7), and equals that of the inlined code in `after`.
5. **Independent re-derivation.** Recompute the group from `before` by §3.1's
   rule and require the same statement index set; `freeNames(after)` subset of
   `freeNames(before)` plus nothing; `parses(after)`; and no
   `__state`/`__done`/`__sent`/`__isReturn`/`__isThrow`/`__this`/`__args`
   identifier survives anywhere in `after`'s recovered body.
6. **Protocol identity.** The equivalence claimed — "`__hbc_makeGenerator`'s
   `resume(sent, isReturn, isThrow)` is the native generator resume protocol"
   — is stated in `check.ts` as three named obligations (`next` sends a value
   to the yield; `throw` raises at the yield; `return` completes at the yield,
   running enclosing finalizers) and re-derived from `Match.data`, never
   assumed from the node kind. R-Y4 exists precisely because obligation three
   is not currently satisfiable when a finalizer body is duplicated into the
   arm.

---

## 4. Refusals

Each is a distinct counted `abandoned` reason.

* **R-Y0 `no-generator-site`** — no F25-2-marked group in the body; `match`
  returns `null` before reading anything else (PL-08 fixed point).
* **R-Y1 `no-provenance`** — a `switch` on an identifier named `__state`, or a
  three-parameter closure, without F25-2 provenance. A hand-written state
  machine in the source has the same shape; this is a refusal by construction.
* **R-Y2 `shim-shape`** — the factory body is not exactly §3.1(1), the step
  closure lacks `sameFrame`, or the stub's call is not
  `__hbc_makeGenerator(F, this, arguments)` with `F` the group's factory.
* **R-Y3 `state-not-injective`** — some state value is written at more than one
  suspend site, or read by more than one arm, or an arm has no writer
  (§1.2). Never guess which arm a suspend resumes into.
* **R-Y4 `forced-return-body`** — some forced-return arm is not exactly
  `__done = true; return [<sentReg>, __done];` modulo `__pc` stores (§1.3).
  Fixture `24-generator-return-throw`'s `g1`. Clears when `finally-dedup`
  lands and a real `finalizer` exists.
* **R-Y5 `cyclic-dispatch`** — the suspend graph is not a DAG (§1.4). Fixtures
  `23`'s `counter`, `25`, `26`. Clears with F25-4.
* **R-Y6 `delegated-yield`** — the group contains a
  `__hbc_b_generatorSetDelegated()` call (§1.5). Fixture `25`, all versions.
* **R-Y7 `region-mismatch`** — a suspend site and the arm it resumes into are
  not inside the same set of `try` nodes, or the arm contains only part of a
  `try`. Inlining would move code into or out of a handler's reach.
* **R-Y8 `this-args-escape`** — a `__this`/`__args` read survives the rewrite,
  or the stub passes something other than `this`/`arguments` to the shim
  (F25-5).
* **R-Y9 `sent-value-aliased`** — an arm's `<sentReg>` or `<retReg>` is read
  before the prologue assigns it, or `<retReg>` is read anywhere other than the
  forced-return test. The three protocol registers must be private to the
  prologue.
* **R-A0 `no-async-site`** — no spawn wrapper in the body.
* **R-A1 `driver-name`** — the called value is not `__hbc_b_spawnAsync` or
  `__hbc_b_makeAsyncIterator` resolved *by name* (§1.6), or the call is not
  `d(F, thisArg, args)` with exactly those three arguments in that order.
* **R-A2 `this-coercion`** — the second argument is not the
  `this === null || this === undefined ? globalThis : Object(this)` coercion
  the emitter writes, or the third is not `__hbc_arguments(arguments)`. An
  async function's `this`/`arguments` must be the stub's own.
* **R-A3 `factory-escapes`** — the factory `F` is referenced anywhere other
  than the driver call.
* **R-A4 `inner-not-recovered`** — `F` is not a `generator: true` function,
  i.e. `yield-recovery` refused it (any R-Y above) or the body is still
  `__hbc_makeGeneratorLowered(...)` at v>=97 (§1.7). This is the refusal that
  makes registering the rung before `gen-lowered` safe, and it is expected to
  be the *dominant* reason in the histogram at 98/99.
* **R-A5 `yield-not-await`** — a `yield` in the recovered body is not one this
  rung's `Match.data` recorded (e.g. a source-level `async function*`, fixture
  `30-async-generator`, which has no committed `.hbc` today). Refuse the group
  rather than turn an unknown `yield` into an `await`.
* **R-A6 `driver-result-used`** — the stub does anything with the driver's
  result other than returning it.

---

## 5. Acceptance tests

`tests/gate/passes/yield-recovery.test.ts` and
`tests/gate/passes/async-recovery.test.ts`, shipped with this spec ahead of the
implementation: every test that needs a rung is `{ skip: SKIP }` and loads it
through a *non-literal* dynamic import, so the files typecheck and run green
while `src/passes/yield-recovery/` and `src/passes/async-recovery/` do not
exist. The orchestrator lifts the skips in the landing commit. Rung-owned
properties only — counts, shapes, regexes — never a whole-output comparison
against a shared fixture (CLAUDE.md testing rules, `docs/CONSOLIDATION.md`
§B item 7).

Non-skipped today, and still true after the rungs land (all are `--passes=none`
or baseline properties, so PL-05 makes them permanent):

* §1.1/§1.2's baseline shape at v84, v94 and v96 for fixtures 23-28: the
  `__hbc_makeGenerator(` call, the `(__sent, __isReturn, __isThrow)` closure,
  `let __state = 0`, `switch (__state)`, the `[v, __done]` tuple, and the
  measured dispatcher/suspend counts of §1.2;
* §1.1's cross-version claim: the generator idiom is present and identically
  shaped at 84/94/96 and absent at 98/99, where `__hbc_makeGeneratorLowered`
  appears instead (§1.7);
* §1.3's hazard: `24-generator-return-throw` has a non-empty forced-return arm
  (the `finally` body) and `23`/`26`/`27`/`28` do not — the R-Y4 evidence;
* §1.5's fact: `25-generator-delegation` contains
  `__hbc_b_generatorSetDelegated` calls — the R-Y6 evidence;
* §1.6's fact: the async driver is named `__hbc_b_spawnAsync` at **all five**
  versions, and the disassembly resolves `b57`/`b58` to `spawnAsync` at v98/v99
  — the P-25 evidence;
* §1.8's corpus fact, in the `yield-recovery` file: the rn-template bundle is
  v94 and **does** contain the generator idiom (7 sites), so this rung will
  move the pinned hash (§6.1); and, in the `async-recovery` file, that it
  contains no `__hbc_b_spawnAsync`, so that rung cannot;
* **F25-1's premise**: `src/emit/ast.ts` declares no `yield`, `await`,
  `generator` or `async` node today, and *does* declare `sameFrame` — the
  §1.0 stage-B evidence and the framework item, both real;
* the catalogue rows (17, 19) exist and are `✅ verified` (PL-06 would
  otherwise refuse registration).

Skipped until the rungs exist: registry shape and ordering (stage B,
structure-recovery block, `async-recovery` after `yield-recovery`, both before
`fn-naming`); the `versions` predicates (yield-recovery rejects 98/99, accepts
84/94/96; async-recovery accepts all five); PL-08 fixed point on a body with no
group; `23-generator-basic`'s `sequence` recovering one `function*` with four
`yield`s and zero `__state`/`__hbc_makeGenerator` residue while `counter` in
the same file is untouched (R-Y5); `24`'s `g1` refusing with R-Y4;
`25` refusing with R-Y6 at every version; `26` refusing with R-Y5;
`27`/`28` recovering `async function` with `await` and no `__hbc_b_spawnAsync`
residue; `28`'s `await` staying inside its `try` (R-Y7 satisfied, region count
unchanged); `async-recovery` refusing at v98/v99 with R-A4; and the checker
rejecting a hand-forged `after` whose yield order differs from the suspend
order.

**Metrics to report at landing**, per fixture x version x variant
(`.min`/`.obf` included): generator groups recovered vs refused, the
abandoned-reason histogram (R-Y4/R-Y5/R-Y6 are expected to dominate),
`__hbc_makeGenerator` / `__state` / `__isReturn` residue counts (the
`00-LADDER.md` §6 metric this rung owns), `yield` and `await` counts, and the
rn-template site count (7) with how many were rewritten. Acceptance bar: no
fixture loses its PASS verdict with passes on or off (PL-09); zero rewritten
sites in every fixture with no generator opcode; and every rn-template site
either rewritten *or* counted with a reason.

---

## 6. Needs Fred / open questions

1. **Golden hash regeneration — required, unlike spec 24.** §1.8: the pinned
   rn-template hash in `tests/gate/passes/pipeline-speed.test.ts`
   (`fa54d8f2...`) is a **v94** bundle with 7 generator sites, so
   `yield-recovery` moves it as soon as it rewrites one. Regeneration is
   Fred's call and is batched with the other queued goldens; the implementer
   must not touch that file, and the landing task must be sequenced after the
   approval. `async-recovery` alone cannot move it.
2. **Scope: is the cyclic form (R-Y5) a separate hard rung?** §1.4. With R-Y5
   and R-Y6 in force this rung recovers `23`'s `sequence`, `24`'s `g2` and the
   two async fixtures, and refuses `23`'s `counter`, `25` and `26` — three of
   the four fixtures the ladder row lists. Proposed: keep this spec's acyclic
   rung, and add `yield-loop` to `00-LADDER.md` §5 (hard) sharing F25-4 with
   `gen-lowered`, since both need the same "re-thread and re-structure"
   service. Needs a ruling, because it changes what "N/53 recovered" can claim
   for fixtures 25 and 26.
3. **PUSHBACK P-24 — stage.** §1.0. `00-LADDER.md` §1.1, §2 and §3.1 place
   `yield-recovery` (and `gen-lowered`) in stage A; the evidence says stage B.
   The ladder rows were updated with this id cited; §3.1's stage-A ownership
   row and §2's "generator rungs first in stage A" rationale still need
   editing, and `gen-lowered`'s §5.2 entry should be re-read in the same pass
   (its `__pc` machine is stage-B-shaped too, but that is its spec's call).
4. **PUSHBACK P-25 — the async driver name.** §1.6.
   `docs/lowering/async-await.md` §3/§6 say `makeAsyncIterator` at v99; the
   current builtin tables resolve v99's `b58` to `spawnAsync` and today's
   output uses `__hbc_b_spawnAsync` at every version. The doc is stale
   post-`patchHbc99Mar2026Builtins`. Row 19's T13 "98/99 driver protocol"
   measurement should be re-stated; not edited here beyond the catalogue row's
   spec pointer, because it is a lowering-doc correction with its own
   evidence trail.
5. **PUSHBACK P-26 — the `check` taxonomy.** `00-LADDER.md` §4.3 lists
   `yield/gen` under CF-preserving (stage A), which neither rung can use.
   §3.4 specifies a *generator-shape* checker instead; §4.3's row should be
   updated when the rungs land, exactly as spec 22 §6.1 and spec 24 §6.4
   handled the same mismatch.
6. **R-Y4 makes the batch order matter.** §1.3: `24-generator-return-throw` is
   only recoverable after `finally-dedup` (hard, §5.1) exists. If the intent is
   that fixture 24 counts as recovered in batch 4, `finally-dedup` has to land
   first; otherwise 24 ships with a counted refusal. This is a scheduling
   question, not a technical one.
7. **`30-async-generator` has no committed `.hbc`.** It is the only fixture
   that would exercise `async function*`, which is R-A5's whole reason to
   exist. Building it (`tests/fixtures/build.sh`) would let R-A5 be tested
   rather than only specified. Worth queuing; not done here, because fixture
   builds are `build.sh`'s to own.

---

## 7. Landed — 2026-09-05 (`agent/yield-impl`)

Both rungs shipped; every acceptance skip in
`tests/gate/passes/yield-recovery.test.ts` and `async-recovery.test.ts` lifted.

**Built:** F25-1 (`src/emit/ast.ts` `k:"yield"`/`k:"await"` + `generator`/
`async` on both the `Expr` and `Stmt` `func` nodes; `src/emit/print.ts`;
`walk`/`mapExpr`/`effectSequence` — a suspension is a new
`{ k: "suspend" }` effect, never reorderable), `src/passes/yield-recovery/`
and `src/passes/async-recovery/`, both registered in the structure-recovery
block (after `object-literal`, before `jsx-recover` and the renaming rungs).

**Not built, deliberately:** **F25-2**. The rung anchors on `func.sameFrame`
(the emitter's own marker, §1.0's third argument) plus the exact
`__hbc_makeGenerator(F, this, arguments)` shim shape, and *verifies* the 1:1
state map itself (R-Y3) instead of reading it from an `Origin`. `docs/BUGS.md`
carries the row; F25-2 should land with `gen-lowered`, which needs the same
map. F25-3 was already "not required"; F25-4 remains the `yield-loop`
follow-up (§6.2).

**§3.4's checker** is implemented as obligations 5 + 3 + 1 fused: the group is
re-derived from `before` by §3.1's rule alone and the result must be
structurally identical to `after`. Because the recovered body is a pure
function of the suspend order, that single equality subsumes the undo,
segment-conservation and suspension-order obligations; residue, `parses` and
`freeNames ⊆` are checked separately, and obligation 6 (protocol identity) is
stated in `check.ts`'s header, which is what R-Y4 exists to keep honest.

**R-Y5/R-Y7 share one criterion.** An arm may be inlined at a suspend site
only if the two sit inside exactly the same labels, loops, branches and `try`
regions (compared as a path key through the step closure's statement tree).
A back edge shows up as an arm whose `break L` would escape the site it is
being inlined into, which is precisely §1.4's cyclic case.

**Measured at landing (v84/v94/v96 unless noted).**

| fixture | recovered | refused |
|---|---|---|
| `23-generator-basic` | `sequence` → `function*`, 4 `yield` | `counter` (R-Y5) |
| `24-generator-return-throw` | `g2` | `g1` (R-Y4; all 5 `finally` copies survive) |
| `25-generator-delegation` | `inner` (see below) | `outer`, `delegatesToArray` (R-Y6) |
| `26-infinite-generator-take` | — | both groups (R-Y5) |
| `27-async-await-basic` | `sequence` → `async function`, 3 `await` | — at ≤96; R-A4 at 98/99 |
| `28-async-await-error` | `guarded` (await inside its original `try`, every `__pc` store the `catch` filter reads intact) and `unguarded` | — at ≤96; R-A4 at 98/99 |
| `tests/fixtures/bundles/rn-template-0.72` (v94) | 1 of 7 sites (fn#3497, 1 `yield`) | 6 (R-Y5 — every one is a loop or a `yield` inside a `try` region the arm escapes) |

**Corrections to this spec, each with a `docs/PUSHBACK.md` row.**

* **P-28** — §5's "F25-1 premise" tests assert that F25-1 has *not* been
  implemented, so they cannot survive the landing F25-1 is required for.
  Re-pointed at the landed state.
* **P-29** — §5's "identical with passes on and off (PL-05)" tests are not
  PL-05 and assert that the rungs do nothing. Re-pointed at the property they
  were reaching for: no rung *other* than these two touches the idiom.
* **P-32** — §1.4/§1.5's "fixture 25 is refused in full" is false for `inner`,
  which delegates nothing and has a two-node suspend graph. It recovers.
  §1.4/§1.5 should read "its two delegating groups are refused".
* **§1.8/§6.1 are wrong about the golden, and no regeneration is needed.**
  The pin in `tests/gate/passes/pipeline-speed.test.ts` hashes
  **`decompileTree`**, not `decompile().code`, and `decompileTree`'s rendering
  of rn-template contains **zero** `__hbc_makeGenerator` / `let __state = 0` /
  `switch (__state)` occurrences with passes on *or* off. Measured after the
  landing: the hash is still
  `fa54d8f22ba3ccf07ab00dc07d3374a1443d45ae52d7f3027e321ce5b758d7d8`. The
  *full* `decompile().code` of the same bundle does move —
  `b7756228d6649c1e4d203413df9bfdb45ed18274b8ed78c4cc761bc55f8f5caa` →
  `3418e0d48569ff120856bb8748d4902771115c34c9f9bb761376d7d6c6ffff29`, a 75-line
  unified diff touching exactly one function — but nothing pins that.

**Still open for the orchestrator.** §6.2 (`yield-loop` scope) and §6.6
(`finally-dedup` before fixture 24) are unchanged and now have `docs/BUGS.md`
rows. The per-refusal histogram §5 asks for is *not* emitted as a diagnostic:
`match` is required to be pure and the framework only counts an `abandoned`
record when `check` fails, so a refusal is currently silent. Adding a
`W_PASS_REFUSED` info diagnostic through `PassContext.diagnostic` is the
obvious follow-up and is the only part of §5's metric list not produced here.
