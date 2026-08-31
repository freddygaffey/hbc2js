# Adversarial fixture corpus

Deliberately hard-to-decompile JavaScript code designed to stress-test and find bugs in the hbc2js decompiler. Each fixture exercises ONE nasty pattern. Per D22a, fixtures that diverge or error are regression tests for found bugs (in docs/BUGS.md) and remain here until fixed.

## Test status summary

- **Total fixtures**: 42
- **PASS through decompiler**: 34 (PASS-vs-VM, per D14/D22a — see "2026-08-31 triage" below)
- **DIVERGE (bugs found, confirmed against the Hermes VM directly)**: 3
- **ERROR (decompiler threw)**: 0
- **SKIP (v94/v96 compile failure, v99 ok)**: 5 (class fixtures)

All fixtures are deterministic (no Math.random/Date/network) and output only via `print(...)`. Each has been compiled to `.hbc` with all compatible hermesc versions (v94, v96, v99; v84 and v98 not used for adversarial tier).

### 2026-08-31 triage (Claude Sonnet 5) — reference is the Hermes VM, not Node

A Haiku agent's first pass flagged 6 fixtures (02, 06, 28, 29, 30, 36) as DIVERGE/ERROR by comparing against **Node's** `expected.txt`. Per D14, that is the wrong reference for a fixture that runs under a real Hermes VM: the decompiler must reproduce what the *bytecode does under Hermes*, not what the source does under Node. Re-checked all 6 directly against `tools/hermes-vm/v94`, `tools/hermesc/v96/hermes`, and `tools/hermes-vm/v99`:

- **1 confirmed real bug**: `02-proxy-trap-counting` — decompiled output disagrees with the Hermes VM itself (not just Node), at v94/v96.
- **5 false positives**: `06`, `28`, `29`, `30`, `36` all have the decompiled candidate matching the Hermes VM's own trace exactly; the apparent divergence in each case is either a genuine, already-known-class Hermes-vs-Node/spec difference (06, 30 — see `reference-policy.ts`'s `KNOWN_DIVERGENT_FIXTURES`), a broken `expected.txt` generated under the wrong module semantics (28, 29), or a harness comparison-method artifact unrelated to the decompiler (36). Full evidence for each in `docs/BUGS.md`.

Wiring the new `tests/sweep/adversarial/**` tier (running the real decompiler + the Hermes VM cross-check on all 42 fixtures, not just the 6) also surfaced two more divergences outside that original 6, **not yet triaged with the same rigor** — `20-symbol-keyed-properties` (v99, root cause undetermined) and `21-class-private-fields` (v99, looks like a real bug) — see their own `docs/BUGS.md` rows.

## By category

### Evaluation order (5 fixtures)

Getters, Proxies, argument and operator evaluation order with side effects.

| # | Name | Pattern | Status | Notes |
|---|---|---|---|---|
| 01 | getter-receiver-double-eval | Getter as receiver in a.b.c(x) — test no double-eval | PASS | v94, v96, v99 |
| 02 | proxy-trap-counting | Proxy get/set/has trap invocation counts | **DIVERGE** | `'x' in proxy` (has-trap statement) dropped entirely at v94/v96 — confirmed against the Hermes VM directly, not just Node; v99 is correct. Real bug, docs/BUGS.md |
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
| 20 | symbol-keyed-properties | Symbol-keyed properties and Symbol.iterator | PASS (v94, v96); **DIVERGE** (v99) | v99: VM and decompiled candidate both crash at the same custom-`Symbol.iterator` `for-of` call site with matching preceding output but different native error text — root cause undetermined (surfaced by the new adversarial sweep tier, not part of the 2026-08-31 6-fixture triage), see docs/BUGS.md |

### OOP (4 fixtures)

Private fields/methods, static blocks, inheritance, super, instanceof.

| # | Name | Pattern | Status | Notes |
|---|---|---|---|---|
| 21 | class-private-fields | Class private #fields and #methods | **DIVERGE** (v99 only) | v94, v96: FAILS (class syntax unsupported). v99: VM prints `initial: 0`/`after set: 100`, decompiled prints `undefined`/`undefined` for the same reads (final value matches, so storage is right but a read path is wrong) — likely a real bug, surfaced by the new adversarial sweep tier, not part of the 2026-08-31 6-fixture triage; see docs/BUGS.md |
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
| 36 | optional-chaining-sideeffect | Optional chaining ?. with side effects | PASS-vs-VM | Decompiled functionally matches the Hermes VM at v94/v96/v99 (identical values, identical crash site/type — `null.method?.()` correctly throws). Apparent divergence was a harness cross-check artifact (print-only vs raw-stdout asymmetry for a crashing program, `src/harness/ladder.ts`), not a decompiler bug — see docs/BUGS.md |
| 38 | for-in-enumeration | for-in enumeration order on object/array | PASS | v94, v96, v99 |
| 39 | getter-callee-position | Getter in function call callee position | PASS | v94, v96, v99 |
| 41 | nullish-coalescing-edge | Nullish coalescing ?? edge cases | PASS | v94, v96, v99 |
| 42 | destructuring-params-defaults | Destructuring in function params with defaults | PASS | v94, v96, v99 |

## Regression test status

Each fixture whose decompiled output genuinely diverges from the Hermes VM (D14/D22a) is a regression test for a bug documented in docs/BUGS.md. As of the 2026-08-31 triage:

- **02** → real bug: Proxy `has` trap statement dropped entirely (v94/v96; v99 correct)
- **20** → open, root cause undetermined (v99; found while wiring the sweep tier, not part of the 6-fixture triage)
- **21** → likely real bug: private-field read returns `undefined` instead of the stored value (v99; found while wiring the sweep tier)

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

## Compilation note

Classes are unsupported by v84/v94/v96 (`hermesc` IRGen limitation, fixed in v98/v99's Static Hermes). Fixtures 21-24 (class-*) compile only on v99. All other fixtures compile on v94, v96, v99.
