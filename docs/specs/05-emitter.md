# Spec 05 — Emitter: tree IR → JavaScript (M4, stage 3)

**Milestone:** M4 (baseline), third stage — the one that defines "M4 done"
**Status:** ready to implement
**Owner model:** **Opus** for `env.ts`, `calls.ts` and the generator shim;
Sonnet for literals, naming and printing (D5)
**Prerequisites:** specs 01, 02, 03, 04
**Consumers:** spec 06 (harness), spec 07 (pass ladder)

Reference: `docs/DECISIONS.md` **D9** (v97+ generators get a runtime shim first),
**D11** (baseline first, ugly allowed), **D14** (ground truth is the Hermes VM,
not Node), **D15** (three-valued equivalence);
`docs/PRIOR-ART.md` **§1.2** (the four defects we must not reproduce), **§5**
(registers → variables), **§6.1**, **§6.2**, **§6.5**, **§6.6**;
`docs/EQUIVALENCE.md` **§5.2** (Hermes ≠ Node), **§8**.

> **Ownership notice.** Do not edit `src/**`, `package.json` or
> `tests/**/*.test.ts`.

---

## 1. What M4 means

> **M4 baseline, defined:** for every gate fixture at every version it compiles
> at, `hbc2js <fixture>.hbc` emits JavaScript that (a) passes `node --check`,
> and (b) is **PASS** under the equivalence checker (spec 06) against the
> reference trace. Output may be ugly: `while(true)` with `break`, register-named
> variables, `Reflect.apply` calls, duplicated `finally` bodies, generator shims.
> **Nothing about readability is in scope for M4.** (D11)

Everything readable — real `while(c)`, `for`, `switch`, `yield`, expression
rebuilding, sensible names — is spec 07's pass ladder, each pass gated on this
baseline staying green.

---

## 2. Pipeline and API

```
StructuredFunction (spec 04)  ─┐
FunctionCfg (spec 03)          ├─►  lower()  ─►  JS AST  ─►  print()  ─►  text
HbcModule tables (spec 01)     │
EnvGraph (spec 03)            ─┘
```

```ts
// src/emit/index.ts
export function emitModule(a: ModuleAnalysis, opts?: EmitOptions): EmitResult;

export interface EmitOptions {
  /** Emit `"use strict"` per function when FunctionFlags.strictMode. Default true. */
  readonly strictDirectives?: boolean;
  /** Include `// fn#N @0x…` provenance comments. Default true; off for goldens
   *  that are compared against a recompile. */
  readonly provenanceComments?: boolean;
  /** Runtime helpers: "inline" (default, self-contained output) or "import"
   *  (emit `import {…} from "./hbc-runtime.js"`, for debugging). */
  readonly helpers?: "inline" | "import";
  /** Fail rather than emit a materialised environment object. Default true. */
  readonly strictEnv?: boolean;
  readonly indent?: string;                       // default two spaces
}

export interface EmitResult {
  readonly code: string;
  /** Helpers actually emitted, in dependency order. */
  readonly helpersUsed: readonly string[];
  /** Offset map: JS line -> (functionIndex, bytecode offset). Feeds spec 06's
   *  divergence reports and is cheap to maintain. */
  readonly lineMap: readonly LineMapEntry[];
  readonly diagnostics: readonly Diagnostic[];
}
```

The JS AST is our own minimal node set (~30 kinds), not ESTree — we emit a
narrow subset and an in-house printer avoids a dependency and gives byte-stable
output. It must be *convertible* to ESTree if spec 07 later wants a parser-based
`check`; keep the node names ESTree-compatible (`BinaryExpression`,
`CallExpression`, …) so that stays a mechanical mapping.

---

## 3. Names

Fixed, deterministic, collision-free by construction. **Never emit an identifier
that is not declared** — that is hermes-dec's defect 5 and risk R3.

| Thing | Name | Notes |
|---|---|---|
| register *n* of the current frame | `r<n>` | declared once per function: `let r0, r1, …, r<frameSize-1>;` |
| function-table entry *n* | `_fn<n>` | the top-level binding for a closure body |
| environment slot (lexical) | `_e<envNodeId>_<slot>` | declared in the *owner* function (spec 03 §6.3) |
| materialised environment | `_env<envNodeId>` | an object literal with `s<slot>` keys |
| catch binding | `_exc<regionIndex>` | the `Catch` register is also assigned to `r<n>` |
| structurer label | `L<labelId>` | from `LabelInfo` |
| irreducible dispatch variable | `__state<n>` | spec 04 §4.4 |
| debug `switch(pc)` fallback | `__dispatchPc` | **mandated** by spec 00 §8 — the licence guard greps for `_funN_ip`, hermes-dec's name, and our own must not collide |
| runtime helper | `__hbc_<name>` | §7 |
| `CreateThis` / `CreateThisForNew` / `SelectObject` | *(no identifier)* | consumed by the `new` pattern (§7.5); never lowered standalone |
| generator resume state | `__state` | written by `SaveGenerator`, read by the shim (§7.2) |
| generator shim state object | `__hbc_gen<n>` | §7 |

`functionName` from the header is used **only in a comment** (`// fn#6 "ze"`),
never as an identifier — it can be `?anon_0_gen`, can collide, and SPEC puts name
recovery out of scope.

