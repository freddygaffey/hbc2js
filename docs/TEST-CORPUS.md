# Test corpus for hbc2js

This document identifies the test corpus for the decompiler, per `SPEC.md` §"Test suite" and
`docs/DECISIONS.md` D2 (execution-trace equivalence) and D3 (round-trip recompilation). It is a
research/planning artifact — no fixtures are added here; implementation agents populate
`tests/fixtures/` from these sources following the layout in `docs/AGENT-WORKFLOW.md`
(`tests/fixtures/<name>/{source.js,vNN.hbc,licence.txt}`).

Two tiers, matching the two correctness oracles:

- **Tier 1** (this doc §1) — pure-JS programs with no RN/host dependency, executed directly in
  Node for D2's sandboxed execution-trace equivalence.
- **Tier 2** (this doc §2) — real RN/Expo app bundles for D3's round-trip recompilation
  (decompile → `hermesc` → disassemble → structural diff), since these bundles depend on the RN
  host and cannot run standalone in Node.

All Tier 1 and Tier 2 sources must carry a licence compatible with D4 (MIT/Apache-2.0/BSD/ISC).
Every fixture directory records its source licence in `licence.txt`.

---

## 1. Tier 1 — pure-JS deterministic programs (D2)

### 1a. Hand-written construct fixtures (to be authored)

30–60 small, self-contained programs, each isolating one language construct so that a failure
in trace equivalence points at a specific decompiler weakness rather than a tangle of features.
Each file should be short (10–40 lines), deterministic under the D2 sandbox (seeded
`Math.random`, frozen `Date.now`, stubbed `print`/`alert`/`console.*` appending to the trace),
and print/return enough observable state to make its behaviour distinguishing. Implementation
agents write the actual `.js` files later; this table is the spec for what to write.

Proposed location: `tests/fixtures/constructs/<NN-topic>.js` (own licence.txt: original work,
MIT, written for this project).

