# Adversarial fixture corpus

Deliberately hard-to-decompile JavaScript code designed to stress-test and find bugs in the hbc2js decompiler. Each fixture exercises ONE nasty pattern. Per D22a, fixtures that diverge or error are regression tests for found bugs (in docs/BUGS.md) and remain here until fixed.

## Test status summary

- **Total fixtures**: 43
- **PASS through decompiler**: 40 at every compiled version (PASS-vs-VM, per D14/D22a — see the two triage notes below); `02-proxy-trap-counting`, once the one confirmed real bug, now PASSes at v94/v96/v99
- **DIVERGE (harness verdict)**: 3, all v99-only — `21-class-private-fields` (**confirmed real bug**, `src/emit`, reproducer `constructs/58-class-accessor-pair-split`), `20-symbol-keyed-properties` (**toolchain/harness artefact**: npm-hermesc-v99 vs source-built-VM-v99 builtin-table mismatch; decompiler agrees with the VM), and `43-fuzz-async-guard-shared-range` (**confirmed real bug, not yet root-caused**: candidate genuinely disagrees with the v99 Hermes VM's own trace — see docs/BUGS.md 2026-09-02, construct-fuzzer seed-base 777000 row). See "CONSOLIDATION 26 triage" below and the fuzz row above for `43`.
- **ERROR (decompiler threw)**: 0
- **SKIP (v94/v96 compile failure, v99 ok)**: 5 (class fixtures)

All fixtures are deterministic (no Math.random/Date/network) and output only via `print(...)`. Each has been compiled to `.hbc` with all compatible hermesc versions (v94, v96, v99; v84 and v98 not used for adversarial tier).

### 2026-08-31 triage (Claude Sonnet 5) — reference is the Hermes VM, not Node

A Haiku agent's first pass flagged 6 fixtures (02, 06, 28, 29, 30, 36) as DIVERGE/ERROR by comparing against **Node's** `expected.txt`. Per D14, that is the wrong reference for a fixture that runs under a real Hermes VM: the decompiler must reproduce what the *bytecode does under Hermes*, not what the source does under Node. Re-checked all 6 directly against `tools/hermes-vm/v94`, `tools/hermesc/v96/hermes`, and `tools/hermes-vm/v99`:

- **1 confirmed real bug (since resolved)**: `02-proxy-trap-counting` — decompiled output disagreed with the Hermes VM itself (not just Node), at v94/v96. **Stale as of CONSOLIDATION 26 (2026-08-31): it now PASSes at v94/v96/v99** through `runTier`, and the decompiled v94 candidate's output is byte-identical to `tools/hermes-vm/v94`'s own run (`has traps: 1`) — fixed as a side effect of an intervening commit, not bisected; see its `docs/BUGS.md` row.
- **5 false positives**: `06`, `28`, `29`, `30`, `36` all have the decompiled candidate matching the Hermes VM's own trace exactly; the apparent divergence in each case is either a genuine, already-known-class Hermes-vs-Node/spec difference (06, 30 — see `reference-policy.ts`'s `KNOWN_DIVERGENT_FIXTURES`), a broken `expected.txt` generated under the wrong module semantics (28, 29), or a harness comparison-method artifact unrelated to the decompiler (36). Full evidence for each in `docs/BUGS.md`.

Wiring the new `tests/sweep/adversarial/**` tier (running the real decompiler + the Hermes VM cross-check on all 42 fixtures, not just the 6) also surfaced two more divergences outside that original 6 — `20-symbol-keyed-properties` and `21-class-private-fields`, both v99-only — triaged below.

### CONSOLIDATION 26 triage (Claude Fable 5, 2026-08-31) — the two v99 findings

Both re-run through `runTier({tier:"adversarial", decompiler: hbc2jsDecompiler, only:[…]})` at v94/v96/v99 (20: PASS/PASS/DIVERGENT; 21: n/a/n/a/DIVERGENT), then localised by disassembly (`hbc2js disasm`), by the VM's own source (`tools/hermes-vm/src-99`), and by recompiling each `source.js` with the VM's *own* `hermesc` (same Hermes commit as the VM) to separate toolchain effects from decompiler effects:

- **`21-class-private-fields` → (a) real decompiler bug, `src/emit` stage.** Not private fields at all: Static Hermes (v98/v99) lowers a class getter/setter *pair* as two `DefineOwnGetterSetterByVal` instructions, each with the other half `undefined` (`v99.hbc` fn#0 `0039 … r8, r7, r9, r1, 0` getter / `0044 … r8, r7, r1, r6, 0` setter, r1 = `LoadConstUndefined`); the VM's `caseDefineOwnGetterSetterByVal` only sets the non-undefined half, but `src/emit/lower.ts` emits both halves as a full `Object.defineProperty(o, k, {get, set})`, so the setter's definition clobbers the getter with `undefined` — every later `c.value` read is `undefined` while the `#value` storage (read directly by `inc()`) is right. The VM's own hermesc emits the identical shape and the VM prints the right values, so this is the decompiler. Object-literal accessor pairs merge into one instruction at every version (probed v94/v99), so it is class-only, v98/v99-only. Minimal reproducer: `tests/fixtures/constructs/58-class-accessor-pair-split` (v98/v99). **Fixed** (consolidation item 3): `src/emit/lower.ts` omits the descriptor half whose register is a literal `undefined`; `docs/BUGS.md`.
- **`20-symbol-keyed-properties` → (b) oracle/harness artefact, not a decompiler bug against the available ground truth.** The fixture's `v99.hbc` comes from `tools/hermesc/v99/hermesc` (`hermes-compiler@260318099`, ≈2026-03-18) but `tools/hermes-vm/v99` is built from Hermes `913d31a` (2026-03-05); in between, Hermes added `HermesBuiltin.setFunctionName` at builtin index 55, emitted for every computed-key method (`{ [Symbol.iterator]() {} }`). The VM (and the decompiler's `HBC99_MAR2026` table, generated from the same `913d31a`) read index 55 as `functionPrototypeApply`, so **the VM itself crashes on the original bytecode** (`Can't apply() to non-callable` at `source.js:18:18`, the method definition — not the `for-of`) and the decompiler faithfully emits the same wrong call (`r1.apply(r2, 0)`), dying at the same site with the same error name. Recompiling `source.js` with the VM's own hermesc drops the `CallBuiltin` entirely and both `hermes source.js` and the resulting `.hbc` print `custom iterator: 1,2,3`. The harness still says DIVERGENT only because `ladder.ts`'s D14 cross-check never lets VM==candidate overrule a Node-vs-candidate divergence (Node prints `1,2,3`) unless the fixture is in `KNOWN_DIVERGENT_FIXTURES`. Wider consequence, documented in `docs/BUGS.md`: the same index shift moves every private builtin after 55 (`spawnAsync` etc.) by one under the npm v99 compiler, which is the real root cause of `reference-policy.ts`'s whole `VM_LIMITATIONS` table, and means any production RN "1000.x" bundle with a computed-key method decompiles to a throwing `.apply(...)`. Follow-ups (a post-03-18 v99 builtin table + `setFunctionName` emit, a matching VM rebuild, and the `ladder.ts` D14 override) are not in this task.

## By category

### Evaluation order (5 fixtures)

Getters, Proxies, argument and operator evaluation order with side effects.

| # | Name | Pattern | Status | Notes |
|---|---|---|---|---|
| 01 | getter-receiver-double-eval | Getter as receiver in a.b.c(x) — test no double-eval | PASS | v94, v96, v99 |
| 02 | proxy-trap-counting | Proxy get/set/has trap invocation counts | PASS | v94, v96, v99. Was a confirmed real bug (`'x' in proxy` has-trap statement dropped at v94/v96, confirmed against the VM); re-verified under CONSOLIDATION 26 (2026-08-31): `runTier` PASS at all three versions and the decompiled v94 output is byte-identical to the v94 VM's (`has traps: 1`). Fixed by an intervening commit, not bisected — docs/BUGS.md row updated |
| 03 | argument-eval-order | Function arguments evaluated left-to-right | PASS | v94, v96, v99 |
| 04 | comma-operator-sideeffect | Comma operator in condition and expression | PASS | v94, v96, v99 |
| 05 | shortcircuit-sideeffect | &&, \|\|, ?? short-circuit with side effects | PASS | v94, v96, v99 |

### Closures (4 fixtures)

Loop variables, nested closures, recursion, IIFE returns.

| # | Name | Pattern | Status | Notes |
|---|---|---|---|---|
| 06 | closure-loop-var-vs-let | var vs let in for loops — per-iteration bindings | PASS-vs-VM | Hermes shares one binding across let-loop iterations too (matches the known `18-closure-loop-let` divergence, `reference-policy.ts`); decompiled matches the VM at v94/v96/v99. Only Node's spec-correct expected.txt differs — D14 caveat, not a bug |
| 07 | nested-closures-mutation | Closures over shared mutable variable | PASS | v94, v96, v99 |
| 08 | recursive-closure | Recursive closure with state | PASS | v94, v96, v99 |
| 34 | iife-closure-return | IIFE returning closures + state | PASS | v94, v96, v99 |