**Register declaration, not SSA.** M4 declares `let r0…rN` at the top of each
function and assigns them exactly as the bytecode does. This is the ugly, obviously
correct floor. SSA construction (Braun et al., `docs/PRIOR-ART.md` §5) and
expression rebuilding are stage-B passes in spec 07 — they turn 40 lines of
`rN = …` into one expression, and they are where readability actually comes from.
Do not attempt them in M4.

---

## 4. Statement lowering

One IR node → one JS construct, mechanically:

| IR | JS |
|---|---|
| `block` | the block's instructions, lowered one per statement |
| `seq` | statements in order |
| `labeled(L, b)` | `L: { b }` |
| `loop(L, b)` | `L: while (true) { b }` |
| `if(B, t, e)` | `if (<cond of B's terminator>) { t } else { e }` |
| `break(L)` / `continue(L)` | `break L;` / `continue L;` |
| `return(B)` | `return r<n>;` from the block's `Ret` |
| `throw(B)` | `throw r<n>;` |
| `unreachable` | `throw new Error("unreachable");` — **not** an empty statement; the Hermes opcode traps, and a silent fallthrough would change behaviour |
| `switch(B, jumptable, arms, default)` | `switch (r<n>) { case k: …; default: … }` where every arm body ends in `break` unless the CFG says it falls through |
| `try(R, body, handler, reg)` | `try { body } catch (_exc<R>) { r<reg> = _exc<R>; handler }` |

Conditional lowering: each conditional-jump opcode maps to a JS expression
(`JmpTrue rC` → `r<C>`, `JLess a,b` → `r<a> < r<b>`, `JStrictEqual` → `===`, and
the `Not`-variants negated). Build this as a **table** in `src/emit/conds.ts`
keyed by opcode name, not a `switch` statement, so an unhandled conditional is a
loud `E_EMIT_UNSUPPORTED` naming the opcode rather than a silently wrong branch.

**Numeric fast-path opcodes are not shortcuts.** `AddN`, `MulN` etc. assert their
operands are numbers; they lower to the same `+`/`*` as the general form. The
assertion is a VM optimisation, not observable behaviour.

---

## 5. Values: strings, regexps, BigInt, literal buffers

**Strings** (`docs/HBC-FORMAT.md` §5, PRIOR-ART §6.5). Emit as a double-quoted
literal with the escape rule of spec 02 §6.2: `\\`, `\"`, `\n`, `\r`, `\t`,
`\xNN` below 0x20, `\uNNNN` for everything ≥ 0x80 **including lone surrogates**.
The result is pure ASCII, which makes output byte-stable and immune to the
editor/locale problems that eat non-BMP text. The v94 fixture already contains a
U+202F and a literal NUL inside a regexp pattern — both must survive.

*Identifier* vs *String* kind matters for **property access**, not for literals:
`GetById r, o, #c, s19` where s19 is an Identifier emits `r = o.gen` when the
text is a valid ES identifier, else `o["…"]`. A `String`-kind operand in the same
position still emits bracket form. Getting this wrong is cosmetic, not semantic —
but `o.constructor`-style names and reserved words must go through the bracket
path, so validate with a real identifier regex plus a reserved-word set.

**RegExp.** `CreateRegExp dst, patternStrId, flagsStrId, tableIdx` → `new RegExp(<pattern>, <flags>)`.
**Never decode `regExpStorage`** — the source pattern is right there as strings
(§8 of HBC-FORMAT). Do not emit a `/…/flags` literal in M4: it needs escaping
analysis (unescaped `/`, newlines) and buys nothing. `regexp-literal` is a
stage-B pass.

**BigInt.** `LoadConstBigInt[LongIndex] dst, idx` → the decimal expansion plus
`n`, from spec 01 §3.6's two's-complement decoder. `46-bigint-arithmetic` has 6
entries at v94/v98/v99 and is the test.

**Literal buffers** (HBC-FORMAT §6). `NewArrayWithBuffer[Long] dst, sizeHint,
numElems, bufIdx` → an array literal built from `readLiterals(arrayBuffer,
bufIdx, numElems)`. For v≤96 `NewObjectWithBuffer` carries key- and value-buffer
indices; for v≥97 it carries a shape-table index plus a value-buffer offset, and
keys come from `objKeyBuffer` at `shape.keyBufferOffset` for `shape.numProps`
entries. Emit an object literal preserving **key order** — property order is
observable in JS (`Object.keys`, `for…in`, `JSON.stringify`) and the equivalence
checker compares it (`docs/EQUIVALENCE.md` §2.2).

**Undefined has no tag** in the serialized-literal encoding; treat "string" as
the fallback per HBC-FORMAT §6.3 and assert the resulting string id is in range.

---

## 6. Environments → closure variables

Input: `EnvGraph` from spec 03. Output: real JS scoping.

**`lexical` slots (the normal case).** The slot becomes one `let _e<env>_<slot>;`
declared in the env's `ownerFunction`, immediately after the register
declarations. Every `LoadFromEnvironment`/`StoreToEnvironment` in that function
or a lexical descendant becomes a direct read/write of that identifier. Nesting
the emitted functions correctly is then *sufficient* — no environment object
exists at runtime. This is what PRIOR-ART §6.1 step 2 describes and it is the
difference between readable output and hermes-dec's dangling names.