| # | Filename | Construct covered |
|---|---|---|
| 01 | `01-if-else-chain.js` | Multi-branch `if/else if/else` chains with side-effecting conditions |
| 02 | `02-while-loop.js` | `while` loop with an internal `break` on a computed condition |
| 03 | `03-do-while-loop.js` | `do/while` executing its body at least once before the test fails |
| 04 | `04-for-loop-basic.js` | Classic `for` with multiple init/update expressions (comma operator) |
| 05 | `05-for-in-object.js` | `for...in` over an object with own and inherited enumerable keys |
| 06 | `06-for-of-array.js` | `for...of` over a plain array, including early `break` |
| 07 | `07-for-of-iterable.js` | `for...of` over `Map`, `Set`, and a hand-rolled `[Symbol.iterator]` object |
| 08 | `08-labeled-break-continue.js` | Labeled `break`/`continue` escaping nested loops |
| 09 | `09-switch-fallthrough.js` | `switch` with intentional fallthrough and a `default` in the middle |
| 10 | `10-switch-no-fallthrough.js` | `switch` where every case `break`s, plus a `return` inside a case |
| 11 | `11-nested-loops-mixed.js` | `for` inside `while` inside `do/while`, mixed control flow |
| 12 | `12-try-catch-finally-return.js` | `finally` containing a `return` that overrides the `try`/`catch` return value |
| 13 | `13-try-finally-no-catch.js` | `try/finally` with no `catch`; exception propagates through `finally` |
| 14 | `14-nested-try-catch.js` | Nested `try/catch` with rethrow and outer catch inspecting `error.cause`-like chaining |
| 15 | `15-catch-without-binding.js` | Optional catch binding (`catch {}`, ES2019) |
| 16 | `16-finally-with-break-continue.js` | `break`/`continue` inside `finally` inside a loop (suppresses the pending exception) |
| 17 | `17-closure-loop-var.js` | Classic `var`-in-loop closure bug: all closures observe the final loop value |
| 18 | `18-closure-loop-let.js` | `let`-in-loop per-iteration binding: each closure captures its own value |
| 19 | `19-var-hoisting.js` | `var` hoisting across nested blocks/functions, including redeclaration |
| 20 | `20-let-const-tdz.js` | Temporal dead zone: referencing `let`/`const` before declaration throws |
| 21 | `21-iife-closures.js` | IIFE module pattern exposing a closure-private counter |
| 22 | `22-nested-closures-counters.js` | Closures returning closures (counter/accumulator factories) |
| 23 | `23-generator-basic.js` | `function*` yielding a fixed sequence, consumed with manual `.next()` |
| 24 | `24-generator-return-throw.js` | Generator `.return()` and `.throw()` interaction with `try/finally` inside the generator |
| 25 | `25-generator-delegation.js` | `yield*` delegating to another generator/iterable |
| 26 | `26-infinite-generator-take.js` | Infinite generator consumed lazily with an early `break` |
| 27 | `27-async-await-basic.js` | `async function` with sequential `await`s and a returned value |
| 28 | `28-async-await-error.js` | `try/catch` around a rejecting `await`, plus an unhandled rejection path |
| 29 | `29-promise-chaining.js` | Equivalent `.then/.catch` chain vs. `async/await`, same observable order |
| 30 | `30-async-generator.js` | `async function*` consumed with `for await...of` |
| 31 | `31-microtask-ordering.js` | Interleaved `Promise.resolve().then()` and `queueMicrotask` ordering |
| 32 | `32-class-basic.js` | `class` with constructor, instance fields, and instance methods |
| 33 | `33-class-inheritance-super.js` | `extends` with `super()` in the constructor and `super.method()` calls |
| 34 | `34-class-static-members.js` | Static methods, static properties, and static initializer blocks |
| 35 | `35-class-private-fields.js` | `#private` fields and private methods, including `in`-based brand checks |
| 36 | `36-class-getters-setters.js` | `get`/`set` accessors on both a plain object literal and a class |
| 37 | `37-destructuring-array.js` | Array destructuring with defaults, elisions/holes, and rest |
| 38 | `38-destructuring-object.js` | Object destructuring with renaming, nested patterns, and defaults |
| 39 | `39-destructuring-params.js` | Destructured function parameters with defaults evaluated per-call |
| 40 | `40-spread-array.js` | Spread in array literals and in function call argument lists |
| 41 | `41-spread-object.js` | Object spread merging with later-key-wins override semantics |
| 42 | `42-rest-params.js` | Rest parameters alongside the (non-strict) `arguments` object |
| 43 | `43-template-literals.js` | Multi-line template literals with embedded expressions and nesting |
| 44 | `44-tagged-templates.js` | Tagged template function receiving cooked strings, `.raw`, and substitutions |
| 45 | `45-regex-literals.js` | Regex literals with flags, named capture groups, `.exec`/`.test`, and `String.replace` |
| 46 | `46-bigint-arithmetic.js` | `BigInt` arithmetic, comparisons, and the `TypeError` from mixing with `Number` |
| 47 | `47-typeof-instanceof-in.js` | `typeof` on undeclared bindings, `instanceof` across the prototype chain, `in` |
| 48 | `48-optional-chaining-nullish.js` | Optional chaining (`?.`, `?.()`, `?.[]`) combined with `??` |
| 49 | `49-arguments-object.js` | Non-strict `arguments` aliasing named parameters; `arguments.length` vs. declared arity |
| 50 | `50-this-binding.js` | `this` in a plain function, arrow function, method, and via `call`/`apply`/`bind` |
| 51 | `51-default-params.js` | Default parameters referencing earlier parameters, evaluated lazily per-call |

Notes for whoever implements this list:
- Every file's expected trace should be captured once (by running the *source* through the D2
  sandbox) and stored alongside it — the file itself is the ground truth, not a hand-written
  "expected output" comment, so authors don't need to predict output by hand.
- Constructs that Hermes lowers away entirely before bytecode (classes → prototype chains and
  `_classCallCheck`-style guards, generators → state machines, `async`/`await` → generator +
  promise glue) are exactly the ones most likely to break a naive structurer — do not skip them
  as "not really bytecode-level features."
- A few files should deliberately combine two constructs from the list (e.g. generator +
  try/finally, closure + destructured loop variable) once the single-construct set is green;
  that combinatorial layer isn't enumerated here, it's a follow-on once M4 fixtures pass.

