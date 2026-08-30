# tests/fixtures/OBFUSCATION.md — D13 hardened-tier variants

Per `docs/DECISIONS.md` D13 (hardened tier) and D16 (category C2: construct
variants, C4: hardened real-bundle variants), every `constructs/<name>/source.js`
gets two extra sibling sources — `source.obf.js` (obfuscated,
control-flow-flattened) and `source.min.js` (minified only) — compiled to
`vNN.obf.hbc`/`vNN.min.hbc` alongside the existing `vNN.hbc`. The minified
variant is a **control**: Hermes already erases names/whitespace on
compilation, so `vNN.min.hbc` should be structurally indistinguishable from
`vNN.hbc`. The obfuscated variant is the actual hardened-tier stressor: control
flow flattening and encoded string arrays change the *bytecode's CFG shape*,
which minification never does.

## Pinned tool versions

- `javascript-obfuscator@5.6.0` (latest as of 2026-08-30, released 2026-08-23)
- `terser@5.51.2` (latest as of 2026-08-30, released 2026-08-27)

Neither is a repo dependency — no `package.json` exists at the repo root and
none was added. Both `build.sh --variants` and this document's regeneration
commands fetch them on demand via `npx --yes -p <pkg>@<version> <bin>`, which
uses npx's own cache outside the repo tree.

## Exact obfuscator config

Committed at `tests/fixtures/obfuscator.config.json`, passed to the CLI via
`--config`:

```json
{
  "controlFlowFlattening": true,
  "controlFlowFlatteningThreshold": 1,
  "stringArray": true,
  "stringArrayRotate": true,
  "stringArrayShuffle": true,
  "stringArrayEncoding": ["rc4"],
  "deadCodeInjection": true,
  "numbersToExpressions": true,
  "splitStrings": true,
  "selfDefending": false,
  "compact": false
}
```

All options not listed keep `javascript-obfuscator`'s own defaults (e.g.
`stringArrayThreshold: 0.8`, `identifierNamesGenerator: hexadecimal`).
`controlFlowFlatteningThreshold: 1` means *every* eligible function gets
flattened (no probabilistic skipping) — deliberately maximal, since this is a
CFG-shape stress fixture, not a realistic obfuscation-preset simulation.

Terser variants use `terser -c -m` (compress + mangle), no extra options —
equivalent to `{ compress: true, mangle: true }` via the JS API.

Note: `javascript-obfuscator` does not accept (or need) a `--seed` in this
config, so **re-running generation produces different string-array
shuffles/RC4 keys/dead-code shapes every time** — regenerated `source.obf.js`
files will not be byte-identical to a previous run, only behaviourally
identical (verified against `expected.txt` each time). This is expected and
harmless: nothing downstream depends on obfuscated-source byte stability, only
on the compiled variant passing the equivalence check.

## Which constructs broke

Both variants are generated then immediately verified: run under Node with
the standard `print` shim (see `README.md`), stdout diffed byte-for-byte
against that construct's `expected.txt`. A throw or any divergence deletes
the just-generated variant file and the construct is skipped for that variant
— it does not get a `vNN.obf.hbc`/`vNN.min.hbc` either, since there is no
`source.obf.js`/`source.min.js` to compile.

**Result: 52/53 constructs obfuscate cleanly; 53/53 minify cleanly.**

| # | Fixture | obf | min | Why obf broke |
|---|---|---|---|---|
| 35 | class-private-fields | **BROKEN** | OK | `javascript-obfuscator`'s member-expression transform (part of the string-array/computed-key rewriting used together with `splitStrings`/`stringArray`) rewrites `this.#balance` into a computed member access `obj[stringArrayCall(...)](#balance, ...)`-shaped call that is not valid syntax for a private field access — `#balance` cannot appear as a bracket-notation property key or as a bare call argument the way the rewrite emits it. Result: `SyntaxError: Unexpected identifier '#balance'` at the Node syntax-check stage, before the equivalence check even runs. This is a genuine `javascript-obfuscator` limitation with ES2022 private class fields/methods, not a bug in the fixture — `source.js` itself compiles and runs correctly (see its own `versions.txt`, which separately documents that only v98/v99 hermesc support private fields at all). |