### Control flow (4 fixtures)

Try/finally/catch edge cases, labeled breaks, switch fallthrough, loops.

| # | Name | Pattern | Status | Notes |
|---|---|---|---|---|
| 09 | finally-return-override | Finally block return overrides try | PASS | v94, v96, v99 |
| 10 | labeled-break-nested | Labeled break across nested loops | PASS | v94, v96, v99 |
| 11 | switch-fallthrough-default-mid | Switch with fallthrough and default mid-case | PASS | v94, v96, v99 |
| 12 | do-while-continue | Do-while with continue/break | PASS | v94, v96, v99 |
| 35 | loop-var-reassign | Loop body reassigns loop variable | PASS | v94, v96, v99 |
| 40 | finally-throw-override | Finally block throw overrides try error | PASS | v94, v96, v99 |

### Generators/async (4 fixtures)

Yield in finally, .return()/.throw(), yield*, Promise ordering.

| # | Name | Pattern | Status | Notes |
|---|---|---|---|---|
| 13 | generator-yield-finally | Yield inside try-finally | PASS | v94, v96, v99 |
| 14 | generator-return-throw | Generator .return() and .throw() | PASS | v94, v96, v99 |
| 15 | generator-yield-delegation | Yield* delegation | PASS | v94, v96, v99 |
| 16 | async-await-ordering | Promise microtask ordering | PASS | v94, v96, v99 |

### Values (4 fixtures)

BigInt, -0 vs 0, NaN, Symbol-keyed properties.

| # | Name | Pattern | Status | Notes |
|---|---|---|---|---|
| 17 | bigint-mixed-arithmetic | BigInt + Number operations | PASS | v94, v96, v99 |
| 18 | negative-zero-identity | -0 vs 0 (Object.is, 1/x) | PASS | v94, v96, v99 |
| 19 | nan-comparison-identity | NaN comparisons and Object.is | PASS | v94, v96, v99 |
| 20 | symbol-keyed-properties | Symbol-keyed properties and Symbol.iterator | PASS (v94, v96); **DIVERGE-artefact** (v99) | v99: **toolchain/harness artefact, not a decompiler bug** (CONSOLIDATION 26). `v99.hbc` (npm `hermes-compiler@260318099`) emits `CallBuiltin b55 "HermesBuiltin.setFunctionName"` for the computed `[Symbol.iterator]() {}` method; the source-built VM (`913d31a`, 2026-03-05, predates that builtin) and the decompiler's table both read b55 as `functionPrototypeApply`, so the VM crashes on the original bytecode (`Can't apply() to non-callable` at `source.js:18:18`) and the candidate crashes at the same site with the same error name (`r1.apply(r2, 0)`). Recompiled with the VM's own hermesc, VM and candidate both print `custom iterator: 1,2,3`. Stays DIVERGENT only because `ladder.ts` never lets VM==candidate overrule Node. Exposes a real builtin-table gap for post-03-18 v99 compilers (follow-ups in docs/BUGS.md) |

### OOP (4 fixtures)

Private fields/methods, static blocks, inheritance, super, instanceof.

| # | Name | Pattern | Status | Notes |
|---|---|---|---|---|
| 21 | class-private-fields | Class private #fields and #methods | **DIVERGE** (v99 only) | v94, v96: FAILS (class syntax unsupported). v99: **confirmed real bug, `src/emit/lower.ts`** (CONSOLIDATION 26) — not private fields: the class `get value`/`set value` pair is lowered as two `DefineOwnGetterSetterByVal` with the other half `undefined` (`0039`/`0044` in fn#0); the VM only sets the defined half (`caseDefineOwnGetterSetterByVal`), the emit's full `{get, set}` defineProperty clobbers the getter with `undefined`, so `c.value` reads `undefined` (VM `initial: 0`/`after set: 100`) while `#value` storage is right (`after inc: 1 2`/`final: 101` match). Same shape from the VM's own hermesc, so not toolchain. Minimal reproducer `constructs/58-class-accessor-pair-split` (v98/v99); **fixed** (consolidation item 3, `src/emit/lower.ts` omits the literal-`undefined` half; v99 now EQUIVALENT); docs/BUGS.md |
| 22 | class-static-block | Class static initializer blocks | PASS (v99 only) | v94, v96: FAILS; v99: OK |
| 23 | class-inheritance-super | Class inheritance with super | PASS (v99 only) | v94, v96: FAILS; v99: OK |
| 24 | class-expression-instanceof | Class expressions, instanceof chain | PASS (v99 only) | v94, v96: FAILS; v99: OK |