### 1b. Existing permissively-licensed JS test/snippet corpora

| Corpus | Licence | Suitability | How to harvest |
|---|---|---|---|
| **Hermes's own `test/hermes/*.js`** (facebook/hermes, `test/hermes/`) | MIT | **High** — written specifically for Hermes, so every construct they exercise is guaranteed to compile through `hermesc` without hitting an unsupported-syntax wall. Format confirmed by inspection: LLVM-lit style, header comment block with `RUN: %hermes -O -target=HBC %s \| %FileCheck --match-full-lines %s` (plus `-lazy`, `-non-strict` variants per file) and `// CHECK:`/`// CHECK-NEXT:` comments pinning exact expected stdout lines in source order. E.g. `test/hermes/async-function.js` documents expected microtask-tick ordering entirely in `CHECK` comments. This means expected output is already encoded per-file — no manual "run source, capture trace" step needed for these. Covers generators, async/await, BigInt, Proxy, TypedArray, `Intl`, debugger statements, deep recursion, and Hermes-specific behaviour (`HermesInternal.*`). | Clone (shallow, sparse-checkout `test/hermes/`) or fetch individual files via raw GitHub URLs; strip the `RUN:`/`CHECK` lit directives and re-derive expected output by (a) parsing the `CHECK`/`CHECK-NEXT` lines directly since they already are the expected stdout, or (b) running the file under Node with the D2 sandbox shims for anything not lit-specific (some files call `print`, which Node lacks — already stubbed by D2). Filter out files needing `HermesInternal` or other non-standard globals unless the decompiler project decides to stub those too; keep a text file recording which subset was included and why. |
| **test262** (tc39/test262) | BSD-3-Clause (confirmed: repo `LICENSE` is the 3-clause BSD "Software License and Grant of Patent" text) | **Medium** — this is a *conformance* suite (does the engine implement the spec correctly), not a curated "one file, one program, deterministic trace" corpus. Most tests are tiny assertions (`assert.sameValue(...)`) rather than full programs with rich control flow, and many require the shared `harness/*.js` includes (`assert.js`, `sta.js`, `propertyHelper.js`, etc.) to be concatenated in. Still useful as a *breadth* net for edge-case semantics (ASI, `with`, getter/setter edge cases, `Symbol` well-knowns) that the hand-written list won't think to cover, and for regression-testing the emitter's ES2022 output against `node --check`. Avoid `test262/test/staging` (proposal-stage, may not be supported by the Hermes/Babel toolchain used to produce fixtures) and anything tagged `[negative]` unless the harness explicitly models "should throw." | Shallow clone or sparse-checkout `test/language/` and `test/built-ins/`; select a curated subset (a few hundred files, not the full ~40k) covering the construct list in 1a plus a few spec edge cases; concatenate required `includes:` harness files per test262's own frontmatter metadata comment. |
| **QuickJS test suite** (`bellard/quickjs` or the actively-maintained `quickjs-ng/quickjs` fork, directory `tests/`) | MIT | **Medium-high** — files like `test_closure.js`, `test_loop.js`, `test_op.js`, `test_builtin.js`, `test_bignum.js` are full programs (not spec-conformance micro-assertions) written with a small `assert()`/`assert_throws()` helper, close in spirit to the hand-written 1a list (closures, loops, operators, BigInt). `quickjs-ng` is the actively maintained fork (bellard/quickjs went dormant) — prefer it for freshness. Good cross-check that our hand-written fixtures aren't accidentally QuickJS/Hermes-specific. | Fetch `tests/test_closure.js`, `test_loop.js`, `test_op.js`, `test_bignum.js`, `test_builtin.js`, `microbench.js` directly (small files, MIT header). Replace their internal `assert()` helper with the project's own so failures integrate into `node --test` output; they don't use `print`/host globals so no D2 stubbing needed beyond `console`. |
| **esprima / acorn parser test fixtures** (`jquery/esprima` — BSD-2-Clause; `acornjs/acorn` — MIT) | BSD-2-Clause / MIT | **Low-medium, narrow use** — these are parser *fixtures* (source snippet → expected AST JSON), not runnable programs with observable behaviour, so they don't fit the D2 trace-equivalence model directly. Their value is different: they're an unusually thorough catalogue of *syntactic* corner cases (ASI edge cases, exotic numeric/string literal forms, regex-vs-divide ambiguity, destructuring corner cases) that a hand-written list is likely to miss. Best used to stress-test that the **emitter** always produces syntactically valid ES2022 (`node --check`) for weird-but-legal inputs, and to seed a few extra entries in the 1a table (e.g. an ASI-edge-case file) rather than being pulled in wholesale as executable fixtures. | Skim `test/fixtures/` (esprima) or `test/*.js` (acorn) for snippets exercising syntax not already in the 1a list; hand-port a small number (~5–10) into standalone runnable programs with real observable output, crediting the source file. Do not bulk-import — most fixtures are parser-only, not full programs, and would need behaviour synthesized anyway. |

