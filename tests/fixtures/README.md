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
    v96.hbc                       # compiled fresh by this project (no historical original)
    v98.hbc                       # compiled fresh by this project (no historical original)
    v99.hbc                       # PRESERVED historical original — never regenerated
    v99-public.hbc                # fresh recompile with the public v99 hermesc, for comparison
    licence.txt
  constructs/
    01-if-else-chain/
      source.js                   # the fixture program (print()-only output, deterministic)
      expected.txt                # `node source.js` output, captured once, ground truth for D2
      v84.hbc v94.hbc v96.hbc v98.hbc v99.hbc  # compiled bytecode (only for versions that support it)
      source.obf.js source.min.js # D13 hardened-tier variants (obfuscated/minified), see below
      vNN.obf.hbc vNN.min.hbc     # compiled variants (only where source.NN.js exists and compiles)
      versions.txt                # present only if some hermesc version can't compile this one
      licence.txt                 # original work, MIT
    02-while-loop/
      ...
    ... (53 directories total, 01 through 53 — 01-51 matching docs/TEST-CORPUS.md §1a,
         52-53 added later to close the switch-jump-table gap, see below)
  obfuscator.config.json           # pinned javascript-obfuscator config for the hardened tier
  OBFUSCATION.md                   # D13 hardened-tier variants: config, breakage, control check
  bundles/                         # Tier 2 (D3 round-trip) real Metro bundles, see below
    rn-template-0.72/
      index.android.bundle         # Metro-produced JS bundle (--dev false --minify true)
      index.android.hbc            # hermesc v94 -O (== default flags)
      index.android.noopt.hbc      # hermesc v94 -O0
      index.android.debug.hbc      # hermesc v94 -O -g (== -g alone)
      index.android.noopt.debug.hbc# hermesc v94 -O0 -g
      licence.txt
      BUILD.md                     # exact commands, versions, sizes, findings
      hardened/                    # D13/D16 C4 hardened variant, see tests/fixtures/OBFUSCATION.md
                                    # and hardened/CONFIG.md (binary not committed — over size cap)
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
tools/get-hermesc.sh all        # once, fetches v84/v94/v96/v98/v99 (gitignored, not committed)
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
`v84.hbc`, `v96.hbc`, `v98.hbc`, and `v99-public.hbc` there are freshly
(re)generated the same way (only `v96.hbc` was produced by hand rather than
by `build.sh` itself, since that script's hermes-dec-sample section is
hardcoded per-version and out of this task's edit scope — see `docs/TOOLCHAIN.md`).

## Construct fixture compiler-compatibility table

57/57 fixtures compile and run correctly under Node — the table below predates
T9's two additions, `56-switch-string-jumptable` and `57-logical-assignment`,
which compile at **all five** versions (v84/v94/v96/v98/v99) with no
`versions.txt` exclusion and pass the gate 5/5 each. Compilation under each
hermesc version (✅ = compiles, ❌ = documented failure, see that fixture's
`versions.txt`):

| # | Fixture | v84 | v94 | v96 | v98 | v99 |
|---|---|---|---|---|---|---|
| 01 | if-else-chain | ✅ | ✅ | ✅ | ✅ | ✅ |
| 02 | while-loop | ✅ | ✅ | ✅ | ✅ | ✅ |
| 03 | do-while-loop | ✅ | ✅ | ✅ | ✅ | ✅ |
| 04 | for-loop-basic | ✅ | ✅ | ✅ | ✅ | ✅ |
| 05 | for-in-object | ✅ | ✅ | ✅ | ✅ | ✅ |
| 06 | for-of-array | ✅ | ✅ | ✅ | ✅ | ✅ |
| 07 | for-of-iterable | ✅ | ✅ | ✅ | ✅ | ✅ |
| 08 | labeled-break-continue | ✅ | ✅ | ✅ | ✅ | ✅ |
| 09 | switch-fallthrough | ✅ | ✅ | ✅ | ✅ | ✅ |
| 10 | switch-no-fallthrough | ✅ | ✅ | ✅ | ✅ | ✅ |
| 11 | nested-loops-mixed | ✅ | ✅ | ✅ | ✅ | ✅ |
| 12 | try-catch-finally-return | ✅ | ✅ | ✅ | ✅ | ✅ |
| 13 | try-finally-no-catch | ✅ | ✅ | ✅ | ✅ | ✅ |
| 14 | nested-try-catch | ✅ | ✅ | ✅ | ✅ | ✅ |
| 15 | catch-without-binding | ✅ | ✅ | ✅ | ✅ | ✅ |
| 16 | finally-with-break-continue | ✅ | ✅ | ✅ | ✅ | ✅ |
| 17 | closure-loop-var | ✅ | ✅ | ✅ | ✅ | ✅ |
| 18 | closure-loop-let | ✅ | ✅ | ✅ | ✅ | ✅ |
| 19 | var-hoisting | ✅ | ✅ | ✅ | ✅ | ✅ |
| 20 | let-const-tdz | ✅ | ✅ | ✅ | ✅ | ✅ |
| 21 | iife-closures | ✅ | ✅ | ✅ | ✅ | ✅ |
| 22 | nested-closures-counters | ✅ | ✅ | ✅ | ✅ | ✅ |
| 23 | generator-basic | ✅ | ✅ | ✅ | ✅ | ✅ |
| 24 | generator-return-throw | ✅ | ✅ | ✅ | ✅ | ✅ |
| 25 | generator-delegation | ✅ | ✅ | ✅ | ✅ | ✅ |
| 26 | infinite-generator-take | ✅ | ✅ | ✅ | ✅ | ✅ |
| 27 | async-await-basic | ✅ | ✅ | ✅ | ✅ | ✅ |
| 28 | async-await-error | ✅ | ✅ | ✅ | ✅ | ✅ |
| 29 | promise-chaining | ✅ | ✅ | ✅ | ✅ | ✅ |
| 30 | async-generator | ❌ | ❌ | ❌ | ❌ | ❌ |
| 31 | microtask-ordering | ✅ | ✅ | ✅ | ✅ | ✅ |
| 32 | class-basic | ❌ | ❌ | ❌ | ✅ | ✅ |
| 33 | class-inheritance-super | ❌ | ❌ | ❌ | ✅ | ✅ |
| 34 | class-static-members | ❌ | ❌ | ❌ | ✅ | ✅ |
| 35 | class-private-fields | ❌ | ❌ | ❌ | ✅ | ✅ |
| 36 | class-getters-setters | ❌ | ❌ | ❌ | ✅ | ✅ |
| 37 | destructuring-array | ✅ | ✅ | ✅ | ✅ | ✅ |
| 38 | destructuring-object | ✅ | ✅ | ✅ | ✅ | ✅ |
| 39 | destructuring-params | ✅ | ✅ | ✅ | ✅ | ✅ |
| 40 | spread-array | ✅ | ✅ | ✅ | ✅ | ✅ |
| 41 | spread-object | ✅ | ✅ | ✅ | ✅ | ✅ |
| 42 | rest-params | ✅ | ✅ | ✅ | ✅ | ✅ |
| 43 | template-literals | ✅ | ✅ | ✅ | ✅ | ✅ |
| 44 | tagged-templates | ✅ | ✅ | ✅ | ✅ | ✅ |
| 45 | regex-literals | ❌ | ✅ | ✅ | ✅ | ✅ |
| 46 | bigint-arithmetic | ❌ | ✅ | ✅ | ✅ | ✅ |
| 47 | typeof-instanceof-in | ✅ | ✅ | ✅ | ✅ | ✅ |
| 48 | optional-chaining-nullish | ✅ | ✅ | ✅ | ✅ | ✅ |
| 49 | arguments-object | ✅ | ✅ | ✅ | ✅ | ✅ |
| 50 | this-binding | ✅ | ✅ | ✅ | ✅ | ✅ |
| 51 | default-params | ✅ | ✅ | ✅ | ✅ | ✅ |
| 52 | switch-jumptable | ✅ | ✅ | ✅ | ✅ | ✅ |
| 53 | switch-jumptable-large | ✅ | ✅ | ✅ | ✅ | ✅ |

**Totals: 243/265 (source × version) combinations compile.** The 22 gaps (all in 01-51):
- **`class` syntax is entirely unsupported by hermesc v84, v94, and v96**
  (32-36, 5 fixtures × 3 versions = 15 gaps) — this is an IRGen limitation, not
  a parser one (`hermesc -dump-ast` parses classes fine on v84); confirmed with
  minimal repros. Only the `static_h`/Static Hermes lineage
  (`hermes-compiler@250829098.0.10`, v98, and `hermes-compiler@260318099.0.1`,
  v99) lowers classes to bytecode. This was an unexpected finding worth
  flagging to whoever designs the decompiler's class-recovery logic: **no
  v84/v94/v96 bytecode fixture will ever exercise class-shaped bytecode**,
  because classic Hermes (the `main` lineage, frozen at v96, per
  `docs/HBC-FORMAT.md` §0) never grew class-lowering support at all — React
  Native's Babel pipeline transpiled classes to ES5 prototype chains before
  this-era Hermes ever saw them.
- **BigInt literals (46) and regex named capture groups (45) are unsupported
  by v84 only** (2 gaps) — straightforward lexer/regex-engine limitations,
  fixed by v94 (and remain fixed in v96/v98/v99).
- **`async function*` / `for await...of` (30) is unsupported by all five**
  fetched versions (5 gaps) — v84/v94 reject `for await...of` outright at
  parse time; v98/v99 (both `static_h`) parse it but reject `async function*`
  declarations; v96 reports both errors together (a genuinely different,
  more specific diagnostic than v84/v94's single for-await-of error — see
  that fixture's `versions.txt`). Kept as a fixture anyway (runs fine under
  Node) since some future hermesc may support it, and it documents a real
  decompiler-scope gap either way.

See each gap fixture's own `versions.txt` for the exact hermesc error text and
reasoning.

## Switch jump tables (52, 53)

`docs/PRIOR-ART.md` and `docs/AGENT-LOG.md` flagged that none of fixtures
01-51 exercises a `SwitchImm`/`UIntSwitchImm` jump table — every `switch` in
that corpus (09, 10) lowers to a chain of `JStrictEqual(Long)` compares
instead. `52-switch-jumptable` and `53-switch-jumptable-large` close that gap:

- **`52-switch-jumptable`**: a 13-case dense integer switch (`0..12`,
  including a fallthrough run and a `default`) on a value that can't be
  constant-folded (read from a loop variable). Confirmed present at all three
  fetched hermesc versions via `hermesc -dump-bytecode`:
  ```
  v84: SwitchImm         r0, 253, L13, 0, 12
  v94: SwitchImm         r0, 253, L13, 0, 12
  v98: UIntSwitchImm     r0, 253, L13, 0, 12
  v99: UIntSwitchImm     r0, 253, L13, 0, 12
  ```
  (v98/v99, both `static_h`/Static Hermes, renamed the opcode `SwitchImm` →
  `UIntSwitchImm`, but the operand shape — `Reg8 value, tableOffset,
  defaultTarget, min, max` — is unchanged; see `docs/HBC-FORMAT.md` §11.1. v98
  was added to this repo's toolchain after 52/53 were first written — see
  `docs/TOOLCHAIN.md`'s "v98: which header layout does the public package
  emit?" for why `v98.hbc` here is always the "98-late"/class-E layout.)
- **`53-switch-jumptable-large`**: a wider 40-case switch (`0..39`) with
  multiple fallthrough runs and a `default` placed *in the middle* of the
  case list (not last), to also exercise: a bigger table (`min=0, max=39`,
  40 4-byte entries vs. 52's 13), a larger `tableOffset`, and the fact that a
  decompiler cannot assume `default` is the last case textually or that it
  sits outside the `[min,max]` jump range. Confirmed present at all three
  versions the same way (`SwitchImm r0, 177, L9, 0, 39` / `UIntSwitchImm` on
  v99).

**Grep caveat:** naively `grep -c SwitchImm` on a v99 `-dump-bytecode` dump
over-counts by one — the disassembly header always prints a
`StringSwitchImm count: N` summary line (0 when unused) whose text also
matches the substring `SwitchImm`. Verification above matched the actual
instruction line (operand register present), not just occurrence count.

**Do string switches ever produce a jump table?** Tested but **not shipped as
a fixture** (would duplicate 09/10's shape without adding decompiler-relevant
coverage beyond what's noted here). Result, on a 13-case single-character
string switch with a `default`:
- **v84 and v94 (classic Hermes): no.** Always a `JStrictEqual`/
  `JStrictEqualLong` compare chain, regardless of case count or density —
  confirmed no `StringSwitchImm`/jump-table opcode exists at all in the
  classic-Hermes opcode table (`docs/HBC-FORMAT.md` §11.1 only documents
  `StringSwitchImm` as `v≥99`).
- **v99 (Static Hermes): yes.** Emits an actual `StringSwitchImm` instruction
  (`StringSwitchImm r0, 0, 274, L14, 13`), a genuinely different opcode from
  `SwitchImm`/`UIntSwitchImm` with a `{caseLabelStringID, target}` pair table
  (`docs/HBC-FORMAT.md` §11.1) rather than a dense integer-indexed table. So
  the answer is version-dependent, not a flat "never": **integer** switches
  get `SwitchImm`/`UIntSwitchImm` on all three fetched versions when dense
  enough; **string** switches never do on v84/v94 but genuinely do on v99.
  Any decompiler pass that recognizes jump tables must handle
  `StringSwitchImm`'s table shape as a distinct case, not assume all jump
  tables are integer-indexed.

**Density threshold, observed (not to be over-generalized to an exact
formula):** a switch with the same 13-entry `0..12` shape as 52 but sparse
values (`0, 500, 1000, 1500, 2000`) produced **no** jump table on any
version (compare chain instead). Adding a single sparse outlier case
(`5000`) to an otherwise-dense `0..12` switch also killed the jump table
*entirely* on all three versions — Hermes's switch lowering is all-or-nothing
per switch statement; it does not split a dense sub-range into a jump table
while compare-chaining a sparse remainder.

## Hardened tier: obfuscated/minified variants (D13, D16 category C2/C4)

Per `docs/DECISIONS.md` D13, every `constructs/<name>/source.js` also gets
`source.obf.js` (obfuscated with `javascript-obfuscator`, control-flow
flattening + encoded string arrays) and `source.min.js` (minified only, with
`terser`) as siblings, each compiled to `vNN.obf.hbc`/`vNN.min.hbc`. Full
config, exact pinned versions, which construct broke (1/53, obfuscation only
— `35-class-private-fields`), and the structural control-check (minified
bytecode is basically indistinguishable from the original; obfuscated
bytecode has 5-9x the instructions/basic blocks/string-table entries) all
live in `tests/fixtures/OBFUSCATION.md` — this section just points there and
covers regeneration.

Regenerate with:

```sh
tests/fixtures/build.sh --variants          # idempotent, only (re)builds stale/missing variants
tests/fixtures/build.sh --variants --force  # rebuild every variant regardless
```

This fetches `javascript-obfuscator`/`terser` on demand via `npx` (pinned
versions, see `OBFUSCATION.md`) — neither is a repo dependency. The default
`tests/fixtures/build.sh` (no `--variants`) is unaffected and behaves exactly
as before.

`bundles/rn-template-0.72/hardened/` is the one real-bundle hardened variant
(D16 category C4) and is **not** regenerated by `build.sh --variants` — it's
a single large one-off gated on a 3 MB size cap, with its own manual
regeneration command in `hardened/CONFIG.md`.

## Sanity-checking: Node execution

All 53 `constructs/*/source.js` files were run under Node 25 with the print
shim above; all 53 completed without throwing and their `expected.txt` was
captured from that run (52-53 added later, same method). Command used (from
`tests/fixtures/constructs/`):

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
cross-check the 45 fixtures that compile under v84 against the Node-captured
`expected.txt`:

```sh
for d in tests/fixtures/constructs/*/; do
  diff <(cat "$d/expected.txt") <(tools/hermesc/v84/hermes "$d/source.js" 2>&1)
done
```

**41 of 45 matched exactly** (39/43 for 01-51, plus 52 and 53 both matching
exactly). Four genuine Node-vs-Hermes-v84 behavioural
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

## Tier 2: `bundles/rn-template-0.72` (real Metro bundle, D3)

Per `docs/TEST-CORPUS.md` §2 (row 1, "Fresh `npx react-native@latest init`
template") and `docs/DECISIONS.md` D10, the Tier 1 `constructs/` corpus above
is entirely hand-written pure JS run through `hermesc` directly — none of it
is a real Metro-bundled application. `bundles/rn-template-0.72/` closes that
gap with the cheapest possible real-world case: a stock, unmodified
`react-native init` template, pinned to RN **0.72.17** (→ HBC bytecode
version 94, matching this repo's `tools/hermesc/v94`), bundled with Metro
(`--dev false --minify true`) and compiled with four `hermesc` flag
combinations. See that directory's own `BUILD.md` for exact commands,
per-file sizes, and provenance, and `licence.txt` for the MIT licence chain
(`react-native` + `@react-native-community/template`, both verified via
`npm view ... license`).

**Notable finding:** this hermesc build applies `-O` optimizations *by
default* — compiling with no flags at all produces byte-identical output to
explicit `-O` (and `-g` alone is byte-identical to `-O -g`). The only way to
get genuinely unoptimized bytecode is the explicit `-O0` disabling flag. A
decompiler test matrix that assumes "no `-O` flag passed" implies unoptimized
bytecode would be wrong for this compiler build.

This fixture was scaffolded and built entirely outside this repository (a
scratch directory), per the task that produced it — only the final JS bundle
and compiled `.hbc` files were copied in, never `node_modules/` or any
scaffold-only build artefact.

## Tier 2: `bundles/react-navigation-example-0.85.3` and `bundles/expensify-app-0.86.0`

Two more real-world Metro/Hermes bundles per `docs/TEST-CORPUS.md` §2 (rows 4
and 8) and `docs/DECISIONS.md` D13/D16 (category **C3**), both built entirely
in a scratch directory (never inside this repo) and both over the 3 MB
commit threshold — see each fixture's own `BUILD.md` for exact reproducible
commands, `fetch.sh` to regenerate, and sha256/size tables; `licence.txt` for
the MIT chain.

| # | Fixture | RN version | HBC version | JS bundle | `-O` `.hbc` | Notes |
|---|---|---|---|---|---|---|
| 1 | `react-navigation-example-0.85.3` | 0.85.3 | 98 | 3.36 MB | 4.31 MB | Expo-based (`expo export --no-bytecode`); 15,551 functions; 73 `CreateGenerator`, 0 async-specific opcodes; 26 `UIntSwitchImm` + 10 `StringSwitchImm` |
| 2 | `expensify-app-0.86.0` | 0.86.0 | 98 | 36.8 MB | 43.5 MB | "Large" slot — bigger than `docs/TEST-CORPUS.md`'s ~12 MB anchor; 98,775 functions; 787 `CreateGenerator`; 73 `UIntSwitchImm` + 100 `StringSwitchImm`; two independent dynamic-`eval` patterns (Metro split-bundle `fetchThenEvalAsync`, `react-native-worklets`' value-unpacker fallback chain) |

**Bundling gotcha (Expensify only):** a stock one-shot `react-native bundle`
CLI invocation hit `Failed to get the SHA-1 for: .../react-native-worklets/.worklets/<id>.js`
deterministically (2/2 tries) — `react-native-worklets`' Metro "bundle mode"
integration writes per-worklet extraction files to
`node_modules/react-native-worklets/.worklets/` *during* the transform pass,
and without a real filesystem watcher (no `watchman` installed) Metro's
one-shot crawl doesn't reliably see a file created mid-build. Installing
`watchman` and passing `--max-workers 1` (to remove any remaining
cross-worker-process race on the same shared directory) made it reproducible
every time. Not needed for react-navigation's Expo-based build, which never
touches this codepath.

**Both apps landed on HBC bytecode version 98** (`react-native` 0.85.3 and
0.86.0 both pin a `250829098.0.x`-line `hermes-compiler`), one version newer
than the `v99`("1000.x") line `tools/get-hermesc.sh` already had a table
entry for — `tools/get-hermesc.sh 98` was added (same tarball-layout pattern
as the existing `99` entry: `hermes-compiler@250829098.0.10`,
`package/hermesc/OSDIR_TOKEN`), so both real-world apps in this pair share
one compiler build with each other, letting their header/opcode stats
(function counts, jump-table counts, etc.) be compared apples-to-apples
above.

Both bundles independently confirm `docs/TEST-CORPUS.md`'s Tier 1 finding
that real Metro output does produce `StringSwitchImm` jump tables (not just
`UIntSwitchImm`), and that `CreateGenerator` remains a real opcode at HBC 98
rather than being lowered to a compiler state machine (contrast with D9's
"v97+ generators/async get a runtime shim first" framing — worth revisiting
against these two real bundles when generator recovery work starts, since
neither app hit the D9 scenario). `HasAsync: 0` in both headers despite both
apps making heavy use of `async`/`await` in their source is unresolved and
flagged in each `BUILD.md` for follow-up.

## Tier 2 hardened variant (C4) and local proprietary corpus (C5)

Per `docs/DECISIONS.md` D16's corpus taxonomy:

- **C4** (`bundles/<app>-<rn>/hardened/`): the same MIT-licensed bundle run
  through `javascript-obfuscator@5.6.0` (BSD-2-Clause, invoked via `npx`,
  pinned version, not a repo dependency) with control-flow flattening,
  `stringArray` with `rc4` encoding, and (in the originally-specified
  config) dead-code injection, `selfDefending` off, then recompiled with the
  same `hermesc -O`. See `bundles/react-navigation-example-0.85.3/hardened/BUILD.md`
  for the exact CLI invocations and outcomes. **The originally-specified
  config (flattening threshold 0.75 + dead-code injection) does not finish
  compiling** — killed after 6m35s of CPU time on the 16.9 MB obfuscated
  output (5x expansion from the 3.36 MB original, which itself compiles in
  2.6s), still actively emitting warnings when killed, not hung. Root cause:
  ~9,400 "undeclared variable" warnings, each re-printing hermesc's entire
  (huge, single-line, control-flow-flattened) source line as caret-diagnostic
  context — a real diagnostic-printer scalability cliff, not necessarily a
  compilation-itself problem. A reduced config (flattening threshold 0.1, no
  dead-code injection) obfuscates and compiles in ~13s total (3.36→7.61 MB
  JS, 7.17 MB `.hbc`) with only 38 warnings, confirming the slowdown tracks
  warning volume/line size rather than obfuscated-bytecode compilation being
  inherently slow. This is directly relevant to D3: a pipeline that shells
  out to `hermesc` for round-trip verification of obfuscated targets should
  suppress/redirect warnings or budget for pathological cases. The same
  light config was also tried on the much larger Expensify bundle
  (`bundles/expensify-app-0.86.0/hardened/BUILD.md`): the obfuscator itself
  OOM'd at default Node heap limits on the 38.6 MB input and needed
  `NODE_OPTIONS="--max-old-space-size=8192"` to succeed (2m31s, 80.6 MB
  output), after which `hermesc -O` compiled it in 44s with only 37
  warnings — confirming again that it's the heavy config's flattening+dead-code
  combination that's pathological, not bundle size or obfuscation per se.
- **C5** (`tests/fixtures/local-corpus/`): `tools/extract-apk-bundle.sh`
  extracts a bundle from a local APK's `assets/` (Hermes-bytecode or plain
  JS, auto-detected by magic number) into a gitignored per-hash directory
  and appends a hash/metadata-only record to the tracked `MANIFEST.json` —
  never the bundle content itself. See `tests/fixtures/local-corpus/README.md`
  for the rules (only APKs legitimately obtained; nothing here is fetched or
  targeted by this project). Verified against three synthetic APKs built
  from this project's own already-MIT-licensed fixture bundles (Hermes
  bytecode, plain JS, and an Expo-style hashed `.hbc` filename), plus a
  fourth with no bundle present to confirm the error path — not against any
  real third-party app.