**Function nesting.** `_fn<n>` is emitted **inside** the function that owns its
`closureEnvOf` environment, so JS closure capture does the work. The global
function is the outermost. A function with no known creation site (orphan,
`W_ORPHAN_FUNCTION`) is emitted at top level with a comment saying so.

**One body per creation context.** A function whose `closureCopies` (spec 03
§6.2) hold more than one environment has more than one lexical identity, so it
is emitted **once per environment**. Copy `i` goes in the owner of the
environment *it* captured — the same rule every other function follows — and
every `Create*Closure` / `Create*Class` site emits the name of the copy that
captured the environment that site passed, so no site is ever left referring to
a body it cannot see. The copy's whole lexical subtree is emitted with it, under
that copy's `envRemap`, which rewrites every `_e<env>_<slot>` the subtree emits
into the environment the copy really captured; copies nested inside another
copy's subtree compose the two remaps. Copy 0 keeps the plain `_fn<n>` name and
its ordinary home so that any reference the env graph did not record as a
creation site (a `CallDirect`, say) still resolves; copies `i > 0` are
`_fn<n>__c<i>`. Orphan placement (below) is therefore left with only the
functions that have no resolved creation site at all.

**Placement is a property of the instance, not of the function index.** "The
copy's whole lexical subtree" is more than the `closureEnvOf` children. A
closure `g` created *inside* a duplicated function `f`, over an environment `f`
itself captured, has `closureEnvOf(g)` pointing at an ancestor's environment, so
the nesting rule above hosts `g` beside copy 0 and copies `1..n` reference a
`_fn<g>` they cannot see. `g` therefore travels per **instance**: while emitting
a copy (and anything inside it), every closure the body creates whose home is
not already inside the instance being emitted gets its own instance there, under
this instance's remap and under the name its creation site emits. Moving the
*function index* inward instead is wrong and was measured worse: `g` is usually
also created from sites that are not duplicated, and those sites keep the copy-0
instance exactly where it is. For the same reason a copy's `emitName` renames
only that instance — never its children, which keep their own `_fn<n>` names.
See docs/reports/2026-09-05-ambiguous-closure-env.md §5.

**`materialised` slots.** `const _env<id> = { s0: undefined, … };` in the owner,
accesses become `_env<id>.s<slot>`, and any closure created with that env
captures the object. Correct, uglier, and rare.

**`StoreNPToEnvironment` is `StoreToEnvironment`.** The `NP` is a GC
write-barrier hint. Emitting anything different is a bug.

**The hard rule (R3).** With `strictEnv: true` (default) an unresolved
`(env, slot)` is `E_ENV_UNRESOLVED` at *analysis* time (spec 03 §6.4) and never
reaches the emitter. The emitter additionally asserts, before printing, that
**every identifier it emits is declared in an enclosing emitted scope** — a
cheap scope-stack check during lowering, not a post-hoc parse. `E_UNBOUND_IDENT`
if not. hermes-dec ships `_closure1_slot1` that is never declared; we must make
that unrepresentable.

---

## 7. Runtime helpers

### 7.1 Policy — when a helper is acceptable

A helper is acceptable **only** if all four hold:

1. **It implements a VM primitive with no direct JS surface form** — the
   generator protocol, `arguments` reification, `CallBuiltin`'s reverse argument
   order. "It would be repetitive otherwise" is *not* a reason.
2. **It is self-contained and pure** with respect to the program: no module
   state, no monkey-patching of built-ins, no prototype mutation.
3. **It is emitted inline into the output file** (`helpers: "inline"`, the
   default), so the emitted JS is one runnable file with no imports. The
   `"import"` mode exists for debugging only.
4. **It has its own unit test and a row in `docs/LOWERING-CATALOGUE.md`**, and it
   is emitted **only when used** (`helpersUsed` records which).

Everything else is inlined at the use site. In particular: property access,
arithmetic, comparisons, `typeof`, `instanceof`, array/object literals, `throw`
and `try` all lower to plain JS with no helper. If you find yourself writing
`__hbc_add`, stop.

### 7.2 `__hbc_makeGenerator` (D9) — the v≥97 shim

Static Hermes removed the generator opcodes; the compiler lowers the body to an
explicit state machine and marks the function with `FunctionHeader.flags.kind`
(spec 03 §3.4). Strategy A of PRIOR-ART §6.2, which D9 mandates for v1:

* Emit the **inner** function verbatim, structured by spec 04, as an ordinary
  function. Its signature is whatever the lowered body expects — determined
  empirically per version (see O-1), and the shim adapts to it.
* Emit `CreateGenerator dst, env, innerFnId` as
  `r<dst> = __hbc_makeGenerator(_fn<innerFnId>, <env expr>);`.
* `__hbc_makeGenerator` returns an object implementing the iterator protocol —
  `next(v)`, `return(v)`, `throw(e)`, `[Symbol.iterator]()` — by driving the
  state machine exactly as the VM does: call the body with an action code and a
  value, interpret the `{value, done}` result object it builds via
  `NewObjectWithBuffer`, and propagate `throw` by entering the body's throw path.

Why this is the right first move: it is **provably behaviour-preserving because
it is what the VM does**, it requires zero pattern recognition, and it makes the
v98/v99 generator fixtures pass the trace test on day one. The cost is that the
output has a helper and no `yield`. Strategy B (state-machine inversion to
recover real `yield`) is a spec 07 / v2 item, and it is where every other tool in
PRIOR-ART §2 currently fails.