Overall recommendation: the Hermes lit tests are the highest-value external source (guaranteed
Hermes-compilable, expected output already encoded) — harvest those first and use them to
sanity-check the hand-written list for gaps. Use QuickJS's `tests/` as a secondary, independent
cross-check. Treat test262 as a large but low-density edge-case reservoir to dip into rather than
adopt wholesale. Treat esprima/acorn fixtures as inspiration for a handful of syntax-corner-case
additions to 1a, not as an executable corpus.

### 1c. Small real libraries (pure JS, self-testable in Node)

Five candidates, all MIT-licensed pure-JS libraries with dependency-light logic (heavy on
closures, regex, recursion, and control flow — good stress tests once single-construct fixtures
are green) and an existing `npm test` suite that runs under plain Node with no browser/DOM/native
dependency:

| Library | Licence | Why it's a good Tier-1c fixture |
|---|---|---|
| **lodash** | MIT | Large, well-known, heavily branchy utility functions (currying, deep clone/merge, debounce/throttle closures); ships its own `test/test.js` runnable directly under Node. Big enough to be a real stress test — consider fixturing individual source files (e.g. `debounce.js`, `cloneDeep.js`, `template.js`) rather than the whole bundle, to keep each round trip's diff reviewable. |
| **date-fns** | MIT | Pure date-arithmetic logic (no `Intl`/timezone native calls beyond `Date`), TypeScript source but ships compiled plain JS; heavy on default params, destructured options objects, and pure functions — good for the destructuring/default-params constructs from 1a at "real code" scale. |
| **marked** | MIT | Markdown→HTML parser: regex-heavy tokenizer, recursive-descent-style parsing, loops with lookahead — good stress test for the structurer on real nested control flow. **Caveat (verified):** current `marked` source is TypeScript, not plain JS — `npm test` runs against compiled output, not source. Use the published `lib/marked.cjs` / `lib/marked.umd.js` **dist** artifact as the actual fixture (it's already plain JS), not the repo source; the TS compile step happens upstream of our pipeline and isn't itself under test. |
| **validator.js** (validatorjs/validator.js) | MIT | String validation library, dozens of small pure functions, very regex- and branch-heavy, minimal surface area per function (easy to isolate a failing round trip to one function). Assert-based (mocha/nyc) test suite runs against the plain-JS `src/` directly — no TS/build step for the Node test path. |
| **qs** | BSD-3-Clause | Querystring parse/stringify: recursive object/array building, lots of edge-case branching (arrays vs. objects, depth limits, encoding). Source lives directly in `lib/*.js` (no build step), mocha test suite runs under Node with no DOM. |

Alternate/supplementary candidate verified during research: **semver** (npm/node-semver), **ISC**
licence, plain JS split across `classes/`/`functions/`/`ranges/` with no build step, `tap`-based
test suite, heavy on comparison/parsing/regex logic with zero I/O — a good smaller, simpler
substitute if `date-fns` or `marked`'s TS-source detour proves inconvenient to wire up.

For each, the harvesting approach is the same: vendor the library's plain-JS distributable (not
its own build tooling — flag `date-fns` and `marked` explicitly, since both are TS-sourced and
must be fixtured from their compiled dist output, not their repo source) plus its test suite,
record licence provenance in `licence.txt`, and treat the library's own tests as the D2
"observable behaviour" oracle (patching in the sandbox's `console`/`Math.random`/`Date.now` stubs
only where a test is nondeterministic — most of these suites are already deterministic by
construction, unlike RN app code).

