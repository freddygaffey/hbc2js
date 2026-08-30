# The lowering catalogue (D12, spec 07 §3)

Empirical record of what `hermesc` actually emits for each source construct in
`tests/fixtures/constructs/`, at HBC versions 84, 94, 98, 99 (and 96 where a
divergence was suspected — none was found for the idioms below). Produced for
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
| 2 | Pre-test + post-test loop rotation | `while` (02) | 94,99 (O0); 94 (O) | [while-loop.md](lowering/while-loop.md) | ✅ verified | Condition is evaluated **twice**: once as a guard before the loop, once as the back-edge test |
| 3 | Body + single trailing test | `do...while` (03) | 94,99 (O0) | [do-while-loop.md](lowering/do-while-loop.md) | ✅ verified | No pre-test at all; dead `while(false)` condition is *not* eliminated, even at default `-O` |
| 4 | `for` = `while` + hoisted init, update folded into body tail | `for` (04) | 94 (O0) | [for-loop.md](lowering/for-loop.md) | ✅ single-version | Comma-operator init/update confirmed as ordinary sequential instructions, not a special form |
| 5 | Labelled break/continue as reach, not marking | labelled break/continue (08) | 94 (O0) | [labeled-break-continue.md](lowering/labeled-break-continue.md) | ✅ single-version | `break outer`/`continue search` are **plain `Jmp`/conditional jump** whose target is the outer loop's exit/update block; no distinct opcode or flag |
| 6 | Switch: `JStrictEqual(Long)` compare chain | sparse/small/string switch (09,10) | 84,94,99 | [switch.md](lowering/switch.md) | ✅ verified | v84/94/99 all use compare chain for <~20 string cases |
| 7 | Switch: `SwitchImm`/`UIntSwitchImm` dense table | dense int switch (52,53) | 84,94,98,99 | [switch.md](lowering/switch.md) | ✅ verified | Renamed `SwitchImm`→`UIntSwitchImm` at v99 but operand shape (`Reg8,tableOffset,defaultTarget,min,max`) is identical |
| 8 | Switch: `StringSwitchImm` | dense string switch (≥~20 cases, no fixture) | 84,94,98,99 (ad hoc probe) | [switch.md](lowering/switch.md) | ⛔ inferred (no fixture; see O-3) | Threshold is **v98, not just v99** — corrects spec 07 §4's "v99" claim |
| 9 | `for...in`: `GetPNameList`/`GetNextPName`/`JmpUndefined` | `for...in` (05) | 94 | [for-in.md](lowering/for-in.md) | ✅ single-version | **Resolves spec 03/07's open question** — the opcode family is exactly as predicted |
| 10 | `for...of`: `IteratorBegin`/`IteratorNext`/`IteratorClose` | `for...of`, array destructuring, spread (06,07,37) | 94 | [for-of.md](lowering/for-of.md) | ✅ single-version | Same three opcodes power `for...of`, array destructuring, and (see #17) array spread |
| 11 | `try`/`catch`: handler-table region + `Catch` leader | try/catch (12,14,15) | 94,99 (O0) | [try-catch.md](lowering/try-catch.md) | ✅ verified | Optional catch binding (`catch {}`) simply omits the `StoreToEnvironment`/local bind after `Catch` |
| 12 | `finally`: duplicated into normal path + synthesized catch-rethrow | try/finally (12,13,16) | 94,99 (O0) | [try-finally-dedup.md](lowering/try-finally-dedup.md) | ✅ verified | `continue`/`break` inside `finally` **never reach** the synthesized `Throw`; they jump straight to the loop's continue/break target, which is *how* the pending exception gets silently dropped |
| 13 | Closures: one flat `CreateEnvironment` per function, `Load/StoreToEnvironment` by slot | closures (17,18,21,22) | 94,99 | [closures-env-slots.md](lowering/closures-env-slots.md) | ✅ verified | See #14 for the `var`-vs-`let` loop divergence this exposes |
| 14 | **D14**: `for (let ...)` closures share ONE binding — no per-iteration environment | closure-loop-let (18) vs closure-loop-var (17) | 84 (executed), 94/99 (bytecode shape) | [closures-env-slots.md](lowering/closures-env-slots.md) | ✅ verified (v84 execution), ✅ single-version (v94/99 shape) | **Major surprise** — see report. Hermes's `let` in a `for` loop behaves exactly like `var`; this contradicts spec/Node and is *not* an edge case, it's the common "closures in a loop" pattern |
| 15 | **D14**: TDZ is not enforced by a runtime check | let/const TDZ (20) | 84 (executed), 94 (bytecode) | [tdz.md](lowering/tdz.md) | ✅ verified (partial) | `let` is pre-initialized to `undefined` at `CreateEnvironment` time exactly like hoisted `var`; the "TDZ throw" the fixture observes comes from a **different** mechanism (see file) and shadowing inside a block can alias the outer slot |
| 16 | `arguments` object: real reified object, aliases named params (sloppy mode) | `arguments` (42,49) | 94 (O0) | [arguments-object.md](lowering/arguments-object.md) | ✅ single-version | `CreateArguments`-family opcode confirmed; mapped-arguments aliasing is a live `Store/LoadFromEnvironment` on the *same* slot the parameter uses |
| 17 | Generators, v≤96: VM opcode-driven coroutine | `function*` (23,24,25,26) at v84/94 | 84,94 | [generators.md](lowering/generators.md) | ✅ verified | `StartGenerator`/`ResumeGenerator`/`SaveGenerator`/`CompleteGenerator`, exactly as PRIOR-ART §6.2 predicted |
| 18 | Generators, v≥97: `CreateGenerator` + compiler-lowered state machine | `function*` (23,24,25,26) at v98/99 | 98,99 | [generators.md](lowering/generators.md) | ✅ verified (shape); ⛔ inferred (exact resume-ABI integer codes) | **D9 shim boundary** — full account of the wrapper/body split, env slot roles, and what remains unpinned |
| 19 | Async/await: generator + builtin spawn helper | `async function` (27,28,29) | 94,99 | [async-await.md](lowering/async-await.md) | ✅ single-version (94); ⛔ inferred (99 driver protocol) | v94: `CreateAsyncClosure` wraps an opcode-driven generator. v99: async body uses the *same* lowered state machine as v99 generators, run by an unnamed driver function |
| 20 | Classes (v99 only): `CreateBaseClass`/`CreateDerivedClass` + `Constructor<N>`/`NCFunction<N>` | `class` (32,33,34,35,36) | 99 | [classes.md](lowering/classes.md) | ✅ single-version | Disassembler's own function-role prefixes (`Constructor<>`, `NCFunction<>`) map directly onto spec 03's function classification; instance fields run via a separate `<instance_members_initializer:N>` function called from the constructor's top |
| 21 | Template literals: plain string concatenation, no dedicated opcode | template literals (43) | 94 | [template-literals.md](lowering/template-literals.md) | ✅ single-version | Confirmed *not* a distinct bytecode idiom — nothing for a pass to "raise" beyond ordinary `Add`/`AddS` folding |
| 22 | Destructuring (array/object): iterator protocol + `undefined`-check defaults | destructuring (37,38,39) | 94 | [destructuring.md](lowering/destructuring.md) | ✅ single-version | Array destructuring reuses idiom #10 verbatim; default values reuse the `StrictEq/Neq undefined` idiom also seen in #23/#24 |
| 23 | Spread (array/call) and rest params | spread/rest (40,41,42) | 94 | [spread-rest.md](lowering/spread-rest.md) | ✅ single-version | Array spread reuses idiom #10; object spread lowers to `NewObject` + repeated `CallBuiltin` (version-dependent builtin index, behaves as `CopyDataProperties`) |
| 24 | Default parameters: `undefined`-check, evaluated per-call | default params (39,51) | 94 | [default-params.md](lowering/default-params.md) | ✅ single-version | Same `StrictEq/Neq undefined` idiom as destructuring defaults — one matcher can plausibly serve both |
| 25 | Optional chaining / nullish coalescing: loose `Eq null` short-circuit | `?.`/`??` (48) | 94 | [optional-chaining.md](lowering/optional-chaining.md) | ✅ single-version | Uses loose `Eq` against `LoadConstNull` (not two checks for `null`/`undefined` separately) |
| 26 | Logical assignment (`&&=`,`\|\|=`,`??=`) | none — no fixture | 94,99 (ad hoc probe) | [logical-assignment.md](lowering/logical-assignment.md) | ⛔ inferred (no fixture; analogous to O-3) | Compiles to an ordinary short-circuit branch around a plain store; not a new opcode |
| 27 | Obfuscated control-flow flattening vs. Hermes's own constant folding | `source.obf.js` variants (04,09,19 inspected) | 94 (O and O0) | [obfuscated-control-flow.md](lowering/obfuscated-control-flow.md) | ✅ verified (surprising negative result) | **Hermes's optimizer — and even its `-O0` front end — collapses javascript-obfuscator's `while(true){switch(ip){...}}` dispatcher back to linear code** whenever the dispatch index is compile-time-derivable. The hardened-tier CFG stress may not be stressing CFG recovery at all for short functions; see file and report |

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
