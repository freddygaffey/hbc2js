# tests/fixtures/

Tier 1 (pure-JS, D2 execution-trace) fixture corpus for hbc2js. See
`docs/TEST-CORPUS.md` for the research/planning doc this was built from,
`docs/DECISIONS.md` D2/D3/D4, and `docs/AGENT-WORKFLOW.md` for the general
fixture-layout convention this directory follows.

## Layout

```
tests/fixtures/
  build.sh                        # regenerates every .hbc from every source.js (idempotent)
  README.md                       # this file
  hermes-dec-sample/              # one real-world-ish sample, multi-version, see below
    source.js
    v84.hbc                       # compiled fresh by this project (no historical original)
    v94.hbc                       # PRESERVED historical original — never regenerated
    v99.hbc                       # PRESERVED historical original — never regenerated
    v99-public.hbc                # fresh recompile with the public v99 hermesc, for comparison
    licence.txt
  constructs/
    01-if-else-chain/
      source.js                   # the fixture program (print()-only output, deterministic)
      expected.txt                # `node source.js` output, captured once, ground truth for D2
      v84.hbc  v94.hbc  v99.hbc   # compiled bytecode (only for versions that support it)
      versions.txt                # present only if some hermesc version can't compile this one
      licence.txt                 # original work, MIT
    02-while-loop/
      ...
    ... (51 directories total, 01 through 51, matching docs/TEST-CORPUS.md §1a)
```

Every fixture directory is self-contained: source + every compiled version + licence,
per `docs/AGENT-WORKFLOW.md`'s `tests/fixtures/<name>/{source.js,vNN.hbc,licence.txt}`
convention.

## Fixture-authoring conventions (`constructs/`)

- **Output only through `print`.** Bare Hermes (the `hermes` CLI/VM, no React
  Native host) does **not** define `console`, `setTimeout`, `queueMicrotask`,
  or any DOM/RN global — verified empirically (`console.log` throws
  `ReferenceError: Property 'console' doesn't exist` under `tools/hermesc/v84/hermes`).
  It does define `print` natively. So every fixture uses `print(...)` exclusively,
  never `console.log`, so the *same* source file runs unmodified under both Node
  (with a one-line shim) and bare Hermes:
  ```js
  globalThis.print ??= (...a) => console.log(...a);
  ```
- **Only ever pass strings/numbers/booleans/etc. to `print`, never a raw object
  or array.** Hermes's native `print` stringifies each argument with plain
  `ToString` semantics (arrays become `1,2,3`, objects become `[object Object]`),
  which is *not* what Node's `console.log` does with the shim above (it uses
  V8's `util.inspect`-style formatting instead — arrays print as `[ 1, 2, 3 ]`).
  Fixtures sidestep the mismatch entirely by always pre-stringifying
  (`.join(',')`, template literals, `JSON.stringify(...)`) before calling
  `print`, so output is byte-identical under both engines by construction.
- **No nondeterminism.** No `Math.random`, `Date.now`, `setTimeout`, or
  `queueMicrotask` (also not guaranteed to exist under bare Hermes — see above).
  Async ordering constructs use only `Promise`/`async`/`await`, whose relative
  microtask ordering is fully spec-determined by the code structure.
- **~15-60 lines**, one construct per file (per `docs/TEST-CORPUS.md` §1a),
  each printing multiple lines that distinguish correct behaviour from at
  least one plausible-but-wrong decompilation (edge cases: empty input,
  early exit, exception path, etc.).
- **`expected.txt` is generated, not hand-written** — it's `node source.js`'s
  actual stdout (with the `print` shim), captured once. It is the ground
  truth oracle for the D2 trace harness once that harness exists; nobody
  should hand-edit it to match a guess.

## How to add a fixture

1. `mkdir tests/fixtures/constructs/NN-topic-name`
2. Write `source.js` following the conventions above.
3. Sanity-run it under Node:
   ```sh
   node -e 'globalThis.print ??= (...a)=>console.log(...a); require("./tests/fixtures/constructs/NN-topic-name/source.js")'
   ```
   (or use the one-liner loop pattern in "Sanity-checking" below) and confirm
   it doesn't crash and prints something meaningful.
4. Capture the oracle:
   ```sh
   { printf 'globalThis.print ??= (...a)=>console.log(...a);\n'; cat tests/fixtures/constructs/NN-topic-name/source.js; } > /tmp/f.js
   node /tmp/f.js > tests/fixtures/constructs/NN-topic-name/expected.txt
   ```