**Async at v≥97** is the same shape with the promise driver; `async-generator`
combines both. Emit `__hbc_makeAsyncFunction` / `__hbc_makeAsyncGenerator` on the
same principle.

### 7.2.1 v≤96 goes through the same shim, at the same instruction

The v≤96 era has VM opcodes rather than a lowered state machine, but the
*emission* rule is identical, and deliberately so — M4's bar is "a mechanical
per-opcode lowering, not pattern recognition".

**`CreateGenerator` is the shim site at both eras.** Spec 03 §3.4.1 measured that
both eras use the same two-hop shape: the creation site names a **trampoline**,
and the trampoline's own `CreateGenerator` names the body.

```
v94  global:   CreateGeneratorClosure r4, r2, fn#1     -> ordinary closure creation
v94  fn#1:     CreateEnvironment r0
               CreateGenerator r0, r0, fn#2            -> THE SHIM SITE
               Ret r0
v99  fn#N:     CreateGenerator r1, r1, fn#3            -> THE SHIM SITE
```

So the lowering rules are, for every version:

| Opcode | Lowering |
|---|---|
| `CreateGeneratorClosure dst, env, fnId` / `CreateAsyncClosure dst, env, fnId` | `r<dst> = _fn<fnId>;` — an **ordinary closure**. No special case. The trampoline body is emitted like any other function |
| `CreateGenerator dst, env, fnId` | `r<dst> = __hbc_makeGenerator(_fn<fnId>, <env expr>);` |

This is the review's option (a), chosen because it needs **zero** new pattern
recognition and keeps one rule for both eras. Option (b) — special-casing
`CreateGeneratorClosure` to skip the trampoline and wrap the true body directly —
would require resolving the two-hop at emit time and deleting a function, which
is pattern recognition and belongs in a spec 07 pass if it is ever wanted.

**The body's contract with the shim.** Spec 03 §4.5 gives the v≤96 body a
synthetic resume-dispatch entry whose `switch` selects state `0` (first call) or
state `k` (resume at suspend point *k*). The three generator opcodes lower to
plain assignments against that contract:

| Opcode | Lowering |
|---|---|
| `StartGenerator` | *nothing* — the dispatcher `switch` replaces it |
| `SaveGenerator L_k` | `__state = k;` (`k` is `SuspendPoint.state`) |
| the `Ret r` that follows it | `return r;` — the yielded value |
| `ResumeGenerator dst, isReturnReg` | `r<dst> = __sent; r<isReturnReg> = __isReturn;` |
| `CompleteGenerator` | `__done = true;` |

`__hbc_makeGenerator(body, env)` then drives it: it holds `__state` (initially 0),
`__sent`, `__isReturn` and `__done` in its own closure, calls `body` on each
`next(v)` / `return(v)` / `throw(e)`, and builds the `{value, done}` result. That
is precisely what the VM does with the saved pc, which is why this is
behaviour-preserving without any recognition of *what* the generator computes.

`yield` recovery — collapsing `__state = k; return v;` … resume-case *k* back
into `r = yield v` and emitting a real `function*` — is a spec 07 stage-A pass
(`yield-recovery`), which runs first in stage A and is easier at this era than at
v≥97. Until it lands, both eras emit the shim, so **one code path is green
everywhere at M4**.

### 7.3 The other sanctioned helpers

| Helper | Why it qualifies | Notes |
|---|---|---|
| `__hbc_makeGenerator` / `__hbc_makeAsyncFunction` / `__hbc_makeAsyncGenerator` | VM primitive, no JS form | §7.2 |
| `__hbc_arguments(fnArgs)` | `ReifyArguments`/`GetArgumentsPropByVal` build a *mapped* arguments object; see §8 | must reproduce Hermes's aliasing behaviour, not the spec's |
| `__hbc_callBuiltin(n, args)` | `CallBuiltin` reads arguments in reverse from the frame top and always passes `undefined` as `this` | the builtin *number* → real global is a generated table (spec 01 §5.4) |

That is the whole list for M4. Adding a fifth requires an entry in
`docs/DECISIONS.md`.

### 7.4 Calls — inline, never `bind`

PRIOR-ART §1.2 defect 4: hermes-dec emits `callee.bind(thisArg)(args)`, which
allocates a new function per call, breaks `Function.prototype.toString`, breaks
callee identity comparison, and re-evaluates the receiver. Do not.

* **Method-call fast path (the common case).** When the callee register was
  produced by a `GetById`/`GetByIdShort` on the very register used as `thisArg`,
  emit `r<obj>.<name>(a, b)` (or `r<obj>[expr](…)`). This is both correct and
  readable, and it covers the overwhelming majority of calls.
* **General case.** `Reflect.apply(r<callee>, r<this>, [r<a>, r<b>])`. No helper
  needed — `Reflect.apply` is standard.
### 7.5 `new` — a three-instruction pattern, never lowered per opcode

`hermesc` **never** emits a bare `Construct` for `new X(…)`. It emits a triple,
and `CreateThis`/`CreateThisForNew` and `SelectObject` have no JS expression form
on their own — so §4's "one instruction, one statement" model does not apply and
they must be recognised as a unit, exactly like the method-call fast path.

