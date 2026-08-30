# Adversarial fixture corpus

Deliberately hard-to-decompile JavaScript code designed to stress-test and find bugs in the hbc2js decompiler. Each fixture exercises ONE nasty pattern. Per D22a, fixtures that diverge or error are regression tests for found bugs (in docs/BUGS.md) and remain here until fixed.

## Test status summary

- **Total fixtures**: 42
- **PASS through decompiler**: 31
- **DIVERGE (bugs found)**: 5
- **ERROR (decompiler threw)**: 1
- **SKIP (v94/v96 compile failure, v99 ok)**: 5 (class fixtures)

All fixtures are deterministic (no Math.random/Date/network) and output only via `print(...)`. Each has been compiled to `.hbc` with all compatible hermesc versions (v94, v96, v99; v84 and v98 not used for adversarial tier).

## By category

### Evaluation order (5 fixtures)

Getters, Proxies, argument and operator evaluation order with side effects.

| # | Name | Pattern | Status | Notes |
|---|---|---|---|---|
| 01 | getter-receiver-double-eval | Getter as receiver in a.b.c(x) — test no double-eval | PASS | v94, v96, v99 |
| 02 | proxy-trap-counting | Proxy get/set/has trap invocation counts | **DIVERGE** | `'x' in proxy` doesn't call has trap; v94 only tested |
| 03 | argument-eval-order | Function arguments evaluated left-to-right | PASS | v94, v96, v99 |
| 04 | comma-operator-sideeffect | Comma operator in condition and expression | PASS | v94, v96, v99 |
| 05 | shortcircuit-sideeffect | &&, \|\|, ?? short-circuit with side effects | PASS | v94, v96, v99 |

### Closures (4 fixtures)

Loop variables, nested closures, recursion, IIFE returns.

| # | Name | Pattern | Status | Notes |
|---|---|---|---|---|
| 06 | closure-loop-var-vs-let | var vs let in for loops — per-iteration bindings | **DIVERGE** | Let closures capture final value like var; v94 only |
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
| 20 | symbol-keyed-properties | Symbol-keyed properties and Symbol.iterator | PASS | v94, v96, v99 |

### OOP (4 fixtures)

Private fields/methods, static blocks, inheritance, super, instanceof.

| # | Name | Pattern | Status | Notes |
|---|---|---|---|---|
| 21 | class-private-fields | Class private #fields and #methods | PASS (v99 only) | v94, v96: FAILS (class syntax unsupported); v99: OK |
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
| 28 | this-binding-extracted | Method extracted and called — this binding | **DIVERGE** | Should error or get undefined-this; v94 only |
| 29 | var-hoisting-redeclaration | Var hoisting with same-name function | **DIVERGE** | Hoisting order mismatch; v94 only |
| 30 | tdz-shadowing | TDZ with shadowing in nested block | **DIVERGE** | Should throw ReferenceError; v94 only |
| 31 | call-apply-bind | call, apply, bind manipulations | PASS | v94, v96, v99 |

### Miscellaneous patterns (5 fixtures)

Computed properties, for-in, optional chaining, nullish coalescing.

| # | Name | Pattern | Status | Notes |
|---|---|---|---|---|
| 33 | computed-property-sideeffect | Computed property names with side effects | PASS | v94, v96, v99 |
| 36 | optional-chaining-sideeffect | Optional chaining ?. with side effects | **ERROR** | Decompiled code throws; v94 only |
| 38 | for-in-enumeration | for-in enumeration order on object/array | PASS | v94, v96, v99 |
| 39 | getter-callee-position | Getter in function call callee position | PASS | v94, v96, v99 |
| 41 | nullish-coalescing-edge | Nullish coalescing ?? edge cases | PASS | v94, v96, v99 |
| 42 | destructuring-params-defaults | Destructuring in function params with defaults | PASS | v94, v96, v99 |

## Regression test status

Each DIVERGE or ERROR fixture is now a regression test for a bug documented in docs/BUGS.md:

- **02** → Proxy has trap not called
- **06** → for-let closure capture bug
- **28** → this binding extraction
- **29** → var hoisting redeclaration
- **30** → TDZ shadowing
- **36** → optional chaining side effect error

## Adding more fixtures

To add a new adversarial fixture:

1. Create `tests/fixtures/adversarial/NN-short-name/source.js` (self-contained, ~60 lines, deterministic, print()-only)
2. Run twice under Node to verify deterministic output
3. Save output: `node -e "globalThis.print ??= (...a)=>console.log(...a.map(String)); require('./source.js')" > expected.txt`
4. Add `licence.txt` (MIT, per D4)
5. Compile with `tools/hermesc/v{94,96,99}/hermesc -emit-binary` (from fixture dir)
6. Add to `versions.txt` if any version fails
7. Test decompiler: `node src/cli.ts vNN.hbc <out.js>` then run the output, compare to expected.txt
8. If diverge/error found, record in docs/BUGS.md and update this README

## Compilation note

Classes are unsupported by v84/v94/v96 (`hermesc` IRGen limitation, fixed in v98/v99's Static Hermes). Fixtures 21-24 (class-*) compile only on v99. All other fixtures compile on v94, v96, v99.