All other 51 constructs with an obfuscatable `source.js` (52 total minus 35)
produced a `source.obf.js` that both parses under Node and reproduces
`expected.txt` exactly, on every generation run tried. `30-async-generator`
obfuscates and minifies fine (both variants exist and are equivalence-checked
against Node), but — like its plain `source.js` — has **no** `vNN.obf.hbc`/
`vNN.min.hbc` at all, because no fetched hermesc version (84/94/98/99) can
compile *any* form of that construct (`for await...of`/`async function*` are
unsupported at every version; see its `versions.txt`). This is not a new
obfuscation-specific gap, just the pre-existing compile gap propagating to
the variants.

## Counts produced

- `source.obf.js`: 52/53
- `source.min.js`: 53/53
- `vNN.obf.hbc`: 194 (across the 84/94/98/99 versions each fixture's
  `versions.txt` already permits — same per-fixture version support matrix
  as the base `vNN.hbc`, since obfuscation/minification don't change which
  JS features a construct uses beyond what broke in the row above)
- `vNN.min.hbc`: 196

All 194+196 = 390 compiles that were attempted (i.e., not excused by an
existing `versions.txt: FAILS` line) succeeded — **zero unexpected compile
failures**, meaning obfuscation/minification never broke hermesc compilation
independently of the one Node-level break above.

## Control check: structural diff, `vNN.min.hbc` vs `vNN.hbc`, and vs `vNN.obf.hbc`

Method: `hbc-disassembler` (hermes-dec, AGPL — behaviour oracle only, per
`CLAUDE.md`) on all three of a fixture's v94 binaries. Mnemonic sequence
(opcode names only, stripped of registers/immediates/string ids/addresses)
compared between `vNN.hbc` and `vNN.min.hbc`; basic-block count (computed
from jump-target addresses, independent of the mnemonic-sequence check);
`SwitchImm` occurrence count; and `hbc-file-parser`'s `StringCount` header
field for the string-table-size comparison. Five fixtures picked to cover a
spread of shapes: a branch-heavy one, a plain loop, two switch styles
(compare-chain and jump-table), and a closures-with-nested-functions one.

| Fixture | orig instrs | min instrs | obf instrs | orig blocks | min blocks | obf blocks | orig StringCount | min StringCount | obf StringCount |
|---|---|---|---|---|---|---|---|---|---|
| 01-if-else-chain | 69 | 69 | 589 | 16 | 16 | 70 | 15 | 15 | 128 |
| 04-for-loop-basic | 51 | 51 | 378 | 9 | 9 | 43 | 10 | 10 | 63 |
| 09-switch-fallthrough | 56 | 56 | 434 | 17 | 17 | 51 | 12 | 12 | 81 |
| 52-switch-jumptable | 84 | 84 | 567 | 20 | 20 | 67 | 20 | 20 | 121 |
| 22-nested-closures-counters | 84 | 84 | 615 | 7 | 7 | 54 | 14 | 11 | 118 |

**Minified vs original: basic-block count matches exactly on all 5/5** (names
are erased by Hermes regardless of minification, as expected), and the
mnemonic sequence matches **exactly** on 4/5 (04, 09, 52, 22). The exception,
**01-if-else-chain**, has the *same instruction count* (69) but a genuinely
reordered mnemonic sequence from instruction 42 on (confirmed by diffing
side-by-side) — terser's `compress` pass (not `mangle`) restructured the
`if`/`else`-with-early-`return` chain (e.g. flipping a `JLess`/`JNotLess`
comparison direction and reordering a `Call2`), which is a real,
semantics-preserving source-level rewrite terser performs beyond pure
renaming. Output still matches `expected.txt` exactly (verified at generation
time), so this is `terser`'s `compress` doing more than name-erasure would
alone predict — a useful caveat on the "minification is purely a name-erasure
control" framing: it holds for `mangle`, only mostly for `compress`.
`22-nested-closures-counters`'s `StringCount` also differs slightly (14 vs
11) — terser deduplicated/const-folded a few string literals that Hermes's
own compiler otherwise keeps distinct; another minor way `compress` (not just
Hermes) affects the string table.