Measured on `tests/fixtures/constructs/13-try-finally-no-catch` (`new Error('propagated')`):

**v84 / v94 / v96** — `CreateThis dst, prototypeReg, closureReg`:

```
[@ 19] TryGetById    2<Reg8>, 0<Reg8>, 2<UInt8>, 9<UInt16>    ; r2 = global.Error
[@ 25] GetByIdShort  0<Reg8>, 2<Reg8>, 3<UInt8>, 13<UInt8>    ; r0 = r2.prototype
[@ 30] CreateThis    1<Reg8>, 0<Reg8>, 2<Reg8>                ; r1 = OrdinaryCreateFromConstructor(r2, r0)
[@ 34] LoadConstString 4<Reg8>, 6<UInt16>                     ; arg
[@ 38] Mov           5<Reg8>, 1<Reg8>                         ; thisArg slot <- r1
[@ 41] Construct     0<Reg8>, 2<Reg8>, 2<UInt8>               ; r0 = r2.[[Construct]](this=r1, arg)
[@ 45] SelectObject  0<Reg8>, 1<Reg8>, 0<Reg8>                ; r0 = isObject(r0) ? r0 : r1
```

**v98 / v99** — `CreateThisForNew dst, closureReg, cacheIdx<UInt8>` reads
`.prototype` itself through an inline cache, so there is no separate
`GetByIdShort`:

```
[@ 19] TryGetById       2<Reg8>, 0<Reg8>, 1<UInt8>, 9<UInt16>
[@ 25] CreateThisForNew 1<Reg8>, 2<Reg8>, 2<UInt8>
[@ 29] LoadConstString  4<Reg8>, 6<UInt16>
[@ 33] Mov              5<Reg8>, 1<Reg8>
[@ 36] Construct        0<Reg8>, 2<Reg8>, 2<UInt8>
[@ 40] SelectObject     0<Reg8>, 1<Reg8>, 0<Reg8>
```

**Semantics.** `CreateThis`/`CreateThisForNew` allocate the `this` object from
the callee's `.prototype` *before* the call; `SelectObject dst, allocatedThis,
callResult` implements the spec rule "if the constructor returned an object use
that, else use the allocated `this`" *after* it.

**Matcher.** Recognise the triple:

1. a `CreateThis`/`CreateThisForNew` writing `rT`, whose closure operand is `rC`;
2. a `Construct rR, rC, argCount` whose `thisArg` frame slot was written by a
   `Mov` from `rT` (or is `rT` itself);
3. a `SelectObject rD, rT, rR` combining **the same two registers**.

Emit `r<D> = new r<C>(<args>);` for the whole triple and consume all three
instructions (plus the `Mov` and, at v≤96, the `GetByIdShort … "prototype"`
whose only use is the `CreateThis`). Do not emit anything for the individual
opcodes.

**Fallbacks, both loud.** A `CreateThis`/`CreateThisForNew` or `SelectObject`
reached **outside** a recognised triple is `E_EMIT_UNSUPPORTED` naming the opcode
and offset (EM-05) — not a crash, and not a silent skip. A bare `Construct` with
no surrounding triple (hermesc does not emit one today, but hand-written or
obfuscated bytecode might) lowers to
`Reflect.construct(r<callee>, [args])`. `CallWithNewTarget` with a new.target
distinct from the callee lowers to `Reflect.construct(callee, args, newTarget)`.

**Scope, measured.** `CreateThis` appears in **12 of 53** construct fixtures at
v94 — `05-for-in-object`, `07-for-of-iterable`, `12`–`16` (all five try/catch
fixtures), `24-generator-return-throw`, `28-async-await-error`,
`29-promise-chaining`, `47-typeof-instanceof-in`, `50-this-binding` — through
ordinary `new Error(…)` / `new Promise(…)`, not contrived cases. Without this
rule roughly a quarter of the gate corpus throws `E_EMIT_UNSUPPORTED` on the
first `new`.

---

## 8. Hermes semantics, not spec semantics (D14)

This is the subtlest requirement in the whole project and it inverts the usual
instinct.

> The decompiler's job is to reproduce **what the bytecode does**, not what the
> original source meant. Where the Hermes VM disagrees with the ECMAScript spec
> (and with Node), the emitted JS must match **Hermes**.

`docs/EQUIVALENCE.md` §5.2 measured this: running the 45 v84 construct fixtures'
own `.hbc` under the v84 Hermes VM and comparing with the Node sandbox trace
gives **41/45 agreement**, and all four disagreements are pre-Static-Hermes
Hermes simply not implementing part of ES2015+. Reproduced identically on the
HBC-89 VM, so it is not a v84 quirk.

| Divergence | Node / spec | Hermes 84–99 (measured at 84, 89, 94, 99) | What the emitter must do |
|---|---|---|---|
| per-iteration `let` in a `for` head (`18-closure-loop-let`) | closures capture `0,1,2` | `3,3,3` | **Emit one binding.** The bytecode contains *one* environment slot for `i`; emit `let` **outside** the loop (or `var`). Never re-introduce a per-iteration binding just because the loop header looks like `for(let …)` — there is no such thing in the bytecode |
| TDZ with shadowing (`20-let-const-tdz`) | inner-block `let` read before init → `ReferenceError` | no TDZ; the inner `let` writes through to the outer binding | **Emit no TDZ.** Only emit a TDZ throw where the bytecode has an explicit `ThrowIfEmpty`/`ThrowIfHasRestrictedGlobalProperty`-style check |
| non-strict `arguments` aliasing (`42-rest-params`, `49-arguments-object`) | writing `arguments[0]` mutates the parameter | no aliasing — parameter keeps its original value | `__hbc_arguments` builds an **unmapped** object at every version we target |

**Two corollaries the implementer must internalise:**

1. **A "more correct" emission is a bug.** If the emitted JS prints `0,1,2` where
   the bytecode prints `3,3,3`, the equivalence checker reports DIVERGENT and it
   is *right* to. Do not fix it by making the output more spec-compliant.
2. **The behaviour is version-dependent in principle — but not in fact, so far.**
   `docs/AGENT-LOG.md`'s Hermes-VM-from-source entry records the measurement that
   was still open when this spec was first written: the 10-fixture cross-check
   under the newly built `tools/hermes-vm/v{94,99}/bin/hermes` found that **all
   four divergences persist unchanged at v94 and v99**. So Static Hermes has
   *not* fixed them, and the same emission rules apply at 84, 94, 96, 98 and 99.
   Keep the mechanism anyway: a per-version flag table in one place
   (`src/emit/semantics.ts`), citing EQUIVALENCE §5.2 for the behaviour and the
   AGENT-LOG entry for the v94/v99 confirmation, so that the day a version fixes
   one, it is a one-line data change and not an archaeology exercise.

---

## 9. Output shape

One ES module, this order:

```js
// hbc2js — decompiled from <basename>
// HBC version 94, layout C, opcode table hbc94
"use strict";                              // only when the global function is strict
<runtime helpers actually used>            // §7, inline
<top-level: the global function's body, with nested _fn<n> declarations>
```

* **Strict mode is per function.** `FunctionFlags.strictMode` decides; emit
  `"use strict";` as the function's first statement where set. Do not hoist one
  directive to the file — a module with mixed strictness is normal in Hermes
  output and hoisting changes semantics.
* **Provenance comments** (`// fn#6 "ze" @0x56a`, and per-statement
  `// @0x1e` when `provenanceComments`) make divergence reports actionable. They
  are stripped for the round-trip oracle (which recompiles the output) because
  comments do not survive compilation anyway.
