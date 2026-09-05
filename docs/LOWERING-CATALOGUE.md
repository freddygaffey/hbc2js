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
| 1 | If/else compare chain | `if`/`else if`/`else` (01) | 84,94,98,99 | [if-else-chain.md](lowering/if-else-chain.md) | ✅ verified | Plain conditional-jump tree; no idiom to "raise", already close to source shape. **Pass `if-chain` (stage A), M5 — recovered** |
| 2 | Pre-test + post-test loop rotation | `while` (02) | 94,99 (O0); 94 (O) | [while-loop.md](lowering/while-loop.md) | ✅ verified | Condition is evaluated **twice**: once as a guard before the loop, once as the back-edge test. **Pass `loop-cond` (stage A), M5 — recovered** |
| 3 | Body + single trailing test | `do...while` (03) | 94,99 (O0) | [do-while-loop.md](lowering/do-while-loop.md) | ✅ verified | No pre-test at all; dead `while(false)` condition is *not* eliminated, even at default `-O`. **Pass `loop-cond` (stage A), M5 — recovered** |
| 4 | `for` = `while` + hoisted init, update folded into body tail | `for` (04) | 94,99 (O0) | [for-loop.md](lowering/for-loop.md) | ✅ verified | Comma-operator init/update confirmed as ordinary sequential instructions, not a special form. Cross-checked at v99 for M5 (§4 of the evidence file). **Pass `for-header` (stage A), M5 — recovered** |
| 5 | Labelled break/continue as reach, not marking | labelled break/continue (08) | 94 (O0) | [labeled-break-continue.md](lowering/labeled-break-continue.md) | ✅ single-version | `break outer`/`continue search` are **plain `Jmp`/conditional jump** whose target is the outer loop's exit/update block; no distinct opcode or flag |
| 6 | Switch: `JStrictEqual(Long)` compare chain | sparse/small/string switch (09,10) | 84,94,99 | [switch.md](lowering/switch.md) | ✅ verified | v84/94/99 all use compare chain for <~20 string cases. **Pass `switch-raise` S2 (stage A), M5 — blocked on F13, not yet recovered** |
| 7 | Switch: `SwitchImm`/`UIntSwitchImm` dense table | dense int switch (52,53) | 84,94,98,99 | [switch.md](lowering/switch.md) | ✅ verified | Renamed `SwitchImm`→`UIntSwitchImm` at v99 but operand shape (`Reg8,tableOffset,defaultTarget,min,max`) is identical. **Pass `switch-raise` S1 (stage A), M5 — recovered** |
| 8 | Switch: `StringSwitchImm` | dense string switch (24 cases, `56-switch-string-jumptable`) | 84,94,96,98,99 | [switch.md](lowering/switch.md) | ✅ measured, T9 (fixture; 0 at v84/94/96, 1 at v98/99) | Threshold is **v98, not just v99** — corrects spec 07 §4's "v99" claim |
| 9 | `for...in`: `GetPNameList`/`GetNextPName`/`JmpUndefined` | `for...in` (05) | 94, 99 | [for-in.md](lowering/for-in.md) | ✅ verified | **Resolves spec 03/07's open question** — the opcode family is exactly as predicted; v99 re-read (spec 21) found the shape identical |
| 10 | `for...of`: `IteratorBegin`/`IteratorNext`/`IteratorClose` | `for...of`, array destructuring, spread (06,07,37) | 84, 94, 96, 98, 99 | [for-of.md](lowering/for-of.md) | ✅ verified | Same three opcodes power `for...of`, array destructuring, and (see #17) array spread; v99 re-read (spec 21) — same opcodes, `Mov`-refreshed source/state operands (for-of.md §7). Recovered by the `for-of` stage-A rung (done 2026-09-05): three further per-version shapes measured while landing it — v84/v94/v96 give a `break`-carrying loop a nested `try` and a **shared, merge-point** cleanup handler neither `try` owns, v96/v98/v99 schedule body constant loads after the setup `IteratorBegin`, v99 copies the state into a scratch register before a normal close |
| 11 | `try`/`catch`: handler-table region + `Catch` leader | try/catch (12,14,15) | 94,99 (O0) | [try-catch.md](lowering/try-catch.md) | ✅ verified | Optional catch binding (`catch {}`) simply omits the `StoreToEnvironment`/local bind after `Catch` |
| 12 | `finally`: duplicated into normal path + synthesized catch-rethrow | try/finally (12,13,16) | 94,99 (O0) | [try-finally-dedup.md](lowering/try-finally-dedup.md) | ✅ verified | `continue`/`break` inside `finally` **never reach** the synthesized `Throw`; they jump straight to the loop's continue/break target, which is *how* the pending exception gets silently dropped |
| 13 | Closures: one flat `CreateEnvironment` per function, `Load/StoreToEnvironment` by slot | closures (17,18,21,22) | 94,99 | [closures-env-slots.md](lowering/closures-env-slots.md) | ✅ verified | See #14 for the `var`-vs-`let` loop divergence this exposes |
| 14 | **D14**: `for (let ...)` closures share ONE binding — no per-iteration environment | closure-loop-let (18) vs closure-loop-var (17) | 84, 94, 99 (all three **executed** on real Hermes VMs) | [closures-env-slots.md](lowering/closures-env-slots.md) | ✅ verified | **Major surprise** — see report. Hermes's `let` in a `for` loop behaves exactly like `var` at every version tested; this contradicts spec/Node and is *not* an edge case, it's the common "closures in a loop" pattern |
| 15 | **D14**: TDZ enforcement is version-dependent (v84 has it, v94/v99 don't); the shadowing bug is a slot-aliasing artifact that v99 half-fixes | let/const TDZ (20) | 84, 94, 99 (all three executed) | [tdz.md](lowering/tdz.md) | ✅ verified | v84: real `LoadConstEmpty`/`ThrowIfEmpty` TDZ check. v94/v99: `LoadConstUndefined`, no check at all — a genuine cross-version conformance regression. Shadowing: v84/94 alias the outer and inner `let` to one slot (so the check, when present, never fires); **v99 gives them separate slots**, correcting spec 05 §8's table for that one column — see file §4 |
| 20a | `new X(...)`: `CreateThis`/`CreateThisForNew` + `Construct` + `SelectObject` triple, never a bare `Construct` | any `new` expression, incl. class instantiation (12/53 v94 fixtures per spec 05 §7.5's count, plus 32–36) | 84, 94, 96, 98, 99 | [new-expression.md](lowering/new-expression.md) | ✅ verified | Independently measured here and in `docs/specs/05-emitter.md` §7.5 (commit `908cc1d`) — **no disagreement**; this file adds the v96 spot-check and the general (non-class) case |
| 16 | `arguments` object: real reified object, aliases named params (sloppy mode) | `arguments` (42,49) | 94 (O0) | [arguments-object.md](lowering/arguments-object.md) | ✅ single-version | `CreateArguments`-family opcode confirmed; mapped-arguments aliasing is a live `Store/LoadFromEnvironment` on the *same* slot the parameter uses | **Spec 23 written** (`arguments-form`) — it cites readability row `R10`, not this row, because `✅ single-version` fails PL-06; this row stays the lowering provenance
| 17 | Generators, v≤96: VM opcode-driven coroutine | `function*` (23,24,25,26) at v84/94/96 | 84, 94, 96 | [generators.md](lowering/generators.md) | ✅ verified | `StartGenerator`/`ResumeGenerator`/`SaveGenerator`/`CompleteGenerator`, exactly as PRIOR-ART §6.2 predicted. **Spec 25 written** (`docs/specs/passes/25-yield-async-recovery.md`, 2026-09-05): re-read at 84, 94 and 96 — the emitted idiom is identical at all three, and the row's `84,94` versions column is extended to 96 by that measurement | Rung `yield-recovery` **landed 2026-09-05** (spec 25), acyclic groups only.
| 18 | Generators, v≥97: `CreateGenerator` + compiler-lowered state machine | `function*` (23,24,25,26) at v98/99 | 98,99 | [generators.md](lowering/generators.md) | ✅ verified (shape); ✅ measured, T13 (resume-ABI integer codes) | **D9 shim boundary** — full account of the wrapper/body split, env slot roles, and what remains unpinned |
| 19 | Async/await: generator + builtin spawn helper | `async function` (27,28,29) | 94,98,99 | [async-await.md](lowering/async-await.md) | ✅ verified | v94: `CreateAsyncClosure` wraps an opcode-driven generator. v99: async body uses the *same* lowered state machine as v99 generators, run by an unnamed driver function. **Spec 25 written** (`docs/specs/passes/25-yield-async-recovery.md`, 2026-09-05): the decompiled driver is `__hbc_b_spawnAsync` at 84, 94, 96, 98 **and** 99 — the v99 `makeAsyncIterator` reading predates `patchHbc99Mar2026Builtins`, see PUSHBACK P-25 | Rung `async-recovery` **landed 2026-09-05** (spec 25); refuses at v>=97 with R-A4 until `gen-lowered` lands. Status raised from "single-version (94)" to verified by spec 25 §1.6, which re-measured fixtures 27/28 at **all five** committed versions and found one wrapper shape and one driver name (`__hbc_b_spawnAsync`) at every one of them; the T13 "98/99 driver protocol" reading of [async-await.md](lowering/async-await.md) §3/§6 predates `patchHbc99Mar2026Builtins` and is stale (PUSHBACK P-25). Asserted in `tests/gate/passes/async-recovery.test.ts`.
| 20 | Classes (v98 and v99): `CreateBaseClass`/`CreateDerivedClass` + `Constructor<N>`/`NCFunction<N>` | `class` (32,33,34,35,36) | 98, 99 | [classes.md](lowering/classes.md) | ✅ verified | Disassembler's own function-role prefixes (`Constructor<>`, `NCFunction<>`) map directly onto spec 03's function classification; instance fields run via a separate `<instance_members_initializer:N>` function called from the constructor's top (visible only at `-O0`; the committed `-O` fixtures have it inlined). **Upgraded to verified and extended to v98 by spec 24** (`docs/specs/passes/24-class-recover.md` §1.0, 2026-09-05): every class fixture has a committed `v98.hbc`, the v98 and v99 disassembly of `32-class-basic` is identical, and 32/33/34 decompile byte-identically at both versions (36 differs only in accessor function-table names, 35 only in register allocation). Spec 24 written. Private names (`#x` fields/methods/`in` brand checks, fixture 35) are a separate opcode family within the same row -- `CreatePrivateName`/`AddOwnPrivateBySym`/`Get`/`PutOwnPrivateBySym`/`PrivateIsIn` -- lowered by `src/emit/lower.ts`'s "private names" block to a symbol-keyed shape (`docs/BUGS.md` 2026-09-01 "class private fields"). **Rung `private-fields` (stage B), landed 2026-09-05**, folds that shape back into real `#name` syntax after `class-recover` builds the `class` node, one name at a time, refusing any name with a reference outside its four recognised shapes -- **and refusing whenever the install's own target does not resolve to literal `this`** (T2 equivalence caught the first landing writing a real private field onto a `new.target`/`Object.create` stand-in object, not the object the class's own construction protocol actually brands). **Rung `ctor-this` (row R12), landed 2026-09-05**, removes that stand-in in a base class, so `private-fields` now folds fixture 35's `#balance`/`#history` for real (T2 PASS at v99); `#record` (a private *method*) and `PrivateIsIn` still have no recognised shape and stay symbol-keyed. |
| 21 | Template literals: `HermesInternal.concat` call (untagged, ≥1 substitution) and `CallBuiltin getTemplateObject` + tag call (tagged) | template literals (43), tagged templates (44) | 94, 99 (`-O` and `-O0`) | [template-literals.md](lowering/template-literals.md) | ✅ verified | Earlier reading ("plain `Add` chain, nothing to raise") was wrong at every opt level — `concat` is ToString per piece, `+` is ToPrimitive, so the compiler never confuses them; measured 7/7/7/7 `concat` loads at v94/v99 × `-O`/`-O0`, 0 in the `+`-chain fixtures. **Pass `template-literal` (stage B), M5 — recovered** |
| 22 | Destructuring (array/object): iterator protocol + `undefined`-check defaults | destructuring (37,38,39) | 94,99 | [destructuring.md](lowering/destructuring.md) | ✅ verified | Array destructuring reuses idiom #10 verbatim; default values reuse the `StrictEq/Neq undefined` idiom also seen in #23/#24; v99 shape identical modulo register-copy cosmetics (destructuring.md §7) |
| 23 | Spread (array/call) and rest params | spread/rest (40,41,42) | 94, 99 | [spread-rest.md](lowering/spread-rest.md) | ✅ verified | Array spread reuses idiom #10; object spread lowers to `NewObject` + repeated `CallBuiltin` (version-dependent builtin index, behaves as `CopyDataProperties`); `src/emit` resolves the index to a version-uniform `__hbc_b_*` helper name before stage B, so the pass itself is version-uniform. **Pass `spread-rest` (stage B), M5 — recovered** |
| 24 | Default parameters: `undefined`-check, evaluated per-call | default params (39,51) | 94,99 | [default-params.md](lowering/default-params.md) | ✅ verified | Same `StrictEq/Neq undefined` idiom as destructuring defaults; stage-B AST is a labeled block per parameter with a tail `break`, not an if/else (docs/PUSHBACK.md P-8) |
| 25 | Optional chaining / nullish coalescing: loose `Eq null` short-circuit | `?.`/`??` (48) | 94, 99 | [optional-chaining.md](lowering/optional-chaining.md) | ✅ verified | Uses loose `Eq` against `LoadConstNull` (not two checks for `null`/`undefined` separately); same `Eq`/`JmpTrue` shape at v99, no opcode-table change |
| 26 | Logical assignment (`&&=`,`\|\|=`,`??=`) | `57-logical-assignment` | 84,94,96,98,99 | [logical-assignment.md](lowering/logical-assignment.md) | ✅ measured, T9 (fixture; `??=` is a loose `!= null` jump) | Compiles to an ordinary short-circuit branch around a plain store; not a new opcode |
| 27 | Obfuscated control-flow flattening vs. Hermes's own constant folding | `source.obf.js` variants (04,09,19 inspected) | 94 (O and O0) | [obfuscated-control-flow.md](lowering/obfuscated-control-flow.md) | ✅ verified (surprising negative result) | **Hermes's optimizer — and even its `-O0` front end — collapses javascript-obfuscator's `while(true){switch(ip){...}}` dispatcher back to linear code** whenever the dispatch index is compile-time-derivable. The hardened-tier CFG stress may not be stressing CFG recovery at all for short functions; see file and report |
| 28 | Object literal with non-constant values: `NewObject`/`NewObjectWithBuffer` + a run of own-property defines | `63-object-literal` (also 59-jsx-runtime-calls, RN template) | 94, 99 | [object-literal.md](lowering/object-literal.md) | ✅ verified | v94 emits `NewObject` + `PutNewOwnByIdShort`/`PutOwnByIndex`; v99 emits `NewObjectWithBuffer` (keys pre-declared in the shape table, values placeholders) + `PutOwnBySlotIdx`/`DefineOwnByIndex`/`DefineOwnById`. `PutById` is NOT part of the idiom — it is a full `[[Set]]`. **Pass `object-literal` (stage B), M5 — recovered** |
| 29 | Regex literal: `CreateRegExp dst, patternStrId, flagsStrId, tableIdx` — the source pattern text is in the string table, `regExpStorage` is never needed | regex literals (45), 49 `new RegExp` sites in the RN template | 94,96,98,99 (no v84 build: named groups) | [regex-literals.md](lowering/regex-literals.md) | ✅ verified | 6 `CreateRegExp` at each of the four versions, identical operands; the emitter prints `new RegExp("pat", "flags")` (`src/emit/literals.ts` `regExpExpr`). **Merged 2026-09-05** (`literal-forms`, sub-form L-R, `src/passes/literal-forms/`) |
| 30 | `typeof` comparison: `TypeOfIs` / `JmpTypeOfIs` with a `TypeOfIsTypes` bitset operand (9 bits, full mask 511; a `!==` test is the complement) | typeof-is masks (55), typeof/instanceof/in (47) | 98,99 (the only versions with the opcode; 94,96 read as the `TypeOf` + compare fallback) | [typeof-is-masks.md](lowering/typeof-is-masks.md) | ✅ verified | Bit order from the MIT Hermes `include/hermes/FrontEndDefs/Typeof.h`, vendored per pin into `src/tables/generated/typeofis-*.ts`; masks measured in fixture 55: 1,4,8,16,32,64,128,258,383,503,507. **Merged 2026-09-05** (`literal-forms`, sub-form L-T, `src/passes/literal-forms/`) |

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
| R5 | `var-naming` / `closure-naming` — replace `rN`/`_eN_M` with a recovered source name | any construct with locals or closures | 19-var-hoisting v94 | [07-var-naming.md](specs/passes/07-var-naming.md) | ✅ verified | Stage B; reads `ctx.module`. **`var-naming` merged** (2026-08-31, `src/passes/var-naming/`): heuristic better-naming of surviving `rN` registers only (there is no source name to recover — spec 07 scope note); `_eN_M` env slots remain `closure-naming`'s, unbuilt |
| R6 | `jsx-recover` — `React.createElement` / `jsx`/`jsxs` call trees back to JSX | JSX-producing bundles (RN template module_422/315), 59-jsx-runtime-calls | 59-jsx-runtime-calls v94/v99 | [08-jsx-recovery.md](specs/passes/08-jsx-recovery.md) | ✅ verified | Stage B, last; **opt-in (`--jsx`)**, never in the default pipeline (D20 §7). **Merged 2026-09-01** (`src/passes/jsx-recover/`) |
| R7 | `string-array-decode` — inline a decoded string-table lookup | obfuscated string arrays (`.obf` variants) | 19-var-hoisting v94 | [06-label-clean.md](specs/passes/06-label-clean.md) | ✅ verified | Stage B |
| R8 | `label-clean` — drop a structurer label nothing names any more | any loop/labeled-block whose label became dead after other rungs ran | 08-labeled-break-continue v94 | [06-label-clean.md](specs/passes/06-label-clean.md) | ✅ verified | Stage A. The ladder's own numbering originally pointed this rung at index row 5 (labelled break/continue), which is `✅ single-version` and so refused by `checkCatalogue` — this rung is IR hygiene (drop a now-unused `LabelId`), not a recognition of that idiom, hence its own `R8` row. Row 5's evidence link stays in this Notes cell for provenance: [labeled-break-continue.md](lowering/labeled-break-continue.md) |
| R9 | `reg-split` — split a reused register's disjoint live ranges into `rN`/`rN_2`/… variables | any function reusing a register for unrelated jobs (04-for-loop-basic's `r0`/`r11`) | 04-for-loop-basic v94 | [19-reg-split.md](specs/passes/19-reg-split.md) | ✅ verified | Stage B, immediately before `var-naming`. Spec 19 names catalogue row `R8`; `label-clean` already holds `R8`, so this rung is `R9` instead (noted in the spec's own file). **Landed `optIn: true`** (not the default pipeline yet) — see `src/passes/reg-split/index.ts`'s doc comment and `docs/PUSHBACK.md`: sound and 0-DIVERGENT on its five target fixtures, but the default-pipeline CPU ceiling (`pipeline-speed.test.ts` P-1) and ~10 other rungs' own `r\d+`-shaped test regexes need follow-up work before it can run by default |
| R10 | `arguments-form` — the emitter's `__hbc_arguments(arguments)` reification call back to a bare `arguments` where no parameter slot can alias | `42-rest-params`, `49-arguments-object`; 48 sites in the RN template | 49/42 at v84,94,96,98,99 | [23-arguments-form-literal-forms.md](specs/passes/23-arguments-form-literal-forms.md) | ✅ verified | Stage B, after `expr-rebuild` and `spread-rest`. Recognises emitter output, not a Hermes idiom, hence an `R` row — the lowering provenance is index row 16 ([arguments-object.md](lowering/arguments-object.md)), which is `✅ single-version` and so refused by `checkCatalogue`, exactly the `label-clean`/`R8` situation. **Merged 2026-09-05** (`src/passes/arguments-form/`) |
| R11 | `globalthis-dead-store` — drop the `rN = globalThis` store `global-access` (R2) leaves behind once its last guarded read has folded to a bare identifier | any global read `global-access` folds (19-var-hoisting's `demo`, rn-template module_1 fn#155) | 19-var-hoisting v94 | [03-global-access.md](specs/passes/03-global-access.md) | ✅ verified | Stage B, `after: ["expr-rebuild", "global-access"]`, `before: ["fn-naming", "reg-split", "var-naming"]` — must run before the renaming rungs so the register a deletion exposes as dead never gets named first (the `try-clean`/R8 pattern). Recognises `global-access`'s own residue, not a Hermes idiom, hence an `R` row. **Merged 2026-09-05** (`src/passes/globalthis-dead-store/`), fixes docs/BUGS.md's 2026-09-01 "`r0 = globalThis` dead store survives the global-access rewrite" row |
| R12 | `ctor-this` — a recovered BASE class constructor's `new.target.prototype` + `Object.create(...)` stand-in receiver back to the literal `this` | 34-class-static-members, 35-class-private-fields, 36-class-getters-setters (32/33 refuse: seeded allocation / derived class) | 34/35/36 at v98 and v99 | [26-ctor-this.md](specs/passes/26-ctor-this.md) | ✅ verified | Stage B, `after: ["class-recover"]`, `before: ["private-fields", "fn-naming", "reg-split", "var-naming"]`. Recognises the emitter's own lowering of `NewObjectWithParent` inside a constructor `class-recover` has already raised, not a Hermes idiom of its own, hence an `R` row — the lowering provenance is index row 20 (classes) and row 20a (`new`). **Merged 2026-09-05** (`src/passes/ctor-this/`); it is what makes `private-fields` fold on a real fixture at last (docs/BUGS.md 2026-09-01 "class private fields", reopened 2026-09-05 and closed by this landing) |

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
| `__hbc_argsLive` | which object a *lazy* `arguments` read goes through | `GetArgumentsPropByVal`, `GetArgumentsLength` | Their last operand is the lazy-arguments register: `undefined` until a `ReifyArguments*` materialises the object into it, the object itself after. Emitted only in a function that reifies; one that never does keeps the plain `arguments` form (docs/BUGS.md `arity/arguments-aliasing`, fixture `69-arguments-reify-readback`) |
| `__hbc_notIterable` | the "value not iterable" TypeError Hermes itself throws (measured on real interpreters, not V8/Node — see `docs/BUGS.md` `iterable-wording`) | shared by `__hbc_iterBegin` and `__hbc_b_arraySpread`, the two "value required to be iterable" throw sites | Only two texts, neither value-annotated: `Cannot convert null/undefined value to object` for `null`/`undefined`, `iterator method is not callable` for everything else lacking a callable `Symbol.iterator` — identical at every callsite, unlike V8's expression-text-dependent wording |
| `__hbc_iterBegin` | `IteratorBegin` | `IteratorBegin` | Returns `[iterator, next]`. Throws via `__hbc_notIterable`, matching the real Hermes VM's wording |
| `__hbc_iterNext` | `IteratorNext` | `IteratorNext` | Signals exhaustion by returning the iterator as `undefined`, which is how the opcode's register protocol works |
| `__hbc_iterClose` | `IteratorClose` | `IteratorClose` | The `ignoreInner` flag is the spec's `IteratorClose(…, true)`: it swallows a throw from `.return` itself, and only then |
| `__hbc_pnames` | `GetPNameList` | `GetPNameList` | `for…in` key snapshot, including inherited enumerables; `null`/`undefined` yields `undefined` (the "skip the loop" signal) |
| `__hbc_nextPName` | `GetNextPName` | `GetNextPName` | Skips keys deleted since the snapshot (`k in o`), boxes a primitive receiver |
| `__hbc_b_apply` | `CallBuiltin apply` | `CallBuiltin apply` | Arity is the signal: 3 arguments = `Reflect.apply`, 2 = `Reflect.construct` |
| `__hbc_b_applyWithNewTarget` | `CallBuiltin applyWithNewTarget` | same | `Reflect.construct(fn, args, newTarget)` — the prototype comes from `new.target` |
| `__hbc_b_arraySpread` | `CallBuiltin arraySpread` | `[...x]`, spread call arguments | Writes from `index` and returns the next index, so successive spreads compose. Throw text shares `__hbc_notIterable` with `__hbc_iterBegin` (previously a bare `"is not iterable"`, `docs/BUGS.md` `iterable-wording`) |
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
| `__hbc_b_setFunctionName` | `CallBuiltin setFunctionName` (v99 builtin 55) | ES `SetFunctionName` for a computed method/accessor name | Third argument is the prefix selector: 0 plain, 1 `get`, 2 `set`. Only the v99 compiler emits it; see `patchHbc99Mar2026Builtins` in tools/gen-tables/gen.ts |
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