**Obfuscated vs original: differs dramatically on every metric, every
fixture** — 5.4x-8.8x more instructions, 3.6x-7.7x more basic blocks, and
6.4x-8.9x more string-table entries (the RC4-encoded string array plus its
decoder function and the control-flow-flattening dispatcher's own string
keys). This is exactly the D13 rationale: obfuscation changes CFG shape in a
way minification never does, giving the hardened tier real stress on
CFG/structurer code that the base and minified tiers cannot exercise.

**`52-switch-jumptable`'s `SwitchImm` count: a notable finding.** `orig` and
`min` both contain exactly 1 `SwitchImm` instruction (the 13-case dense
integer switch, unchanged — terser's compress didn't touch it here). **`obf`
contains 0** — control-flow flattening rewrites the function into its own
dispatcher `switch` over a *shuffled, non-contiguous* set of state-id values
(by construction, `stringArrayShuffle`-style randomization applies to CFF's
state ids too), which fails Hermes's own density heuristic for emitting a
jump table (per `README.md`'s "Switch jump tables" section: a single sparse
outlier already kills a whole switch's jump table). So control-flow
flattening doesn't just add a layer of compare-chain dispatch *around* the
original jump table — **it defeats Hermes's jump-table codegen entirely for
the flattened function**, falling back to a `JStrictEqual` compare chain over
the shuffled dispatcher states. This is a meaningful decompiler-relevant
finding: a hardened-tier `SwitchImm` fixture instance will not actually
exercise the jump-table opcode by the time it's compiled — the flattening
consumes it.

## How to regenerate

```sh
tests/fixtures/build.sh --variants          # regenerate all constructs/ variants (idempotent)
tests/fixtures/build.sh --variants --force  # force-regenerate even if up to date
```

This only touches `constructs/<name>/{source.obf.js,source.min.js,vNN.obf.hbc,vNN.min.hbc}`.
It does not touch the base `vNN.hbc` build (unaffected by `--variants`) or
`bundles/rn-template-0.72/hardened/` (see that directory's own
`CONFIG.md` — the real-bundle hardened variant is regenerated by a separate,
manually-run command documented there, since it is a single large one-off
artifact gated on a 3 MB size cap rather than a per-fixture idempotent loop).

Manual equivalent for one construct (what `build.sh --variants` does under
the hood, useful for debugging a single fixture without the full corpus loop):

```sh
cd tests/fixtures/constructs/<name>
npx --yes -p javascript-obfuscator@5.6.0 javascript-obfuscator source.js \
  --output source.obf.js --config ../../obfuscator.config.json
npx --yes -p terser@5.51.2 terser -c -m -o source.min.js source.js

# verify (repo's print shim convention, see README.md):
node -e '
  globalThis.print ??= (...a)=>console.log(...a);
  require("./source.obf.js");
' | diff - expected.txt

for v in 84 94 98 99; do
  /path/to/tools/hermesc/v$v/hermesc -emit-binary -out=v$v.obf.hbc source.obf.js
  /path/to/tools/hermesc/v$v/hermesc -emit-binary -out=v$v.min.hbc source.min.js
done
```

If a future `javascript-obfuscator`/`terser` release changes behaviour enough
that 35-class-private-fields starts obfuscating cleanly (or a currently-clean
construct starts breaking), rerun `build.sh --variants --force` and update
the table above — the script itself only reports pass/fail per construct, it
does not edit this file automatically.