* **`functionSourceTable` free win.** When a function appears there
  (`docs/HBC-FORMAT.md` §9), its *original source text* is in the string table.
  Emit that verbatim instead of decompiling — with a comment saying so. Both
  sample fixtures have `functionSourceCount = 2`. **But** verify the recovered
  text parses and matches the expected arity before trusting it, and put it
  behind `--use-function-sources` (default on) so a mismatch can be isolated.

---

## 10. Invariants

| # | Invariant | Violation |
|---|---|---|
| EM-01 | every emitted identifier is declared in an enclosing emitted scope | `E_UNBOUND_IDENT` |
| EM-02 | output passes `node --check` | acceptance gate |
| EM-03 | no helper is emitted that is not in `helpersUsed`, and vice versa | `E_INTERNAL` |
| EM-04 | no `.bind(` appears anywhere in emitted call lowering | grep test |
| EM-05 | every opcode encountered has a lowering; unknown → `E_EMIT_UNSUPPORTED` naming it | never silently skip an instruction |
| EM-06 | object-literal key order matches the key buffer order | golden + equivalence |
| EM-07 | emitted strings are pure ASCII (all non-ASCII escaped) | golden test |
| EM-08 | `unreachable` emits a throw, never nothing | golden test |
| EM-09 | strict directives are per function, never hoisted | golden test |
| EM-10 | two runs produce byte-identical output | golden test |
| EM-11 | `lineMap` covers every emitted line that came from an instruction | spec 06 relies on it |
| EM-12 | no emitted identifier matches `/_fun\d+_ip/` (spec 00 §8 licence guard) | CI grep |

---

## 11. Test plan

`tests/gate/emit/**`, `tests/sweep/emit/**`.

### T1 — `node --check` on everything

Every gate binary at every version → emit → `node --check`. Zero failures. This
is the cheapest possible gate and it catches the whole class of "emitted a
keyword as an identifier" bugs.

### T2 — Equivalence gate (the real acceptance test)

Every gate fixture through spec 06's checker: **PASS**, with the reference trace
chosen per D14 (Hermes VM for the fixture's version where one exists — v84 from
`tools/hermesc/v84/hermes`, v94 and v99 from `tools/hermes-vm/v{94,99}/bin/hermes`
— else `expected.txt`). INCONCLUSIVE is not a pass (D15).

Expected known-divergent set: the four EQUIVALENCE §5.2 fixtures, **only** when
compared against Node. Against the matching VM they must PASS. If they do not,
§8 is wrong and that is a finding, not a test to relax.

### T3 — Emission goldens

`tests/golden/emit/<group>/<name>/vNN.js`, committed. Reviewable diffs are how
spec 07's passes will be seen to improve things. Emit with
`provenanceComments: false` so the goldens stay stable when offsets shift.

### T4 — Targeted lowering assertions