5. Add `licence.txt` (copy the wording from any existing `constructs/*/licence.txt`
   if it's original work written for this project).
6. Run `tests/fixtures/build.sh` to compile it with every available hermesc.
   If a version can't compile it, `build.sh` will print `FAIL ... (unexpected —
   no versions.txt entry excuses this)` — that's your cue to add a
   `versions.txt` (see existing ones for the format: `vNN: FAILS - <reason>`)
   so the build stops treating it as an error, then rerun `build.sh`.
7. Update the table below.

## How to rebuild

```sh
tools/get-hermesc.sh all        # once, fetches v84/v94/v99 (gitignored, not committed)
tests/fixtures/build.sh         # compiles every source.js with every hermesc it can find
tests/fixtures/build.sh --force # recompile everything even if .hbc looks up to date
```

`build.sh` is idempotent (safe to rerun; only recompiles when `source.js` is
newer than the `.hbc`, or the `.hbc` is missing, or `--force` is given) and
skips known-incompatible version/fixture pairs automatically by reading each
fixture's `versions.txt`. It treats an *undocumented* compile failure as a
hard error (exit 1) specifically so a versions.txt drifting out of sync with
reality gets caught immediately.

`tests/fixtures/hermes-dec-sample/{v94,v99}.hbc` are **never** touched by
`build.sh` — they're preserved historical binaries (see that directory's
`licence.txt` and `docs/TOOLCHAIN.md`'s byte-identical-recompilation section).
Only `v84.hbc` and `v99-public.hbc` there are (re)generated.

## Construct fixture compiler-compatibility table

51/51 fixtures compile and run correctly under Node. Compilation under each
hermesc version (✅ = compiles, ❌ = documented failure, see that fixture's
`versions.txt`):

| # | Fixture | v84 | v94 | v99 |
|---|---|---|---|---|
| 01 | if-else-chain | ✅ | ✅ | ✅ |
| 02 | while-loop | ✅ | ✅ | ✅ |
| 03 | do-while-loop | ✅ | ✅ | ✅ |
| 04 | for-loop-basic | ✅ | ✅ | ✅ |
| 05 | for-in-object | ✅ | ✅ | ✅ |
| 06 | for-of-array | ✅ | ✅ | ✅ |
| 07 | for-of-iterable | ✅ | ✅ | ✅ |
| 08 | labeled-break-continue | ✅ | ✅ | ✅ |
| 09 | switch-fallthrough | ✅ | ✅ | ✅ |
| 10 | switch-no-fallthrough | ✅ | ✅ | ✅ |
| 11 | nested-loops-mixed | ✅ | ✅ | ✅ |
| 12 | try-catch-finally-return | ✅ | ✅ | ✅ |
| 13 | try-finally-no-catch | ✅ | ✅ | ✅ |
| 14 | nested-try-catch | ✅ | ✅ | ✅ |
| 15 | catch-without-binding | ✅ | ✅ | ✅ |
| 16 | finally-with-break-continue | ✅ | ✅ | ✅ |
| 17 | closure-loop-var | ✅ | ✅ | ✅ |
| 18 | closure-loop-let | ✅ | ✅ | ✅ |
| 19 | var-hoisting | ✅ | ✅ | ✅ |
| 20 | let-const-tdz | ✅ | ✅ | ✅ |
| 21 | iife-closures | ✅ | ✅ | ✅ |
| 22 | nested-closures-counters | ✅ | ✅ | ✅ |
| 23 | generator-basic | ✅ | ✅ | ✅ |
| 24 | generator-return-throw | ✅ | ✅ | ✅ |
| 25 | generator-delegation | ✅ | ✅ | ✅ |
| 26 | infinite-generator-take | ✅ | ✅ | ✅ |
| 27 | async-await-basic | ✅ | ✅ | ✅ |
| 28 | async-await-error | ✅ | ✅ | ✅ |
| 29 | promise-chaining | ✅ | ✅ | ✅ |
| 30 | async-generator | ❌ | ❌ | ❌ |
| 31 | microtask-ordering | ✅ | ✅ | ✅ |
| 32 | class-basic | ❌ | ❌ | ✅ |
| 33 | class-inheritance-super | ❌ | ❌ | ✅ |
| 34 | class-static-members | ❌ | ❌ | ✅ |
| 35 | class-private-fields | ❌ | ❌ | ✅ |
| 36 | class-getters-setters | ❌ | ❌ | ✅ |
| 37 | destructuring-array | ✅ | ✅ | ✅ |
| 38 | destructuring-object | ✅ | ✅ | ✅ |
| 39 | destructuring-params | ✅ | ✅ | ✅ |
| 40 | spread-array | ✅ | ✅ | ✅ |
| 41 | spread-object | ✅ | ✅ | ✅ |
| 42 | rest-params | ✅ | ✅ | ✅ |
| 43 | template-literals | ✅ | ✅ | ✅ |
| 44 | tagged-templates | ✅ | ✅ | ✅ |
| 45 | regex-literals | ❌ | ✅ | ✅ |
| 46 | bigint-arithmetic | ❌ | ✅ | ✅ |
| 47 | typeof-instanceof-in | ✅ | ✅ | ✅ |
| 48 | optional-chaining-nullish | ✅ | ✅ | ✅ |
| 49 | arguments-object | ✅ | ✅ | ✅ |
| 50 | this-binding | ✅ | ✅ | ✅ |
| 51 | default-params | ✅ | ✅ | ✅ |

**Totals: 138/153 (source × version) combinations compile.** The 15 gaps:
- **`class` syntax is entirely unsupported by hermesc v84 and v94** (32-36,
  5 fixtures × 2 versions = 10 gaps) — this is an IRGen limitation, not a
  parser one (`hermesc -dump-ast` parses classes fine on v84); confirmed with
  minimal repros. Only `hermes-compiler@260318099.0.1` (v99) lowers classes to
  bytecode. This was an unexpected finding worth flagging to whoever designs
  the decompiler's class-recovery logic: **no v84/v94 bytecode fixture will
  ever exercise class-shaped bytecode**, because Hermes itself couldn't
  compile classes in that era (React Native's Babel pipeline transpiled
  classes to ES5 prototype chains before this-era Hermes ever saw them).
- **BigInt literals (46) and regex named capture groups (45) are unsupported
  by v84 only** (2 gaps) — straightforward lexer/regex-engine limitations,
  fixed by v94.
- **`async function*` / `for await...of` (30) is unsupported by all three**
  fetched versions (3 gaps) — v84/v94 reject `for await...of` outright at
  parse time; v99 parses it but rejects `async function*` declarations. Kept
  as a fixture anyway (runs fine under Node) since some future hermesc may
  support it, and it documents a real decompiler-scope gap either way.

See each gap fixture's own `versions.txt` for the exact hermesc error text and
reasoning.

## Sanity-checking: Node execution

All 51 `constructs/*/source.js` files were run under Node 25 with the print
shim above; all 51 completed without throwing and their `expected.txt` was
captured from that run. Command used (from `tests/fixtures/constructs/`):

```sh
for d in */; do
  { printf 'globalThis.print ??= (...a)=>console.log(...a);\n'; cat "$d/source.js"; } > /tmp/f.js
  node /tmp/f.js > "$d/expected.txt"