### Destructuring/spread (3 fixtures)

Defaults with side effects, array holes, spread with getters, rest params, swap.

| # | Name | Pattern | Status | Notes |
|---|---|---|---|---|
| 25 | destructuring-defaults-sideeffects | Nested destructuring with side-effect defaults | PASS | v94, v96, v99 |
| 26 | destructuring-array-holes | Array holes in destructuring | PASS | v94, v96, v99 |
| 27 | spread-with-getter | Spread operator with getters | PASS | v94, v96, v99 |
| 32 | rest-params-spread | Rest parameters in functions | PASS | v94, v96, v99 |
| 37 | swap-via-destructuring | Variable swap via destructuring | PASS | v94, v96, v99 |

### this/hoisting/TDZ (3+ fixtures)

Method extraction, call/apply/bind, var hoisting, let TDZ.

| # | Name | Pattern | Status | Notes |
|---|---|---|---|---|
| 28 | this-binding-extracted | Method extracted and called — this binding | PASS-vs-VM | Decompiled matches the Hermes VM *and* Node's real sloppy/CJS execution (`extracted: undefined-value`) at v94/v96/v99 — standard spec-conformant sloppy `this` substitution, not a Hermes divergence. expected.txt regenerated in script mode (CONSOLIDATION 24; it had been ESM-force-parsed by this repo's `package.json`, see docs/BUGS.md) and now agrees with both |
| 29 | var-hoisting-redeclaration | Var hoisting with same-name function | PASS-vs-VM | Decompiled matches the Hermes VM and Node's real CJS execution at v94/v96/v99 — no actual redeclaration conflict under sloppy/CJS semantics. expected.txt regenerated in script mode (CONSOLIDATION 24; it had been a spurious ESM `SyntaxError`, same root cause as 28, see docs/BUGS.md) and now agrees with both |
| 30 | tdz-shadowing | TDZ with shadowing in nested block | PASS-vs-VM | Hermes genuinely does not raise the TDZ ReferenceError for this shadowing shape (confirmed even under plain CJS Node, independent of 28/29's module-type issue) — decompiled matches the VM at v94/v96/v99. Only Node's spec-correct expected.txt differs — D14 caveat, not a bug |
| 31 | call-apply-bind | call, apply, bind manipulations | PASS | v94, v96, v99 |

### Miscellaneous patterns (5 fixtures)

Computed properties, for-in, optional chaining, nullish coalescing.

| # | Name | Pattern | Status | Notes |
|---|---|---|---|---|
| 33 | computed-property-sideeffect | Computed property names with side effects | PASS | v94, v96, v99 |
| 36 | optional-chaining-sideeffect | Optional chaining ?. with side effects | PASS-vs-VM | Decompiled functionally matches the Hermes VM at v94/v96/v99 (identical values, identical crash site/type — `null.method?.()` correctly throws). Apparent divergence was a harness cross-check artifact (print-only vs raw-stdout asymmetry for a crashing program, `src/harness/ladder.ts`), not a decompiler bug — fixed under CONSOLIDATION 25 (both sides now project print lines + `uncaught <Name>`; regression test `tests/gate/harness/ladder-uncaught.test.ts`), now a plain PASS — see docs/BUGS.md |
| 38 | for-in-enumeration | for-in enumeration order on object/array | PASS | v94, v96, v99 |
| 39 | getter-callee-position | Getter in function call callee position | PASS | v94, v96, v99 |
| 41 | nullish-coalescing-edge | Nullish coalescing ?? edge cases | PASS | v94, v96, v99 |
| 42 | destructuring-params-defaults | Destructuring in function params with defaults | PASS | v94, v96, v99 |

## Regression test status

Each fixture whose decompiled output genuinely diverges from the Hermes VM (D14/D22a) is a regression test for a bug documented in docs/BUGS.md. As of the 2026-08-31 triage:

- **21** → confirmed real bug (CONSOLIDATION 26): class getter/setter pair — the second half-`undefined` `DefineOwnGetterSetterByVal` clobbers the first in `src/emit/lower.ts` (v98/v99 class lowering only). Minimal reproducer `tests/fixtures/constructs/58-class-accessor-pair-split`; **fixed** in consolidation item 3 (`src/emit/lower.ts` omits the literal-`undefined` half)
- **20** → toolchain/harness artefact (CONSOLIDATION 26): npm-hermesc-v99 vs source-built-VM-v99 builtin-table mismatch (`HermesBuiltin.setFunctionName` at index 55); the VM itself crashes on the original bytecode and the decompiler matches it. Stays DIVERGENT at v99 until either the toolchain pair is realigned or `ladder.ts` lets VM==candidate overrule Node; the underlying v99 builtin-table gap has its own docs/BUGS.md follow-ups
- **02** → was a real bug (Proxy `has` trap statement dropped at v94/v96); no longer reproduces as of CONSOLIDATION 26 (PASS at v94/v96/v99, byte-identical to the v94 VM), fixed by an intervening commit, not bisected. Remains as a regression test

**06, 28, 29, 30, 36** were reclassified as false positives (D14 known-divergence or a fixture/harness artifact unrelated to the decompiler — see docs/BUGS.md and each fixture's own table row above) and are no longer bug regression tests; they still run every time as ordinary PASS-vs-VM checks under `tests/sweep/adversarial/report.test.ts`.

## Adding more fixtures

To add a new adversarial fixture:

1. Create `tests/fixtures/adversarial/NN-short-name/source.js` (self-contained, ~60 lines, deterministic, print()-only)
2. Run twice under Node to verify deterministic output
3. Save output: `node --input-type=commonjs -e "globalThis.print ??= (...a)=>console.log(...a.map(String)); $(cat source.js)" > expected.txt` — **use `--input-type=commonjs` explicitly** (or copy to a `.cjs` temp file and `require()` it). This repo's own `package.json` has `"type": "module"`, so a bare `require('./source.js')` force-parses the fixture as an ES module (always-strict `this`, block-scoped top-level function declarations) instead of the sloppy/CommonJS semantics Metro/Hermes actually compile RN bundles under — this exact mistake produced two wrong committed `expected.txt` files (28, 29) in the 2026-08-31 triage, see docs/BUGS.md. This only affects the *documentation* value of `expected.txt` for a human reader — the harness itself (`runOracleLadder`) never reads this file; it re-executes `source.js` directly in its own sandbox and, wherever a matching Hermes VM exists (v94/v96/v99 here), uses the VM's own trace as the reference (D14) — but a wrong `expected.txt` still misleads whoever eyeballs this directory by hand, so get it right. `tests/gate/harness/adversarial-expected.test.ts` enforces this on every gate run: it re-derives each fixture's expectation with exactly this recipe and fails on any ESM-loader frame in a committed `expected.txt`.
4. Add `licence.txt` (MIT, per D4)
5. Compile with `tools/hermesc/v{94,96,99}/hermesc -emit-binary` (from fixture dir)
6. Add to `versions.txt` if any version fails
7. Test decompiler: `node src/cli.ts vNN.hbc <out.js>` then run the output, compare to expected.txt **and, wherever a Hermes VM exists for that version, to `tools/hermes-vm/vNN/bin/hermes -b vNN.hbc` (or `tools/hermesc/vNN/hermes` for versions without a source-built VM, e.g. v96) directly** — per D14 the VM is ground truth, not Node/expected.txt; a mismatch against Node alone that agrees with the VM is not a bug, see the 2026-08-31 triage note above
8. If the decompiled output diverges from the **Hermes VM** (not just from expected.txt), record it in docs/BUGS.md and update this README

### 43-fuzz-async-guard-shared-range (added 2026-09-02, construct-fuzzer find)

`async function` declared alongside an `applyWithGuard`/`ErrorUtils`-shaped
`try`/`catch` with an identical-range handler pair (the same shape
`constructs/54-try-catch-finally-shared-range` documents at the single-handler
level). v99-only; v94 PASSes on the same minimised source. DIVERGE: the real
Hermes VM (v99) dies with a synchronous, pre-`await` uncaught `TypeError`
right after printing `inGuard settled at: 0` — merely from `guardedAwait`
being declared, before its promise chain ever runs — while the decompiled
candidate runs to completion under Node. Not root-caused (out of scope for
the triage task that landed it); see docs/BUGS.md's 2026-09-02 seed-base
777000 row for the minimisation trail (`tools/fuzz/minimise-live.mjs`).

## Compilation note

Classes are unsupported by v84/v94/v96 (`hermesc` IRGen limitation, fixed in v98/v99's Static Hermes). Fixtures 21-24 (class-*) compile only on v99. All other fixtures compile on v94, v96, v99.