| Fixture | Assert |
|---|---|
| `45-regex-literals` | `new RegExp("…", "gmi")`, no `/…/` literal, `regExpStorage` never read |
| `46-bigint-arithmetic` | six distinct `…n` literals with the right decimal values |
| `37/40` (array literals) | array literal from the buffer, right length and values |
| `38/41` (object literals) | object literal, **key order preserved** |
| `17/21/22` (closures) | nested `function` declarations, no `_env` object, every captured variable declared in the right scope |
| `18-closure-loop-let` | **one** binding for the loop variable; output prints Hermes's answer |
| `49-arguments-object` | `__hbc_arguments`, unmapped |
| `23`–`26` v84/v94/v96 | `__hbc_makeGenerator(_fn<body>, …)` emitted at the **trampoline's** `CreateGenerator`, never at `CreateGeneratorClosure`; the body contains the state `switch`, `__state = k`, and no bare `SaveGenerator`/`StartGenerator`/`ResumeGenerator`/`CompleteGenerator` text |
| `23`–`26` v98/v99 | `__hbc_makeGenerator(_fn<n>, …)`, same rule, same site |
| `13-try-finally-no-catch` and the other **12** `new`-using fixtures (§7.5) | `new r<C>(…)` for the triple; no identifier or statement is emitted for `CreateThis`/`CreateThisForNew`/`SelectObject` |
| `52/53` | a real `switch` with the right case values, or an equivalent `if`-chain — either is acceptable at M4 provided the trace matches |
| any fixture with `functionSourceTable` entries | the verbatim source is used and parses |

### T5 — Round-trip (D3), per function

Emit → `hermesc -emit-binary` at the fixture's version → disassemble both →
normalised diff (spec 06 §6). Report the **per-function match percentage** as a
ratchet, not a global score (`docs/EQUIVALENCE.md` §4.3 — one extra instruction
shifts every register number and drags a whole function to 72%). Commit a
baseline; CI fails on regression, not on absolute score.

### T6 — Obfuscated variants

All `.obf.hbc` (241 today): emit → `node --check` → equivalence against
`expected.txt`/VM. These are behaviour-preserving transformations of the same
programs, so **they must PASS too** — the flattened dispatcher is exactly the
`while(true)` + `switch` the baseline emits natively, so this is a fair test of
the ugly path. Budget generously; INCONCLUSIVE on timeout is acceptable here,
DIVERGENT is not.

### T7 — Sweep: real bundles

`bundles/rn-template-0.72/*.hbc` → emit → `node --check` (they cannot execute
outside an RN host) → round-trip ratchet. Record output size, wall time, and the
count of functions using each helper.

---

## 12. Acceptance criteria (this is the M4 gate)

- [ ] Every gate fixture at every version emits JS that passes `node --check`.
- [ ] Every gate fixture is **PASS** under spec 06, with the D14 reference:
      Hermes VM for 84/94/99 where the fixture compiles, `expected.txt`
      otherwise. Zero DIVERGENT. INCONCLUSIVE only where a budget was hit, and
      each one listed in `docs/STATUS.md` with a reason.
- [ ] The four EQUIVALENCE §5.2 divergences PASS against their matching VM, and
      the emitter reproduces Hermes's answer, not Node's, for each.
- [ ] All `.obf.hbc` variants (241 today) pass T6.
- [ ] **The 12 `new`-using fixtures emit `new`** (§7.5): `05-for-in-object`,
      `07-for-of-iterable`, `12`, `13`, `14`, `15`, `16`,
      `24-generator-return-throw`, `28-async-await-error`, `29-promise-chaining`,
      `47-typeof-instanceof-in`, `50-this-binding` — at every version they
      compile at, with the v84/94/96 (`CreateThis`) and v98/99
      (`CreateThisForNew`) shapes both handled.
- [ ] A `CreateThis` or `SelectObject` outside a recognised triple raises
      `E_EMIT_UNSUPPORTED` naming the opcode — negative test, hand-built input.
- [ ] Every v≤96 generator/async fixture emits the shim at the trampoline's
      `CreateGenerator` and nothing special at `CreateGeneratorClosure`, and its
      body honours the §7.2.1 state contract.
- [ ] EM-01…EM-12 each have a test; EM-01 has a negative test proving it fires.
- [ ] `helpersUsed` is minimal: no fixture emits a helper it does not call, and
      the total helper set is exactly the four of §7.3.
- [ ] `grep -n '\.bind(' ` over emitted output for the whole corpus returns
      nothing (EM-04).
- [ ] Emission goldens are byte-stable across two runs and across macOS/Linux.
- [ ] Round-trip baseline recorded, with the per-function ratchet committed.
- [ ] `docs/STATUS.md` records the M4 baseline as reached, with the fixture
      counts and the helper inventory.

---

## 13. Estimated complexity

**The largest single component in the project.** ~2500 lines plus tests.

| Component | Size | Model |
|---|---|---|
| `ast.ts` + `print.ts` (node set, printer, escaping) | ~450 lines | Sonnet |
| `lower-stmt.ts` (IR → statements) | ~300 lines | Sonnet |
| `lower-instr.ts` (per-opcode lowering, the big table) | ~700 lines, mechanical but long | Sonnet |
| `conds.ts` | ~120 lines | Sonnet |
| `literals.ts` (strings, regexp, bigint, buffers) | ~300 lines | Sonnet |
| **`env.ts`** (slots → variables, scope stack, EM-01) | ~350 lines — this is R3 | **Opus** |
| **`calls.ts`** (method fast path, the §7.5 `new` triple, Reflect.apply, builtins) | ~280 lines — defect 4 and the `new` pattern both live here | **Opus** |
| **`runtime.ts`** (`__hbc_makeGenerator` and friends) | ~350 lines — must match VM semantics exactly | **Opus** |
| `semantics.ts` (D14 per-version flags) | ~80 lines | Opus (judgement, not volume) |
| tests T1–T7 | ~1200 lines | Sonnet |