done
```

## Sanity-checking: Hermes VM (v84) vs. Node

`tools/hermesc/v84/hermes` is a full Hermes **interpreter** (not just the
`hermesc` compiler), bundled by `hermes-engine-cli@0.8.1`. It's the only
`hermes` VM binary any of the three fetched packages ships (`react-native`
and `hermes-compiler` ship only `hermesc`, the compiler, not an interpreter).
It can run `.js` source directly (compiling it internally), so it was used to
cross-check the 43 fixtures that compile under v84 against the Node-captured
`expected.txt`:

```sh
for d in tests/fixtures/constructs/*/; do
  diff <(cat "$d/expected.txt") <(tools/hermesc/v84/hermes "$d/source.js" 2>&1)
done
```

**39 of 43 matched exactly.** Four genuine Node-vs-Hermes-v84 behavioural
differences were found (not fixture bugs — confirmed by inspecting both
outputs by hand):

1. **`18-closure-loop-let`** — per-iteration `let` bindings in `for` loops.
   Spec/Node: each closure captures its *own* iteration's binding
   (`0,1,2`). Hermes v84: all closures observe the *final* value (`3,3,3`) —
   i.e. Hermes v84 treats a `let`-headed `for` loop like a `var`-headed one
   for closure-capture purposes, the exact bug the `let` form exists to fix.
2. **`20-let-const-tdz`** — TDZ + shadowing in a nested block. Spec/Node:
   referencing a block-local `let` before its declaration line throws
   `ReferenceError` even if an outer variable of the same name exists (TDZ
   shadows the outer binding entirely). Hermes v84: no `ReferenceError` — it
   resolves the "not yet declared" read to the *outer* binding, and further,
   the inner `let val = 'shadowed'` assignment appears to write through to
   that same outer binding rather than creating an independent block-scoped
   one (the outer `val` reads back as `'shadowed'` after the block exits,
   where Node keeps it `'outer'`). This is a real block-scoping/TDZ gap for
   the specific same-name-shadowing case, not just a TDZ-checking omission.
3. **`42-rest-params`** and **4. `49-arguments-object`** — legacy sloppy-mode
   `arguments`-object/parameter aliasing (mutating a named parameter should
   update `arguments[i]` and vice versa, per spec Annex B semantics for
   non-strict functions). Node implements the aliasing (`mutated`/`true`
   printed). Hermes v84 does not — the `arguments` object is a disconnected
   snapshot, more like strict-mode semantics, even though the function itself
   is non-strict.

These four are documented here rather than by editing the affected
`source.js` files (the fixtures correctly test spec behaviour; the
divergence is Hermes v84's, not the fixture's). **Implication for hbc2js**:
D2's harness runs both original and decompiled JS in `node:vm`, so this
doesn't affect trace-equivalence testing directly — but it means a `.hbc`
file actually produced by compiling one of these four constructs *through
Hermes v84* will not behave the way naively re-running its JS source under
Node suggests. If real v84 bytecode for these patterns is ever a decompiler
target, the decompiler would need to reproduce Hermes v84's (non-spec)
runtime behaviour, not the ECMAScript spec's, for byte-for-byte trace
fidelity. Not independently re-verified under v94/v99 (no `hermes`
interpreter binary is available from those packages — only `hermesc`); worth
re-checking if a v94/v96/v99-era `hermes` binary is ever sourced.