---

## 2. Tier 2 — open-source RN/Expo apps (D3)

Round-trip recompilation candidates per D3: decompile → `hermesc` → disassemble both → structural
diff. All licences below were checked against each repo's actual `LICENSE` file/`package.json`
`license` field, not assumed from reputation (two well-known candidates were checked and
**rejected** for this reason — see the note after the table). RN version is listed where verified
directly from a repo's `package.json`; where not directly verified this is flagged.

Hermes bytecode version tracks the RN version's bundled Hermes release; as a rough anchor, RN
0.70-0.74 ships Hermes bytecode ~v89-93, RN 0.76-0.79 ~v94-96, RN 0.80+ ~v96-99+, and the
`v94`/`v99` fixtures already in `tests/fixtures/` bracket most of this table. Exact per-repo
bytecode version should be read from the compiled `.hbc` header (first bytes) once bundled, not
assumed from this table.

| # | Repo | Licence | RN version (→ approx Hermes bytecode) | Approx. bundle size | Bundle-only build complexity | Note |
|---|---|---|---|---|---|---|
| 1 | Fresh `npx react-native@latest init` template (`react-native-community/template`) | MIT | Whatever `init` pulls at run time (currently 0.8x line, same generation as #8 below) → recent Hermes | ~0.5-1.5 MB unminified | Trivial — `npm install` + one `react-native bundle` call, zero secrets, zero native build | Canonical hello-world; exact reproducible command sequence below |
| 2 | `facebook/react-native` — `packages/rn-tester` (in-repo RNTester app) | MIT | Always == the RN version at repo `HEAD` → matches whatever Hermes that RN ships | ~3-5 MB (est.) — broad native-component gallery | Needs the monorepo's `yarn install` at root; JS-bundling doesn't need the native iOS/Android app built, no secrets | Official RN example/test app; always in lockstep with current Hermes, broad component-call surface |
| 3 | `expo/examples` (pick one, e.g. `with-router`, `bare-minimum`) | MIT | Per-example `package.json`, typically a recent Expo SDK / RN ~0.74-0.79 | ~0.5-2 MB (est.) per example | Trivial — `npx expo export`, no secrets | Grab-bag of dozens of tiny single-purpose apps — cheap breadth for the small/mid tier |
| 4 | `react-navigation/react-navigation` — `example/` (monorepo) | MIT | **0.85.3** (verified from `example/package.json`) → recent Hermes (~v100+) | ~2-4 MB (est.) — many stacked navigators/screens | Needs workspace install (pnpm, monorepo root); no secrets, no native build for JS-only bundle | Wide variety of navigator/gesture/interaction patterns; classes-and-closures-heavy generated code |
| 5 | `software-mansion/react-native-gesture-handler` — `FabricExample`/`example` | MIT (verified) | Tracks a recent RN (~0.75-0.8x; exact version not pinned by this doc, confirm from that dir's `package.json` before use) | ~1-3 MB (est.) | Trivial for JS-only bundling — the native gesture module isn't needed to produce the bundle (app would only fail if actually *run* on device); no secrets | Heavy on worklet/JSI-adjacent glue code emitted as plain function bodies — good stress test for "looks native but is just a JS closure" call sites |
| 6 | `callstack/react-native-paper` — `example/` | MIT | **0.77.x + Expo SDK 52** (verified) → Hermes ~v96-98 | ~2-3 MB (est.) — full component-demo gallery | Trivial — `npx expo export`, no secrets | Large single-purpose UI-component-gallery app; good broad-surface mid-size fixture |
| 7 | `infinitered/ignite`-generated app (`npx ignite-cli new <Name>`) | MIT (CLI + boilerplate; generated app code belongs to whoever generates it, but the boilerplate source used as the fixture template is MIT) | Whatever RN the generator currently targets | ~2-4 MB (est.) — navigation + state management wired in by default | `npx ignite-cli new <Name>` then bundle; no secrets | Not a fixed upstream repo but a **reproducible generator** — gives a controlled, versionable "realistic mid-size app skeleton" instead of chasing a moving external repo |
| 8 | `Expensify/App` | **MIT** (verified: `package.json` `license` field) | **0.86.0** (verified from `package.json`) → very recent Hermes (v100+) | **Large** — likely double-digit MB given app scope (chat + expense/finance workflows + offline sync + very large screen/route count); treat as the ~5-15 MB "large" slot | External contributors are explicitly told they do **not** need a local `.env`/secrets file for a standard build (verified via project contributing docs); the toolchain itself is heavy (large monorepo, custom Metro config, Reanimated worklets, many native modules) but that's a *build-tooling* cost, not a secrets/API-key blocker for producing the JS bundle | Best large-app candidate: permissively licensed, actively developed as of 2026, bleeding-edge RN/Hermes version, no build secrets required just to bundle |
| 9 | `bluesky-social/social-app` | **MIT** (verified) | Not verified in this pass (Expo-based, actively developed 2024-2026) — **confirm exact RN version from `package.json` before use** | Probably several MB — large real production social app, likely smaller than Expensify's | Expo-based (`expo export`); may reference non-secret runtime config (API host) that should not block a default bundle, but confirm before relying on it | Second large-app candidate with a different code shape than Expensify (feed/social client, web+native code sharing) — good variety in the "large" slot |

**Rejected during verification (D4 licence filter):**
- `MetaMask/metamask-mobile` — the repo's `LICENSE` is a bespoke ConsenSys "inspect and study only" licence, explicitly prohibiting redistribution/derivative works without permission. **Not MIT/Apache/BSD/ISC — excluded.**
- `rainbow-me/rainbow` — GPL-3.0. **Excluded** (copyleft, incompatible with D4; note the *separate* `rainbow-me/rainbowkit` repo is MIT but is a wallet-connection library, not an app to bundle).

Both are good examples of why licence must be checked per-repo rather than assumed from a
project's general open-source reputation.

### Does `npx react-native init` alone give a trivially reproducible Tier 2 fixture?

**Yes.** No extra libraries needed — this is the cheapest fixture in the table (#1) and should be
the first Tier 2 fixture implemented, since M6 can start before any external-repo licence/version
churn is a concern. Exact command sequence (verified against current RN CLI + Hermes docs):

```sh
# 1. Scaffold a minimal app
npx react-native@latest init HelloHermes
cd HelloHermes

# 2. Produce a release-mode JS bundle (Android shown; --platform ios is analogous)
npx react-native bundle \
  --platform android \
  --dev false \
  --entry-file index.js \
  --bundle-output ./release.bundle \
  --assets-dest ./release-assets \
  --minify true \
  --reset-cache

# 3. Compile the bundle to Hermes bytecode.
# hermesc ships prebuilt under node_modules once react-native is installed. Current RN versions
# place it at:
#   node_modules/react-native/sdks/hermesc/<osx-bin|linux64-bin|win64-bin>/hermesc
# (older RN releases instead shipped it via the separate `hermes-engine` package, at
#   node_modules/hermes-engine/<osx-bin|linux64-bin>-bin/hermesc — check both if the first
#   path is missing, since this has moved between RN versions.)
node_modules/react-native/sdks/hermesc/osx-bin/hermesc \
  -O -emit-binary \
  -out ./release.hbc \
  ./release.bundle
```

The Expo equivalent is even simpler because `expo export` invokes `hermesc` internally and writes
`.hbc` files directly (Hermes is the default engine in current Expo/RN) — no separate manual
`hermesc` step:

```sh
npx create-expo-app HelloExpo
cd HelloExpo
npx expo export --platform android
# .hbc bytecode lands under dist/_expo/static/js/android/*.hbc
```

Neither path needs signing keys, an emulator, or a native build — bundling is a pure JS/Metro
step, confirming the SPEC assumption that "bundling does not require building the native app."