**Sequence.** Get one fixture end-to-end first (`01-if-else-chain`, v94), then
`node --check` across the corpus, then the equivalence gate one fixture family at
a time in fixture-number order (D11). The generator shim last, because it needs
the rest working to test against.

---

## 14. Open questions for the overseer

* **O-1 — the lowered generator body's signature is unknown.** §7.2 says the shim
  drives the state machine, but the exact calling convention static Hermes uses
  (how the action code and sent value arrive, where the state lives, how `throw`
  enters) has **not been read off the bytecode yet**. It must be derived
  empirically from `23`–`26` at v98/v99 before `runtime.ts` is written — this is
  precisely a `docs/TASKS.md` **T3** item. Should I file it as an explicit
  sub-task, or fold it into the M4 implementer's brief?
* **O-2 — ~~do v94 and v99 still diverge from Node?~~ RESOLVED.**
  `docs/AGENT-LOG.md`'s Hermes-VM build entry measured it: all four divergences
  persist unchanged at v94 and v99. Folded into §8; no decision needed.
* **O-3 — v≤96 generators through the shim at M4?** §7.2.1 now settles the
  *mechanism* (the shim goes on `CreateGenerator`, at both eras, with no
  pattern recognition) but the *policy* question stands: the alternative is
  emitting `function*` with `yield` immediately for v≤96, which is prettier but
  puts a recovery pass inside M4. I prefer the uniform floor; confirm?
* **O-4 — `--use-function-sources` default.** Emitting the original source
  verbatim for functions in `functionSourceTable` is a free readability win but
  makes the output a *mix* of decompiled and original code, which could mask a
  decompiler bug in exactly those functions. Default on (my choice) or off?
* **O-5 — module format.** I emit one ES module with inline helpers. An RN bundle
  decompiled this way is a single ~10 MB file. Should large bundles be split per
  CJS module (using `cjsModuleTable` when present), or is one file fine for M4?

---

## 15. Review responses (`docs/specs/REVIEW-03-07.md`)

| Item | Verdict | Where |
|---|---|---|
| **B2** `CreateThis`/`CreateThisForNew` + `Construct` + `SelectObject` — the real shape of `new` — had no lowering rule, and hits 12/53 fixtures | **Fixed** | New **§7.5** with the verbatim v94 and v99 dumps of `13-try-finally-no-catch`, the operand semantics of both `CreateThis` (dst, prototypeReg, closureReg) and `CreateThisForNew` (dst, closureReg, cacheIdx — it reads `.prototype` through an inline cache, so there is no separate `GetByIdShort`), the three-instruction matcher, and two loud fallbacks. Both opcodes are now in §3's naming table as "consumed by the `new` pattern, never lowered standalone". §11 T4 and §12 list the 12 affected fixtures by name; a negative test asserts `E_EMIT_UNSUPPORTED` for a `CreateThis` outside a triple. I re-measured the 12/53 count independently rather than copying it |
| **S3** the v≤96 shim-routing rule was prose and ambiguous between two emissions | **Fixed** | New **§7.2.1** picks the review's option (a) explicitly and gives operand-level rules: `CreateGeneratorClosure`/`CreateAsyncClosure` → an ordinary closure; **`CreateGenerator` is the shim site at both eras**. Includes the verbatim v94 trampoline and v99 equivalent, plus the full state contract (`SaveGenerator L_k` → `__state = k`, `ResumeGenerator` → read `__sent`/`__isReturn`, `CompleteGenerator` → `__done`) that spec 03 §4.5's dispatcher makes possible |
| **S4** O-2 asked for a measurement `docs/AGENT-LOG.md` had already made | **Fixed** | §8 corollary 2 rewritten to cite the AGENT-LOG result — all four divergences persist unchanged at v94 and v99 — the table header now reads "measured at 84, 89, 94, 99", and O-2 is marked RESOLVED rather than left open. The per-version flag table survives as mechanism, not as an open question |
| **B1** (spec 03's generator resume blocks) | **Consumed here** | §7.2.1's state contract only works because spec 03 §4.5 gives the body a resume dispatcher; the two are written to match |
| **What holds up** (the method-call fast path, verified by the reviewer against real `GetByIdShort`+`Call` bytes) | Acknowledged, unchanged | §7.4's first bullet stands |
| S1, S2, S5, S6, N1–N3 | Not this spec's | S1 in spec 04; S2/S6 in spec 03; S5/N1/N2 in spec 07; N3 in spec 06 |

**Beyond the review.** HBC **96** joined the corpus while these specs were in
review (`docs/TOOLCHAIN.md`): it is layout class C with v94's opcode numbering
apart from `DirectEval`'s third operand, so every v94 rule here applies to it
verbatim, and the `era: "opcode"` generator path now spans 84/94/96. Fixture
counts in §11–§12 were re-derived (249 gate binaries, 241 obfuscated).
