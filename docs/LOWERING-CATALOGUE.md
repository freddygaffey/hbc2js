# The lowering catalogue (D12, spec 07 §3)

Empirical record of what `hermesc` actually emits for each source construct in
`tests/fixtures/constructs/`, at HBC versions 84, 94, 98, 99 (and 96 where a
divergence was suspected — none was found for the idioms below). **v96
fixtures were added to the corpus after most of this catalogue was written;
v96 shares v94's opcode table** (per `docs/TASKS.md`'s note when the v96
toolchain/fixtures landed), and this was spot-checked directly on
`while-loop` and `try-finally-dedup` — both byte-for-byte structurally
identical to v94 modulo scratch-register numbering. Rows below that read
"94,98,99" or similar without "96" have not been individually re-verified
at v96, but no idiom in this catalogue is expected to differ there. Produced for
task **T3** (`docs/TASKS.md`). Every row here is read from
`hermesc -dump-bytecode -pretty-disassemble=false` output, not guessed from
source or from hermes-dec (D4: hermes-dec is a behaviour oracle only, never a
source of opcode tables — nothing below was copied from its output, only
independently verified against this project's own `tools/hermesc/vNN/hermesc`).

**Method.** For every fixture, both default (`-O`, matching what Metro/RN
actually ships) and `-O0` bytecode was dumped at v84/v94/v98/v99, for every
version the fixture's `versions.txt` (if any) says compiles. `-O0` is closer
to a 1:1 syntactic mapping and is usually quoted as the primary evidence
because it is what a matcher's "canonical shape" should be checked against
first; `-O` is quoted where the optimizer's transformation is itself the
finding (loop-invariant hoisting, constant folding, cross-function inlining).

**Confidence key** (spec 07 §3.1):
- ✅ **verified** — disassembly read at the versions listed, including at
  least one cross-version comparison.
- ✅ **single-version** — disassembly read, but only one HBC version was
  actually inspected; other versions are assumed identical because nothing
  in `docs/HBC-FORMAT.md`'s version-diff notes suggests otherwise. Must be
  confirmed at a second version before a pass is written against it, per
  spec 07 §4's "Confirmed ✅" rule — treat "single-version" as ⚠️, not ✅, for
  that purpose.
- ⛔ **inferred** — reasoned from adjacent evidence (e.g. register/const
  usage patterns) without a full instruction-by-instruction trace, or backed
  by an ad hoc probe file rather than a fixture. A pass must not be
  implemented against a ⛔ row (spec 07 §4).

## Index

| # | Idiom | Construct(s) | Versions read | Evidence file | Confidence | Notes |
|---|---|---|---|---|---|---|
| 1 | If/else compare chain | `if`/`else if`/`else` (01) | 84,94,98,99 | [if-else-chain.md](lowering/if-else-chain.md) | ✅ verified | Plain conditional-jump tree; no idiom to "raise", already close to source shape |
| 2 | Pre-test + post-test loop rotation | `while` (02) | 94,99 (O0); 94 (O) | [while-loop.md](lowering/while-loop.md) | ✅ verified | Condition is evaluated **twice**: once as a guard before the loop, once as the back-edge test. **Pass `loop-cond` (stage A), M5 — recovered** |
| 3 | Body + single trailing test | `do...while` (03) | 94,99 (O0) | [do-while-loop.md](lowering/do-while-loop.md) | ✅ verified | No pre-test at all; dead `while(false)` condition is *not* eliminated, even at default `-O`. **Pass `loop-cond` (stage A), M5 — recovered** |
| 4 | `for` = `while` + hoisted init, update folded into body tail | `for` (04) | 94,99 (O0) | [for-loop.md](lowering/for-loop.md) | ✅ verified | Comma-operator init/update confirmed as ordinary sequential instructions, not a special form. Cross-checked at v99 for M5 (§4 of the evidence file). **Pass `for-header` (stage A), M5 — recovered** |
| 5 | Labelled break/continue as reach, not marking | labelled break/continue (08) | 94 (O0) | [labeled-break-continue.md](lowering/labeled-break-continue.md) | ✅ single-version | `break outer`/`continue search` are **plain `Jmp`/conditional jump** whose target is the outer loop's exit/update block; no distinct opcode or flag |
| 6 | Switch: `JStrictEqual(Long)` compare chain | sparse/small/string switch (09,10) | 84,94,99 | [switch.md](lowering/switch.md) | ✅ verified | v84/94/99 all use compare chain for <~20 string cases |
| 7 | Switch: `SwitchImm`/`UIntSwitchImm` dense table | dense int switch (52,53) | 84,94,98,99 | [switch.md](lowering/switch.md) | ✅ verified | Renamed `SwitchImm`→`UIntSwitchImm` at v99 but operand shape (`Reg8,tableOffset,defaultTarget,min,max`) is identical |
| 8 | Switch: `StringSwitchImm` | dense string switch (24 cases, `56-switch-string-jumptable`) | 84,94,96,98,99 | [switch.md](lowering/switch.md) | ✅ measured, T9 (fixture; 0 at v84/94/96, 1 at v98/99) | Threshold is **v98, not just v99** — corrects spec 07 §4's "v99" claim |
| 9 | `for...in`: `GetPNameList`/`GetNextPName`/`JmpUndefined` | `for...in` (05) | 94 | [for-in.md](lowering/for-in.md) | ✅ single-version | **Resolves spec 03/07's open question** — the opcode family is exactly as predicted |
| 10 | `for...of`: `IteratorBegin`/`IteratorNext`/`IteratorClose` | `for...of`, array destructuring, spread (06,07,37) | 94 | [for-of.md](lowering/for-of.md) | ✅ single-version | Same three opcodes power `for...of`, array destructuring, and (see #17) array spread |
| 11 | `try`/`catch`: handler-table region + `Catch` leader | try/catch (12,14,15) | 94,99 (O0) | [try-catch.md](lowering/try-catch.md) | ✅ verified | Optional catch binding (`catch {}`) simply omits the `StoreToEnvironment`/local bind after `Catch` |
| 12 | `finally`: duplicated into normal path + synthesized catch-rethrow | try/finally (12,13,16) | 94,99 (O0) | [try-finally-dedup.md](lowering/try-finally-dedup.md) | ✅ verified | `continue`/`break` inside `finally` **never reach** the synthesized `Throw`; they jump straight to the loop's continue/break target, which is *how* the pending exception gets silently dropped |
| 13 | Closures: one flat `CreateEnvironment` per function, `Load/StoreToEnvironment` by slot | closures (17,18,21,22) | 94,99 | [closures-env-slots.md](lowering/closures-env-slots.md) | ✅ verified | See #14 for the `var`-vs-`let` loop divergence this exposes |
| 14 | **D14**: `for (let ...)` closures share ONE binding — no per-iteration environment | closure-loop-let (18) vs closure-loop-var (17) | 84, 94, 99 (all three **executed** on real Hermes VMs) | [closures-env-slots.md](lowering/closures-env-slots.md) | ✅ verified | **Major surprise** — see report. Hermes's `let` in a `for` loop behaves exactly like `var` at every version tested; this contradicts spec/Node and is *not* an edge case, it's the common "closures in a loop" pattern |
| 15 | **D14**: TDZ enforcement is version-dependent (v84 has it, v94/v99 don't); the shadowing bug is a slot-aliasing artifact that v99 half-fixes | let/const TDZ (20) | 84, 94, 99 (all three executed) | [tdz.md](lowering/tdz.md) | ✅ verified | v84: real `LoadConstEmpty`/`ThrowIfEmpty` TDZ check. v94/v99: `LoadConstUndefined`, no check at all — a genuine cross-version conformance regression. Shadowing: v84/94 alias the outer and inner `let` to one slot (so the check, when present, never fires); **v99 gives them separate slots**, correcting spec 05 §8's table for that one column — see file §4 |
| 20a | `new X(...)`: `CreateThis`/`CreateThisForNew` + `Construct` + `SelectObject` triple, never a bare `Construct` | any `new` expression, incl. class instantiation (12/53 v94 fixtures per spec 05 §7.5's count, plus 32–36) | 84, 94, 96, 98, 99 | [new-expression.md](lowering/new-expression.md) | ✅ verified | Independently measured here and in `docs/specs/05-emitter.md` §7.5 (commit `908cc1d`) — **no disagreement**; this file adds the v96 spot-check and the general (non-class) case |
| 16 | `arguments` object: real reified object, aliases named params (sloppy mode) | `arguments` (42,49) | 94 (O0) | [arguments-object.md](lowering/arguments-object.md) | ✅ single-version | `CreateArguments`-family opcode confirmed; mapped-arguments aliasing is a live `Store/LoadFromEnvironment` on the *same* slot the parameter uses |
| 17 | Generators, v≤96: VM opcode-driven coroutine | `function*` (23,24,25,26) at v84/94 | 84,94 | [generators.md](lowering/generators.md) | ✅ verified | `StartGenerator`/`ResumeGenerator`/`SaveGenerator`/`CompleteGenerator`, exactly as PRIOR-ART §6.2 predicted |
| 18 | Generators, v≥97: `CreateGenerator` + compiler-lowered state machine | `function*` (23,24,25,26) at v98/99 | 98,99 | [generators.md](lowering/generators.md) | ✅ verified (shape); ✅ measured, T13 (resume-ABI integer codes) | **D9 shim boundary** — full account of the wrapper/body split, env slot roles, and what remains unpinned |
| 19 | Async/await: generator + builtin spawn helper | `async function` (27,28,29) | 94,98,99 | [async-await.md](lowering/async-await.md) | ✅ single-version (94); ✅ measured, T13 (98/99 driver protocol) | v94: `CreateAsyncClosure` wraps an opcode-driven generator. v99: async body uses the *same* lowered state machine as v99 generators, run by an unnamed driver function |
| 20 | Classes (v99 only): `CreateBaseClass`/`CreateDerivedClass` + `Constructor<N>`/`NCFunction<N>` | `class` (32,33,34,35,36) | 99 | [classes.md](lowering/classes.md) | ✅ single-version | Disassembler's own function-role prefixes (`Constructor<>`, `NCFunction<>`) map directly onto spec 03's function classification; instance fields run via a separate `<instance_members_initializer:N>` function called from the constructor's top |
| 21 | Template literals: plain string concatenation, no dedicated opcode | template literals (43) | 94 | [template-literals.md](lowering/template-literals.md) | ✅ single-version | Confirmed *not* a distinct bytecode idiom — nothing for a pass to "raise" beyond ordinary `Add`/`AddS` folding |
| 22 | Destructuring (array/object): iterator protocol + `undefined`-check defaults | destructuring (37,38,39) | 94 | [destructuring.md](lowering/destructuring.md) | ✅ single-version | Array destructuring reuses idiom #10 verbatim; default values reuse the `StrictEq/Neq undefined` idiom also seen in #23/#24 |
| 23 | Spread (array/call) and rest params | spread/rest (40,41,42) | 94 | [spread-rest.md](lowering/spread-rest.md) | ✅ single-version | Array spread reuses idiom #10; object spread lowers to `NewObject` + repeated `CallBuiltin` (version-dependent builtin index, behaves as `CopyDataProperties`) |
| 24 | Default parameters: `undefined`-check, evaluated per-call | default params (39,51) | 94 | [default-params.md](lowering/default-params.md) | ✅ single-version | Same `StrictEq/Neq undefined` idiom as destructuring defaults — one matcher can plausibly serve both |
| 25 | Optional chaining / nullish coalescing: loose `Eq null` short-circuit | `?.`/`??` (48) | 94 | [optional-chaining.md](lowering/optional-chaining.md) | ✅ single-version | Uses loose `Eq` against `LoadConstNull` (not two checks for `null`/`undefined` separately) |
| 26 | Logical assignment (`&&=`,`\|\|=`,`??=`) | `57-logical-assignment` | 84,94,96,98,99 | [logical-assignment.md](lowering/logical-assignment.md) | ✅ measured, T9 (fixture; `??=` is a loose `!= null` jump) | Compiles to an ordinary short-circuit branch around a plain store; not a new opcode |
| 27 | Obfuscated control-flow flattening vs. Hermes's own constant folding | `source.obf.js` variants (04,09,19 inspected) | 94 (O and O0) | [obfuscated-control-flow.md](lowering/obfuscated-control-flow.md) | ✅ verified (surprising negative result) | **Hermes's optimizer — and even its `-O0` front end — collapses javascript-obfuscator's `while(true){switch(ip){...}}` dispatcher back to linear code** whenever the dispatch index is compile-time-derivable. The hardened-tier CFG stress may not be stressing CFG recovery at all for short functions; see file and report |

## Readability rows (PL-06)

`catalogue: []` fails the gate, and a readability rung — one that makes
already-correct output easier to read rather than recognising a Hermes
lowering idiom — has no idiom to cite. These rows exist so PL-06 still applies
to it: same columns, `R`-prefixed keys, parsed into the same
`Map<number | string, CatalogueRow>` as the numbered index above (spec
`docs/specs/passes/01-framework-fixes.md` F2). "Versions read" names the
baseline construct/version the rung's shape was confirmed against, not a
Hermes bytecode idiom (there is none). Do not weaken the confidence rule for a
numbered row's sake: a row here that is `⛔` or `✅ single-version` still fails
PL-06 exactly as for the numbered idioms.

| # | Idiom | Construct(s) | Versions read | Evidence file | Confidence | Notes |
|---|---|---|---|---|---|---|
| R1 | `expr-rebuild` — fold register temporaries back into expressions | any register-heavy body (01) | 01-if-else-chain v94 | [02-expr-rebuild.md](specs/passes/02-expr-rebuild.md) | ✅ verified | Stage B; §4.3's expression-only `check` is the whole guard |
| R2 | `global-access` — bare identifier instead of `globalThis.x` / `TryGetById` chain | global reads/writes (any fixture touching a global) | 01-if-else-chain v94 | [03-global-access.md](specs/passes/03-global-access.md) | ✅ verified | Stage B, after `expr-rebuild` |
| R3 | `call-shape` — plain `f(a, b)` instead of `Reflect.apply(f, this, [a, b])` | any call site | 01-if-else-chain v94 | [04-call-shape.md](specs/passes/04-call-shape.md) | ✅ verified | Stage B, after `expr-rebuild` and `global-access` |
| R4 | `fn-naming` — recover a named function's declared name from its own header | named function declarations/expressions | 19-var-hoisting v94 | [05-fn-naming.md](specs/passes/05-fn-naming.md) | ✅ verified | Stage B; reads `ctx.module` |
| R5 | `var-naming` / `closure-naming` — replace `rN`/`_eN_M` with a recovered source name | any construct with locals or closures | 19-var-hoisting v94 | [05-fn-naming.md](specs/passes/05-fn-naming.md) | ✅ verified | Stage B; reads `ctx.module` |
| R6 | `jsx-recover` — `React.createElement` call chain back to JSX | JSX-producing bundles (RN template) | 19-var-hoisting v94 | [06-label-clean.md](specs/passes/06-label-clean.md) | ✅ verified | Stage B; reads `ctx.module` |
| R7 | `string-array-decode` — inline a decoded string-table lookup | obfuscated string arrays (`.obf` variants) | 19-var-hoisting v94 | [06-label-clean.md](specs/passes/06-label-clean.md) | ✅ verified | Stage B |
| R8 | `label-clean` — drop a structurer label nothing names any more | any loop/labeled-block whose label became dead after other rungs ran | 08-labeled-break-continue v94 | [06-label-clean.md](specs/passes/06-label-clean.md) | ✅ verified | Stage A. The ladder's own numbering originally pointed this rung at index row 5 (labelled break/continue), which is `✅ single-version` and so refused by `checkCatalogue` — this rung is IR hygiene (drop a now-unused `LabelId`), not a recognition of that idiom, hence its own `R8` row. Row 5's evidence link stays in this Notes cell for provenance: [labeled-break-continue.md](lowering/labeled-break-continue.md) |

## Runtime helpers (spec 05 §7.1 rule 4)

Every entry of `src/runtime/helpers.ts` — the emitted prelude — with the VM
primitive it stands for and the opcode(s) that pull it in. Spec 05 §7.1 makes a
row here, and a unit test, a *condition of the helper existing at all*; the unit
tests are `tests/gate/runtime/helpers.test.ts`, one `test("review-M4-H3: <name>
…")` per helper, and two ratchet tests there fail if a new helper arrives
without either. Helpers are emitted only when used (`helpersUsed`, EM-03), in
dependency order.

The `__hbc_b_*` prefix marks an *internal* `CallBuiltin` entry — a VM intrinsic
with no JS global behind it. Builtins that ARE real globals (`Math.floor`,
`JSON.stringify`, `Object.keys`, …) get no helper: `src/emit/calls.ts` emits the
call directly.

| Helper | Stands for | Pulled in by | Note |
|---|---|---|---|
| `__hbc_empty` | the VM's "empty" sentinel (a TDZ binding before its initialiser) | `LoadConstEmpty`, `ThrowIfEmpty`, `ThrowIfThisInitialized` | A distinct `Symbol`, never `undefined` — collapsing it would disarm every TDZ check the bytecode actually has |
| `__hbc_HermesInternal` | the Hermes *host* object the compiler calls into | `GetById "HermesInternal"` | Only the reached entry points: `concat` (ToString on `this` and every argument, so a Symbol still throws), `getEpilogues`, `hasPromise`, `useEngineQueue`, `enqueueJob`. Supplied by the prelude rather than the global object, which the equivalence checker would see |
| `__hbc_delegated` | the "this yield is a `yield*` pass-through" flag | `CallBuiltin generatorSetDelegated` | Module-scoped because the builtin names no generator: it always means the one currently stepping |
| `__hbc_unresolved_env` | *nothing* — a loud marker for an environment access spec 03 §6 could not resolve | `--lenient-env` only (review M4-H2) | Throws when reached, naming fn/offset/slot. The default is still `E_ENV_UNRESOLVED` on the whole module |
| `__hbc_makeGenerator` | the v≤96 generator object protocol over a frame factory | `CreateGenerator`, `StartGenerator`/`SaveGenerator`/`ResumeGenerator` bodies | `step(sent, isReturn, isThrow) -> [value, done]`. Re-entry is a `TypeError` with the VM's text; a body throw finishes the generator; methods live on a per-instance prototype so the object has no own properties, like a real one |
| `__hbc_makeGeneratorLowered` | the v≥97 shim: Static Hermes lowers the body to a state machine (D9) | `FunctionHeader.flags.kind = generator` at v≥97 | `body(mode, value)` with mode 0/1/2 = next/throw/return |
| `__hbc_arguments` | `arguments` reification | `ReifyArguments`, `GetArgumentsPropByVal` | **Unmapped** at every version we target (D14: Hermes 84–99 does not alias parameters) |
| `__hbc_iterBegin` | `IteratorBegin` | `IteratorBegin` | Returns `[iterator, next]`. Reproduces the *value-only* TypeError text (`object null is not iterable …`) — the expression-text form V8 uses for `for…of`/spread is not reconstructible from bytecode |
| `__hbc_iterNext` | `IteratorNext` | `IteratorNext` | Signals exhaustion by returning the iterator as `undefined`, which is how the opcode's register protocol works |
| `__hbc_iterClose` | `IteratorClose` | `IteratorClose` | The `ignoreInner` flag is the spec's `IteratorClose(…, true)`: it swallows a throw from `.return` itself, and only then |
| `__hbc_pnames` | `GetPNameList` | `GetPNameList` | `for…in` key snapshot, including inherited enumerables; `null`/`undefined` yields `undefined` (the "skip the loop" signal) |
| `__hbc_nextPName` | `GetNextPName` | `GetNextPName` | Skips keys deleted since the snapshot (`k in o`), boxes a primitive receiver |
| `__hbc_b_apply` | `CallBuiltin apply` | `CallBuiltin apply` | Arity is the signal: 3 arguments = `Reflect.apply`, 2 = `Reflect.construct` |
| `__hbc_b_applyWithNewTarget` | `CallBuiltin applyWithNewTarget` | same | `Reflect.construct(fn, args, newTarget)` — the prototype comes from `new.target` |
| `__hbc_b_arraySpread` | `CallBuiltin arraySpread` | `[...x]`, spread call arguments | Writes from `index` and returns the next index, so successive spreads compose |
| `__hbc_b_copyDataProperties` | `CallBuiltin copyDataProperties` | object rest/spread | Own enumerable keys, **symbols included**, minus the excluded set; a `null`/`undefined` source is a no-op |
| `__hbc_b_copyRestArgs` | `CallBuiltin copyRestArgs` | rest parameters | Returns a real `Array`, not an arguments object |
| `__hbc_b_ensureObject` | `CallBuiltin ensureObject` | destructuring, iterator results | Throws the VM's own message text, which is passed in |
| `__hbc_b_getMethod` | `CallBuiltin getMethod` | `for…of`, `yield*`, optional call | The spec's GetMethod: `null`/`undefined` → `undefined`, non-callable → `TypeError` |
| `__hbc_b_getTemplateObject` | `CallBuiltin getTemplateObject` | tagged templates | Frozen, `.raw` non-enumerable, **cached by call-site id** — a tagged template must hand the same object to every call |
| `__hbc_b_initRegexNamedGroups` | `CallBuiltin initRegexNamedGroups` | named capture groups | Identity: V8 already populates `.groups`. The helper exists so the call has a callee |
| `__hbc_b_throwTypeError` | `CallBuiltin throwTypeError` | `JmpTypeOfIs` guards, class field checks | Message supplied by the bytecode |
| `__hbc_b_throwReferenceError` | `CallBuiltin throwReferenceError` | TDZ and unresolved-global checks | Message supplied by the bytecode |
| `__hbc_b_silentSetPrototypeOf` | `CallBuiltin silentSetPrototypeOf` | `class … extends`, `__proto__` in a literal | "Silent" is the semantics: a failure is swallowed, not thrown |
| `__hbc_b_exportAll` | `CallBuiltin exportAll` | `export * from` | `for…in`, so inherited names come too; `default` is excluded |
| `__hbc_b_spawnAsync` | `CallBuiltin spawnAsync` — the async-function driver | every `async function` | Drives a generator body: a rejected `await` is thrown back *into* the body. **Known divergence (review M4-M1):** Hermes ≤96 calls a thenable's `then` synchronously inside `await`; `Promise.resolve(v).then(…)` defers it one tick |
| `__hbc_b_makeAsyncIterator` | `CallBuiltin makeAsyncIterator` | `for await`, async generators | Literally `__hbc_b_spawnAsync` (its only dependency) |
| `__hbc_b_awaitAsyncGenerator` | `CallBuiltin awaitAsyncGenerator` | async generators | `Promise.resolve` |
| `__hbc_b_requireFast` | `CallBuiltin requireFast` (Metro's fast require) | Metro-bundled modules | **Refuses**: `require(n)` outside a Metro host has no answer, and inventing one would be a silently wrong decompilation |
| `__hbc_b_generatorSetDelegated` | `CallBuiltin generatorSetDelegated` | `yield*` at v≤96 | Sets `__hbc_delegated` |
| `__hbc_b_functionPrototypeApply` | `CallBuiltin functionPrototypeApply` | `f.apply(…)` fast path | Goes through the *original* `Function.prototype.apply`, so a shadowed `.apply` on the callee is ignored |
| `__hbc_b_functionPrototypeCall` | `CallBuiltin functionPrototypeCall` | `f.call(…)` fast path | Same, with the arguments spread |
| `__hbc_b_applyArguments` | `CallBuiltin applyArguments` | `super(...arguments)` in an implicit derived constructor | Measured on `33-class-inheritance-super` v99 fn#7: constructs when `new.target` is present, applies otherwise |

## Appendix: fixtures not yet given a dedicated row

`19-var-hoisting`, `21-iife-closures`, `22-nested-closures-counters`,
`26-infinite-generator-take`, `29-promise-chaining`, `30-async-generator`
(uncompilable at every version — `for await` / async generators are rejected
by every `hermesc` this project can fetch; see the fixture's `versions.txt`),
`31-microtask-ordering`, `44-tagged-templates`, `45-regex-literals`,
`46-bigint-arithmetic`, `47-typeof-instanceof-in`, `50-this-binding` were
read as corroborating evidence for the rows above (var hoisting → idiom #13's
global-`DeclareGlobalVar`/`PutById` path; IIFEs and nested closures →
idiom #13; `this`-binding → ordinary `LoadParam 0`) but did not surface a
distinct idiom worth its own row. They should get one before the
corresponding `src/passes/` entry is written, per spec 07 §4's "must be
measured before any pass is written" rule — this catalogue does not yet
cover 100% of the corpus, only the spec 07 §4/§6 priority list plus D14/the
obfuscation ask.
